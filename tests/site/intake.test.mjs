import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { getExpressionReceipt, submitConfirmedExpression, validateExpressionCommand } from '../../sites/family-therapist/src/server/intake.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '../../sites/family-therapist');
const space = 'family-space';
const ids = {
  actor: '00000000-0000-4000-8000-000000000001',
  other: '00000000-0000-4000-8000-000000000002',
  outsider: '00000000-0000-4000-8000-000000000003',
  thread: '00000000-0000-4000-8000-000000000010',
  otherThread: '00000000-0000-4000-8000-000000000011',
  anchor: '00000000-0000-4000-8000-000000000020',
  message: '00000000-0000-4000-8000-000000000101',
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
  await db.prepare('INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)').bind(space, ids.actor, 'member').run();
  await db.prepare('INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)').bind(space, ids.other, 'member').run();
  await db.prepare('INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)')
    .bind(ids.anchor, space, ids.thread, 'thread_created', ids.actor, '{"title":"Current"}', '2026-10-08T00:00:00Z').run();
  const anchor = await db.prepare('SELECT seq FROM messages WHERE message_id=?').bind(ids.anchor).first();
  await db.prepare('INSERT INTO thread_versions(space_id,thread_id,message_seq,title,status,summary) VALUES(?,?,?,?,?,?)')
    .bind(space, ids.thread, anchor.seq, 'Current', 'active', '').run();
  return db;
}

function command(overrides = {}) {
  return { message_id: ids.message, thread_id: ids.thread, expected_thread_seq: 1, text: '  First paragraph.\n\nSecond paragraph.  ', confirmed: true, ...overrides };
}
function scope(overrides = {}) { return { actor_id: ids.actor, space_id: space, ...overrides }; }

test('confirmed exact-text intake writes one formal message and one durable queued task', async () => {
  const db = await migratedDb();
  try {
    const receipt = await submitConfirmedExpression({ db, scope: scope(), command: command(), now: () => '2026-10-08T12:00:00Z' });
    assert.deepEqual(receipt, { message_id: ids.message, thread_id: ids.thread, seq: receipt.seq, created_at: '2026-10-08T12:00:00Z', text: command().text, task_status: 'queued', duplicate: false });
    const message = await db.prepare('SELECT * FROM messages WHERE message_id=?').bind(ids.message).first();
    const task = await db.prepare('SELECT * FROM therapist_tasks WHERE message_id=?').bind(ids.message).first();
    assert.deepEqual(JSON.parse(message.body_json), { text: command().text });
    assert.equal(message.actor_id, ids.actor);
    assert.equal(message.thread_id, ids.thread);
    assert.equal(task.message_seq, message.seq);
    assert.equal(task.status, 'queued');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='member_expression'").first()).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM therapist_tasks').first()).n, 1);
  } finally { db.close(); }
});

test('identical UUID retry returns the immutable original receipt once the thread is settled', async () => {
  const db = await migratedDb();
  try {
    const first = await submitConfirmedExpression({ db, scope: scope(), command: command(), now: () => '2026-10-08T12:00:00Z' });
    await db.prepare('UPDATE thread_versions SET status=? WHERE space_id=? AND thread_id=?').bind('settled', space, ids.thread).run();
    const retry = await submitConfirmedExpression({ db, scope: scope(), command: command(), now: () => '2026-10-08T13:00:00Z' });
    assert.deepEqual({ ...retry, duplicate: false }, first);
    assert.equal(retry.duplicate, true);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM messages').first()).n, 2);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM therapist_tasks').first()).n, 1);
  } finally { db.close(); }
});

test('same UUID with changed text, actor, thread or space conflicts without disclosing foreign text', async () => {
  const db = await migratedDb();
  try {
    await submitConfirmedExpression({ db, scope: scope(), command: command() });
    await assert.rejects(submitConfirmedExpression({ db, scope: scope(), command: command({ text: 'different' }) }), { code: 'message_conflict' });
    await assert.rejects(submitConfirmedExpression({ db, scope: scope({ actor_id: ids.other }), command: command() }), { code: 'message_conflict' });
    await assert.rejects(submitConfirmedExpression({ db, scope: scope(), command: command({ thread_id: ids.otherThread }) }), { code: 'message_conflict' });
    await assert.rejects(submitConfirmedExpression({ db, scope: scope({ space_id: 'other-space' }), command: command() }), { code: 'membership_required' });
    const foreign = await getExpressionReceipt({ db, scope: scope({ actor_id: ids.other }), messageId: ids.message });
    assert.equal(foreign, null);
    assert.doesNotMatch(JSON.stringify(foreign), /First paragraph/);
  } finally { db.close(); }
});

