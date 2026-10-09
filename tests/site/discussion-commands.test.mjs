import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { applyDiscussion, initialDiscussion } from '../../packages/protocol/discussion.mjs';
import { executeDiscussionCommand, getCurrentDiscussion, getDiscussionReceipt } from '../../sites/family-therapist/src/server/discussion-commands.mjs';
import { createQueryExecutor } from '../../sites/family-therapist/src/server/queries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const project = join(here, '../..');
const site = join(project, 'sites/family-therapist');
const space = 'family-space';
const members = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
const outsider = '00000000-0000-4000-8000-000000000003';
const ids = {
  thread1: '00000000-0000-4000-8000-000000000101',
  thread2: '00000000-0000-4000-8000-000000000102',
  thread3: '00000000-0000-4000-8000-000000000103',
  proposal1: '00000000-0000-4000-8000-000000000201',
};

class SqliteStatement {
  constructor(sqlite, sql, values = []) { this.sqlite = sqlite; this.sql = sql; this.values = values; }
  bind(...values) { return new SqliteStatement(this.sqlite, this.sql, values); }
  async all() { return { results: this.sqlite.prepare(this.sql).all(...this.values) }; }
  async first() { return this.sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async run() {
    const result = this.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class SqliteD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.batchHook = null; this.batchQueue = Promise.resolve(); }
  prepare(sql) { return new SqliteStatement(this.sqlite, sql); }
  async batch(statements) {
    const operation = this.batchQueue.then(async () => {
      this.sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (let index = 0; index < statements.length; index += 1) {
          const statement = statements[index];
          if (this.batchHook) await this.batchHook({ phase: 'before', index, statement });
          const result = await statement.run();
          results.push(result);
          if (this.batchHook) await this.batchHook({ phase: 'after', index, statement, result });
        }
        this.sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        this.sqlite.exec('ROLLBACK');
        throw error;
      }
    });
    this.batchQueue = operation.catch(() => {});
    return operation;
  }
  close() { this.sqlite.close(); }
}

async function migratedDb() {
  const db = new SqliteD1();
  db.sqlite.exec('PRAGMA foreign_keys = ON');
  const migrationFiles = (await readdir(join(site, 'drizzle'))).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const name of migrationFiles) {
    const migration = await readFile(join(site, 'drizzle', name), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) db.sqlite.exec(statement);
  }
  for (const userId of members) await db.prepare('INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)').bind(space, userId, 'member').run();
  return db;
}