test('input validation requires literal confirmation, strict plain-object fields and exact text', () => {
  const exact = command();
  assert.deepEqual(validateExpressionCommand(exact), exact);
  for (const invalid of [
    { ...exact, confirmed: false }, { ...exact, actor_id: ids.actor }, { ...exact, space_id: space },
    { ...exact, ignored: true }, Object.assign(Object.create({ actor_id: ids.actor }), exact),
    { ...exact, text: ' \n ' }, { ...exact, expected_thread_seq: 0 },
  ]) assert.throws(() => validateExpressionCommand(invalid));
  assert.equal(validateExpressionCommand(exact).text, exact.text);
});

test('outsider, pending, settled, foreign and stale-version writes do not persist either row', async () => {
  const db = await migratedDb();
  try {
    const rejectAndCount = async (scopeArg, commandArg) => {
      await assert.rejects(submitConfirmedExpression({ db, scope: scopeArg, command: commandArg }));
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='member_expression'").first()).n, 0);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM therapist_tasks').first()).n, 0);
    };
    await rejectAndCount(scope({ actor_id: ids.outsider }), command());
    await rejectAndCount(scope(), command({ thread_id: ids.otherThread, message_id: '00000000-0000-4000-8000-000000000102' }));
    await db.prepare('UPDATE thread_versions SET status=? WHERE space_id=? AND thread_id=?').bind('pending', space, ids.thread).run();
    await rejectAndCount(scope(), command({ message_id: '00000000-0000-4000-8000-000000000103' }));
    await db.prepare('UPDATE thread_versions SET status=? WHERE space_id=? AND thread_id=?').bind('settled', space, ids.thread).run();
    await rejectAndCount(scope(), command({ message_id: '00000000-0000-4000-8000-000000000104' }));
    await db.prepare('UPDATE thread_versions SET status=? WHERE space_id=? AND thread_id=?').bind('active', space, ids.thread).run();
    await db.prepare('INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind('00000000-0000-4000-8000-000000000030', space, ids.thread, 'thread_update', ids.actor, '{}', 'later').run();
    const latest = await db.prepare('SELECT MAX(seq) AS seq FROM messages').first();
    await db.prepare('INSERT INTO thread_versions(space_id,thread_id,message_seq,title,status,summary) VALUES(?,?,?,?,?,?)')
      .bind(space, ids.thread, latest.seq, 'Updated', 'active', '').run();
    await rejectAndCount(scope(), command({ message_id: '00000000-0000-4000-8000-000000000105', expected_thread_seq: 1 }));
  } finally { db.close(); }
});

test('membership revocation and thread state changes after preflight are rechecked inside the batch', async () => {
  for (const mutation of [
    (db) => db.prepare('DELETE FROM members WHERE space_id=? AND user_id=?').bind(space, ids.actor).run(),
    (db) => db.prepare('UPDATE thread_versions SET status=?').bind('settled').run(),
  ]) {
    const db = await migratedDb();
    try {
      let changed = false;
      db.batchHook = async ({ phase, index }) => {
        if (phase === 'before' && index === 0 && !changed) { changed = true; await mutation(db); }
      };
      await assert.rejects(submitConfirmedExpression({ db, scope: scope(), command: command() }));
      assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='member_expression'").first()).n, 0);
      assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM therapist_tasks').first()).n, 0);
    } finally { db.close(); }
  }
});

test('a batch failure after the message insert rolls back the message and queued task', async () => {
  const db = await migratedDb();
  try {
    db.batchHook = async ({ phase, index }) => { if (phase === 'after' && index === 0) throw new Error('simulated second-statement failure'); };
    await assert.rejects(submitConfirmedExpression({ db, scope: scope(), command: command() }), /batch|persist|intake/i);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='member_expression'").first()).n, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM therapist_tasks').first()).n, 0);
  } finally { db.close(); }
});

test('concurrent identical submissions create one formal message and one task; conflicting payload wins once', async () => {
  const db = await migratedDb();
  try {
    const identical = await Promise.all([
      submitConfirmedExpression({ db, scope: scope(), command: command() }),
      submitConfirmedExpression({ db, scope: scope(), command: command() }),
    ]);
    assert.equal(identical.filter((item) => item.duplicate).length, 1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='member_expression'").first()).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM therapist_tasks').first()).n, 1);

    const conflictDb = await migratedDb();
    try {
      const contenders = await Promise.allSettled([
        submitConfirmedExpression({ db: conflictDb, scope: scope(), command: command() }),
        submitConfirmedExpression({ db: conflictDb, scope: scope(), command: command({ text: 'Changed contender' }) }),
      ]);
      assert.equal(contenders.filter((item) => item.status === 'fulfilled').length, 1);
      assert.equal(contenders.filter((item) => item.status === 'rejected' && item.reason.code === 'message_conflict').length, 1);
      assert.equal((await conflictDb.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='member_expression'").first()).n, 1);
      assert.equal((await conflictDb.prepare('SELECT COUNT(*) AS n FROM therapist_tasks').first()).n, 1);
    } finally { conflictDb.close(); }
  } finally { db.close(); }
});