function scope(actor = members[0]) { return { actor_id: actor, space_id: space }; }
function uuid(value) { return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`; }
function cmd(messageId, action, fields = {}) { return { message_id: messageId, confirmed: true, action, ...fields }; }
function createAction(id, title = 'Weekend planning') { return { type: 'create', id, title }; }
function proposalAction(id, threadId, kind, text = '  exact agreement\n\nwith spacing  ', targetId = null) {
  return { type: 'propose', id, kind, thread_id: threadId, target_id: targetId, text };
}
function approvalAction(id, text = '  exact agreement\n\nwith spacing  ') { return { type: 'approve', id, text }; }
async function send(db, actor, messageId, action, fields) {
  return executeDiscussionCommand({ db, scope: scope(actor), command: cmd(messageId, action, fields), now: () => '2026-10-08T14:00:00.000Z' });
}
async function count(db, sql, ...values) { return (await db.prepare(sql).bind(...values).first()).n; }

test('first thread is active and second pending; events and immutable versions share the committed command sequence', async () => {
  const db = await migratedDb();
  try {
    const initial = await getCurrentDiscussion({ db, scope: scope() });
    assert.equal(initial.storage_revision, 0);
    assert.deepEqual(initial.state, initialDiscussion(members));
    const first = await send(db, members[0], uuid(1), createAction(ids.thread1));
    const second = await send(db, members[1], uuid(2), createAction(ids.thread2, 'Another topic'));
    const current = await getCurrentDiscussion({ db, scope: scope() });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, false);
    assert.equal(current.storage_revision, 2);
    assert.equal(current.state.threads[ids.thread1].status, 'active');
    assert.equal(current.state.threads[ids.thread2].status, 'pending');
    const versions = await db.prepare('SELECT thread_id, message_seq, title, status, summary FROM thread_versions ORDER BY message_seq').all();
    assert.deepEqual(versions.results.map((row) => [row.thread_id, row.title, row.status, row.summary]), [
      [ids.thread1, 'Weekend planning', 'active', ''],
      [ids.thread2, 'Another topic', 'pending', ''],
    ]);
    assert.deepEqual(versions.results.map((row) => row.message_seq), [first.seq, second.seq]);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM messages WHERE kind='discussion_command'"), 2);
  } finally { db.close(); }
});

test('proposals do not count as approvals; repeated one-party approval, exact text, bilateral consensus and settle rules persist', async () => {
  const db = await migratedDb();
  try {
    await send(db, members[0], uuid(10), createAction(ids.thread1));
    const proposalText = '  exact agreement\n\nwith spacing  ';
    await send(db, members[1], uuid(11), proposalAction(ids.proposal1, ids.thread1, 'consensus', proposalText));
    let current = await getCurrentDiscussion({ db, scope: scope() });
    assert.deepEqual(current.state.proposals[ids.proposal1].approvals, []);

    await assert.rejects(send(db, members[0], uuid(12), approvalAction(ids.proposal1, proposalText.trim())), { code: 'approval_text_mismatch' });
    const first = await send(db, members[0], uuid(13), approvalAction(ids.proposal1, proposalText));
    const repeat = await send(db, members[0], uuid(14), approvalAction(ids.proposal1, proposalText));
    current = await getCurrentDiscussion({ db, scope: scope() });
    assert.deepEqual(current.state.proposals[ids.proposal1].approvals, [members[0]]);
    assert.equal(current.state.threads[ids.thread1].status, 'active');
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM agreement_versions'), 0);
    assert.equal(first.duplicate, false);
    assert.equal(repeat.duplicate, false);

    await send(db, members[1], uuid(15), approvalAction(ids.proposal1, proposalText));
    current = await getCurrentDiscussion({ db, scope: scope() });
    assert.equal(current.state.threads[ids.thread1].status, 'active');
    assert.equal(current.state.threads[ids.thread1].summary, '');
    assert.deepEqual(current.state.agreements, [{ proposal_id: ids.proposal1, thread_id: ids.thread1, text: proposalText }]);
    const agreement = await db.prepare('SELECT agreement_id, thread_id, version, text, confirmed FROM agreement_versions').first();
    assert.deepEqual({ ...agreement }, { agreement_id: ids.proposal1, thread_id: ids.thread1, version: 1, text: proposalText, confirmed: 1 });
  } finally { db.close(); }
});

test('confirmed principle persists globally at thread_id null and stales older proposals', async () => {
  const db = await migratedDb();
  try {
    await send(db, members[0], uuid(160), createAction(ids.thread1));
    const oldId = uuid(161);
    const principleId = uuid(162);
    const oldText = 'Earlier principle wording';
    const principleText = 'We pause before responding.';
    await send(db, members[0], uuid(163), proposalAction(oldId, ids.thread1, 'principle', oldText));
    await send(db, members[1], uuid(164), proposalAction(principleId, ids.thread1, 'principle', principleText));
    await send(db, members[0], uuid(165), approvalAction(principleId, principleText));
    await send(db, members[1], uuid(166), approvalAction(principleId, principleText));
    const state = await getCurrentDiscussion({ db, scope: scope() });
    assert.equal(state.state.threads[ids.thread1].status, 'active');
    assert.equal(state.state.principle_revision, 1);
    assert.deepEqual(state.state.agreements, [{ proposal_id: principleId, thread_id: null, text: principleText }]);
    const agreement = await db.prepare('SELECT agreement_id, thread_id, text, confirmed FROM agreement_versions WHERE agreement_id=?').bind(principleId).first();
    assert.deepEqual({ ...agreement }, { agreement_id: principleId, thread_id: null, text: principleText, confirmed: 1 });
    const event = await db.prepare('SELECT seq FROM messages WHERE message_id=?').bind(uuid(166)).first();
    const visible = await createQueryExecutor(db)('get_agreements', { thread_id: ids.thread1, after_agreement_id: null, limit: 20 }, {
      actor_id: members[0], space_id: space, snapshot_seq: event.seq, purpose: 'member_view',
    });
    assert.equal(visible.items.some((item) => item.agreement_id === principleId && item.text === principleText && item.thread_id === null), true);
    await assert.rejects(send(db, members[0], uuid(167), approvalAction(oldId, oldText)), { code: 'stale_proposal' });
    const threadEvent = await db.prepare('SELECT seq FROM messages WHERE message_id=?').bind(uuid(166)).first();
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM thread_versions WHERE space_id=? AND thread_id=? AND message_seq=?', space, ids.thread1, threadEvent.seq), 1);
  } finally { db.close(); }
});

test('bilateral settle/reopen preserve historical versions and switch appends both status versions at one event', async () => {
  const db = await migratedDb();
  try {
    await send(db, members[0], uuid(20), createAction(ids.thread1, 'Original'));
    await send(db, members[1], uuid(21), createAction(ids.thread2, 'Second'));
    const conclusion = 'We have both agreed to this exact ending.';
    const settleId = uuid(220);
    await send(db, members[0], uuid(22), proposalAction(settleId, ids.thread1, 'settle', conclusion));
    await send(db, members[0], uuid(23), approvalAction(settleId, conclusion));
    let state = await getCurrentDiscussion({ db, scope: scope() });
    assert.equal(state.state.threads[ids.thread1].status, 'active');
    assert.equal(state.state.threads[ids.thread1].summary, '');
    await send(db, members[1], uuid(24), approvalAction(settleId, conclusion));
    state = await getCurrentDiscussion({ db, scope: scope() });
    assert.equal(state.state.threads[ids.thread1].status, 'settled');
    assert.equal(state.state.threads[ids.thread1].summary, conclusion);

    const reopenId = uuid(221);
    await send(db, members[1], uuid(25), proposalAction(reopenId, ids.thread1, 'reopen', 'The reason to revisit this topic.'));
    await send(db, members[0], uuid(26), approvalAction(reopenId, 'The reason to revisit this topic.'));
    await send(db, members[1], uuid(27), approvalAction(reopenId, 'The reason to revisit this topic.'));
    state = await getCurrentDiscussion({ db, scope: scope() });
    assert.equal(state.state.threads[ids.thread1].status, 'pending');
    assert.equal(state.state.threads[ids.thread1].summary, conclusion);
    assert.equal(state.state.agreements.length, 1);

    await send(db, members[0], uuid(28), createAction(ids.thread3, 'Third'));
    // With no active topic after settlement, the third create becomes active.
    const switchId = uuid(222);
    await send(db, members[0], uuid(29), proposalAction(switchId, ids.thread3, 'switch', 'Move to the second topic.', ids.thread2));
    await send(db, members[0], uuid(30), approvalAction(switchId, 'Move to the second topic.'));
    await send(db, members[1], uuid(31), approvalAction(switchId, 'Move to the second topic.'));
    state = await getCurrentDiscussion({ db, scope: scope() });
    assert.equal(state.state.threads[ids.thread2].status, 'active');
    assert.equal(state.state.threads[ids.thread3].status, 'pending');
    assert.equal(state.state.threads[ids.thread1].summary, conclusion);

    const switchEvent = await db.prepare('SELECT seq FROM messages WHERE message_id=?').bind(uuid(31)).first();
    const switchVersions = await db.prepare('SELECT thread_id, status, message_seq FROM thread_versions WHERE message_seq=? ORDER BY thread_id').bind(switchEvent.seq).all();
    assert.deepEqual(switchVersions.results.map((row) => ({ ...row })), [
      { thread_id: ids.thread2, status: 'active', message_seq: switchEvent.seq },
      { thread_id: ids.thread3, status: 'pending', message_seq: switchEvent.seq },
    ]);
    const oldVersions = await db.prepare('SELECT status, summary FROM thread_versions WHERE space_id=? AND thread_id=? ORDER BY message_seq').bind(space, ids.thread1).all();
    assert.deepEqual(oldVersions.results.map((row) => ({ ...row })), [
      { status: 'active', summary: '' },
      { status: 'settled', summary: conclusion },
      { status: 'pending', summary: conclusion },
    ]);
  } finally { db.close(); }
});

test('UUID retry returns original receipt after later state changes; same UUID with changed action or actor conflicts without text disclosure', async () => {
  const db = await migratedDb();
  try {
    const request = cmd(uuid(40), createAction(ids.thread1));
    const first = await executeDiscussionCommand({ db, scope: scope(members[0]), command: request, now: () => '2026-10-08T14:00:00.000Z' });
    await send(db, members[1], uuid(41), createAction(ids.thread2));
    const retry = await executeDiscussionCommand({ db, scope: scope(members[0]), command: request, now: () => '2026-10-08T15:00:00.000Z' });
    assert.deepEqual({ ...retry, duplicate: false }, first);
    assert.equal(retry.duplicate, true);
    await assert.rejects(executeDiscussionCommand({ db, scope: scope(members[0]), command: cmd(uuid(40), createAction(ids.thread1, 'changed')) }), { code: 'command_conflict' });
    await assert.rejects(executeDiscussionCommand({ db, scope: scope(members[1]), command: request }), { code: 'command_conflict' });
    const foreignReceipt = await db.prepare('SELECT body_json FROM messages WHERE message_id=?').bind(uuid(40)).first();
    const hidden = await getCurrentDiscussion({ db, scope: scope() });
    assert.equal(hidden.state.threads[ids.thread1].title, 'Weekend planning');
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM messages WHERE message_id=?', uuid(40)), 1);
    assert.match(foreignReceipt.body_json, /Weekend planning/);
  } finally { db.close(); }
});

test('discussion receipts are member-bound and a foreign UUID is indistinguishable from a missing receipt', async () => {
  const db = await migratedDb();
  try {
    const messageId = uuid(45);
    const first = await send(db, members[0], messageId, createAction(ids.thread1));
    const owned = await getDiscussionReceipt({ db, scope: scope(members[0]), messageId });
    assert.equal(owned.message_id, messageId);
    assert.equal(owned.action.id, ids.thread1);
    assert.equal(owned.duplicate, false);
    assert.equal(await getDiscussionReceipt({ db, scope: scope(members[1]), messageId }), null);
    assert.equal(await getDiscussionReceipt({ db, scope: scope(members[0]), messageId: uuid(999) }), null);
    assert.equal(first.seq, owned.seq);
    await assert.rejects(getDiscussionReceipt({ db, scope: scope(members[0]), messageId: 'not-a-uuid' }), { code: 'invalid_command' });
  } finally { db.close(); }
});

test('outsiders and forged actor or space fields are refused before persistence', async () => {
  const db = await migratedDb();
  try {
    await assert.rejects(send(db, outsider, uuid(50), createAction(ids.thread1)), { code: 'membership_required' });
    await assert.rejects(executeDiscussionCommand({ db, scope: scope(), command: { ...cmd(uuid(51), createAction(ids.thread1)), actor_id: members[0] } }), { code: 'invalid_command' });
    await assert.rejects(executeDiscussionCommand({ db, scope: scope(), command: { ...cmd(uuid(52), createAction(ids.thread1)), space_id: space } }), { code: 'invalid_command' });
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM discussion_projection'), 0);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM messages WHERE kind='discussion_command'"), 0);
  } finally { db.close(); }
});

test('concurrent topic creates cannot produce two active threads; losing command can retry safely', async () => {
  const db = await migratedDb();
  try {
    const commands = [cmd(uuid(60), createAction(ids.thread1)), cmd(uuid(61), createAction(ids.thread2, 'Another topic'))];
    const results = await Promise.allSettled(commands.map((command, index) => executeDiscussionCommand({ db, scope: scope(members[index]), command })));
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(results.filter((item) => item.status === 'rejected' && item.reason.code === 'storage_conflict').length, 1);
    let state = await getCurrentDiscussion({ db, scope: scope() });
    assert.equal(Object.values(state.state.threads).filter((thread) => thread.status === 'active').length, 1);
    const loser = results.findIndex((item) => item.status === 'rejected');
    const retry = await executeDiscussionCommand({ db, scope: scope(members[loser]), command: commands[loser] });
    assert.equal(retry.duplicate, false);
    state = await getCurrentDiscussion({ db, scope: scope() });
    assert.equal(Object.values(state.state.threads).filter((thread) => thread.status === 'active').length, 1);
    assert.equal(Object.values(state.state.threads).filter((thread) => thread.status === 'pending').length, 1);
  } finally { db.close(); }
});

test('concurrent distinct approvals expose one CAS conflict and a same-UUID retry completes the bilateral command', async () => {
  const db = await migratedDb();
  try {
    await send(db, members[0], uuid(70), createAction(ids.thread1));
    const text = 'Both members approved this exact wording.';
    await send(db, members[1], uuid(71), proposalAction(ids.proposal1, ids.thread1, 'consensus', text));
    const approvals = [
      cmd(uuid(72), approvalAction(ids.proposal1, text)),
      cmd(uuid(73), approvalAction(ids.proposal1, text)),
    ];
    const results = await Promise.allSettled(approvals.map((command, index) => executeDiscussionCommand({ db, scope: scope(members[index]), command })));
    assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
    assert.equal(results.filter((item) => item.status === 'rejected' && item.reason.code === 'storage_conflict').length, 1);
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM messages WHERE message_id IN (?,?)', ...approvals.map((item) => item.message_id)), 1);
    const loser = results.findIndex((item) => item.status === 'rejected');
    await executeDiscussionCommand({ db, scope: scope(members[loser]), command: approvals[loser] });
    const state = await getCurrentDiscussion({ db, scope: scope() });
    assert.deepEqual(state.state.proposals[ids.proposal1].approvals, members);
    assert.equal(state.state.agreements.length, 1);
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM agreement_versions'), 1);
  } finally { db.close(); }
});

test('event and version statement failures roll back projection and every appended row', async () => {
  for (const failAfterIndex of [1, 2]) {
    const db = await migratedDb();
    try {
      db.batchHook = async ({ phase, index }) => {
        if (phase === 'after' && index === failAfterIndex) throw new Error('injected D1 batch failure');
      };
      await assert.rejects(send(db, members[0], uuid(80 + failAfterIndex), createAction(ids.thread1)), { code: 'storage_failed' });
      assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM discussion_projection'), 0);
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM messages WHERE kind='discussion_command'"), 0);
      assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM thread_versions'), 0);
    } finally { db.close(); }
  }
});

test('agreement version failure rolls back the final bilateral approval and its thread version', async () => {
  const db = await migratedDb();
  try {
    await send(db, members[0], uuid(84), createAction(ids.thread1));
    const proposalId = uuid(85);
    const text = 'Atomic agreement';
    await send(db, members[1], uuid(86), proposalAction(proposalId, ids.thread1, 'consensus', text));
    await send(db, members[0], uuid(87), approvalAction(proposalId, text));
    const before = await db.prepare('SELECT storage_revision,state_json,last_command_id FROM discussion_projection WHERE space_id=?').bind(space).first();
    const threadVersions = await count(db, 'SELECT COUNT(*) AS n FROM thread_versions');
    const events = await count(db, "SELECT COUNT(*) AS n FROM messages WHERE kind='discussion_command'");
    db.batchHook = async ({ phase, index }) => {
      if (phase === 'after' && index === 3) throw new Error('injected agreement insert failure');
    };
    await assert.rejects(send(db, members[1], uuid(88), approvalAction(proposalId, text)), { code: 'storage_failed' });
    const after = await db.prepare('SELECT storage_revision,state_json,last_command_id FROM discussion_projection WHERE space_id=?').bind(space).first();
    assert.deepEqual({ ...after }, { ...before });
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM thread_versions'), threadVersions);
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM agreement_versions'), 0);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM messages WHERE kind='discussion_command'"), events);
    assert.deepEqual((await getCurrentDiscussion({ db, scope: scope() })).state.proposals[proposalId].approvals, [members[0]]);
  } finally { db.close(); }
});

test('membership is rechecked in the initial projection insert and no command row survives revocation', async () => {
  const db = await migratedDb();
  try {
    let changed = false;
    db.batchHook = async ({ phase, index }) => {
      if (phase === 'before' && index === 0 && !changed) {
        changed = true;
        await db.prepare('DELETE FROM members WHERE space_id=? AND user_id=?').bind(space, members[1]).run();
      }
    };
    await assert.rejects(send(db, members[0], uuid(90), createAction(ids.thread1)), { code: 'membership_changed' });
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM discussion_projection'), 0);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM messages WHERE kind='discussion_command'"), 0);
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM thread_versions'), 0);
  } finally { db.close(); }
});

test('a UUID claimed after preflight blocks both first projection initialization and updates without moving the projection marker', async () => {
  for (const initialized of [false, true]) {
    const db = await migratedDb();
    try {
      if (initialized) await send(db, members[0], uuid(92), createAction(ids.thread1));
      const before = await db.prepare('SELECT storage_revision,state_json,last_command_id FROM discussion_projection WHERE space_id=?').bind(space).first();
      const conflictId = uuid(initialized ? 94 : 93);
      let inserted = false;
      db.batchHook = async ({ phase, index }) => {
        if (phase === 'before' && index === 0 && !inserted) {
          inserted = true;
          await db.prepare('INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)')
            .bind(conflictId, space, ids.thread1, 'member_expression', members[1], JSON.stringify({ text: 'private expression' }), '2026-10-08T00:00:00Z').run();
        }
      };
      await assert.rejects(send(db, members[0], conflictId, createAction(initialized ? ids.thread2 : ids.thread1)), { code: 'command_conflict' });
      const after = await db.prepare('SELECT storage_revision,state_json,last_command_id FROM discussion_projection WHERE space_id=?').bind(space).first();
      assert.deepEqual(after ? { ...after } : null, before ? { ...before } : null);
      assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM thread_versions'), initialized ? 1 : 0);
      assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM messages WHERE message_id=? AND kind=?', conflictId, 'member_expression'), 1);
    } finally { db.close(); }
  }
});

test('a missing projection cannot erase existing thread history; initial-history race is guarded by SQL', async () => {
  const db = await migratedDb();
  try {
    await db.prepare('INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(uuid(100), space, ids.thread1, 'legacy', members[0], '{}', '2026-10-08T00:00:00Z').run();
    const anchor = await db.prepare('SELECT seq FROM messages WHERE message_id=?').bind(uuid(100)).first();
    await db.prepare('INSERT INTO thread_versions(space_id,thread_id,message_seq,title,status,summary) VALUES(?,?,?,?,?,?)')
      .bind(space, ids.thread1, anchor.seq, 'Existing discussion', 'active', '').run();
    await assert.rejects(getCurrentDiscussion({ db, scope: scope() }), { code: 'projection_uninitialized' });
    await assert.rejects(send(db, members[0], uuid(101), createAction(ids.thread2)), { code: 'projection_uninitialized' });
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM discussion_projection'), 0);
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM messages WHERE kind='discussion_command'"), 0);
  } finally { db.close(); }

  const raced = await migratedDb();
  try {
    let inserted = false;
    raced.batchHook = async ({ phase, index }) => {
      if (phase === 'before' && index === 0 && !inserted) {
        inserted = true;
        await raced.prepare('INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)')
          .bind(uuid(102), space, ids.thread1, 'legacy', members[0], '{}', '2026-10-08T00:00:00Z').run();
        const event = await raced.prepare('SELECT seq FROM messages WHERE message_id=?').bind(uuid(102)).first();
        await raced.prepare('INSERT INTO thread_versions(space_id,thread_id,message_seq,title,status,summary) VALUES(?,?,?,?,?,?)')
          .bind(space, ids.thread1, event.seq, 'Concurrent legacy state', 'active', '').run();
      }
    };
    await assert.rejects(send(raced, members[0], uuid(103), createAction(ids.thread2)), { code: 'projection_uninitialized' });
    assert.equal(await count(raced, 'SELECT COUNT(*) AS n FROM discussion_projection'), 0);
    assert.equal(await count(raced, "SELECT COUNT(*) AS n FROM messages WHERE kind='discussion_command'"), 0);
  } finally { raced.close(); }
});

test('projection invariants reject multiple active threads, unilateral applied proposals, and misbound agreements', async () => {
  const corruptions = [
    (state) => { state.threads[ids.thread2] = { id: ids.thread2, title: 'Second', summary: '', status: 'active', semantic_revision: 1 }; },
    (state) => {
      state.proposals[ids.proposal1] = { id: ids.proposal1, kind: 'consensus', thread_id: ids.thread1, target_id: null, text: 'A text', thread_revision: 1, target_revision: null, principle_revision: 0, approvals: [members[0]], applied: true };
    },
    (state) => {
      state.proposals[ids.proposal1] = { id: ids.proposal1, kind: 'consensus', thread_id: ids.thread1, target_id: null, text: 'A text', thread_revision: 1, target_revision: null, principle_revision: 0, approvals: [...members], applied: true };
      state.agreements.push({ proposal_id: ids.proposal1, thread_id: null, text: 'A text' });
    },
  ];
  for (const corrupt of corruptions) {
    const db = await migratedDb();
    try {
      await send(db, members[0], uuid(170), createAction(ids.thread1));
      const row = await db.prepare('SELECT state_json FROM discussion_projection WHERE space_id=?').bind(space).first();
      const state = JSON.parse(row.state_json);
      corrupt(state);
      await db.prepare('UPDATE discussion_projection SET state_json=? WHERE space_id=?').bind(JSON.stringify(state), space).run();
      const events = await count(db, "SELECT COUNT(*) AS n FROM messages WHERE kind='discussion_command'");
      const versions = await count(db, 'SELECT COUNT(*) AS n FROM thread_versions');
      await assert.rejects(getCurrentDiscussion({ db, scope: scope() }), { code: 'projection_corrupt' });
      await assert.rejects(send(db, members[1], uuid(171), createAction(ids.thread3)), { code: 'projection_corrupt' });
      assert.equal(await count(db, "SELECT COUNT(*) AS n FROM messages WHERE kind='discussion_command'"), events);
      assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM thread_versions'), versions);
    } finally { db.close(); }
  }
});

test('oversized serialized projection returns an explicit limit error without dropping proposals or writing a partial event', async () => {
  const db = await migratedDb();
  try {
    await send(db, members[0], uuid(110), createAction(ids.thread1));
    let countAccepted = 1;
    let limitCommand;
    for (let index = 0; index < 30; index += 1) {
      const messageId = uuid(2000 + index);
      const actionId = uuid(4000 + index);
      const action = proposalAction(actionId, ids.thread1, 'consensus', `proposal ${index}: ${'x'.repeat(58 * 1024)}`);
      try {
        await send(db, members[index % members.length], messageId, action);
        countAccepted += 1;
      } catch (error) {
        limitCommand = messageId;
        assert.equal(error.code, 'projection_limit_exceeded');
        break;
      }
    }
    assert.ok(limitCommand, 'projection grew to its limit before the loop ended');
    assert.equal(await count(db, "SELECT COUNT(*) AS n FROM messages WHERE kind='discussion_command'"), countAccepted);
    assert.equal(await count(db, 'SELECT COUNT(*) AS n FROM messages WHERE message_id=?', limitCommand), 0);
    const row = await db.prepare('SELECT state_json FROM discussion_projection WHERE space_id=?').bind(space).first();
    assert.ok(new TextEncoder().encode(row.state_json).byteLength <= 1024 * 1024);
    const projection = JSON.parse(row.state_json);
    assert.equal(Object.keys(projection.proposals).length, countAccepted - 1);
  } finally { db.close(); }
});
