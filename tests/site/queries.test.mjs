import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createQueryExecutor } from '../../sites/family-therapist/src/server/queries.mjs';
import { validateToolArguments } from '../../packages/therapist/tools.mjs';

class D1Sqlite {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); }
  exec(sql) { this.sqlite.exec(sql); }
  run(sql, ...values) { this.sqlite.prepare(sql).run(...values); }
  prepare(sql) {
    return {
      bind: (...values) => ({
        all: async () => ({ results: this.sqlite.prepare(sql).all(...values) }),
        first: async () => this.sqlite.prepare(sql).get(...values) ?? null,
      }),
    };
  }
  close() { this.sqlite.close(); }
}

const ids = {
  actor: '00000000-0000-4000-8000-000000000001',
  otherActor: '00000000-0000-4000-8000-000000000002',
  consultation: '00000000-0000-4000-8000-000000000010',
  oldThread: '00000000-0000-4000-8000-000000000011',
  foreignThread: '00000000-0000-4000-8000-000000000012',
  message1: '00000000-0000-4000-8000-000000000101',
  message2: '00000000-0000-4000-8000-000000000102',
  message3: '00000000-0000-4000-8000-000000000103',
  message4: '00000000-0000-4000-8000-000000000104',
  message5: '00000000-0000-4000-8000-000000000105',
  message6: '00000000-0000-4000-8000-000000000106',
  agreement1: '00000000-0000-4000-8000-000000000201',
  agreement2: '00000000-0000-4000-8000-000000000202',
  agreement3: '00000000-0000-4000-8000-000000000203',
};
const space = 'family-space';

function setup() {
  const db = new D1Sqlite();
  db.exec(`
    CREATE TABLE members(space_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(space_id,user_id));
    CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT UNIQUE NOT NULL, space_id TEXT NOT NULL, thread_id TEXT, kind TEXT NOT NULL, actor_id TEXT NOT NULL, body_json TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE thread_versions(space_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_seq INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','active','settled')), summary TEXT NOT NULL);
    CREATE TABLE agreement_versions(space_id TEXT NOT NULL, agreement_id TEXT NOT NULL, thread_id TEXT, message_seq INTEGER NOT NULL, version INTEGER NOT NULL, text TEXT NOT NULL, confirmed INTEGER NOT NULL);
  `);
  db.run('INSERT INTO members VALUES (?, ?, ?)', space, ids.actor, 'member');
  const insertMessage = (messageId, threadId, body) => db.run('INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)', messageId, space, threadId, 'utterance', ids.actor, JSON.stringify(body), `2026-10-08T00:00:0${messageId.at(-1)}Z`);
  insertMessage(ids.message1, ids.consultation, { text: 'one' });
  insertMessage(ids.message2, ids.consultation, { text: 'two' });
  insertMessage(ids.message3, ids.oldThread, { text: 'closed history' });
  insertMessage(ids.message4, ids.foreignThread, { text: 'foreign thread' });
  insertMessage(ids.message5, ids.consultation, { text: 'settled conclusion' });
  const seq = (messageId) => db.sqlite.prepare('SELECT seq FROM messages WHERE message_id = ?').get(messageId).seq;
  const version = (threadId, messageId, title, status, summary) => db.run('INSERT INTO thread_versions VALUES(?,?,?,?,?,?)', space, threadId, seq(messageId), title, status, summary);
  version(ids.consultation, ids.message1, 'First title', 'active', 'First summary');
  version(ids.consultation, ids.message2, 'Updated title', 'active', 'Interim summary');
  version(ids.consultation, ids.message5, 'Final title', 'settled', 'Official conclusion');
  version(ids.oldThread, ids.message3, 'Old session', 'settled', 'Earlier conclusion');
  version(ids.foreignThread, ids.message4, 'Other space', 'active', 'Private');
  const agreement = (agreementId, threadId, messageId, v, text, confirmed) => db.run('INSERT INTO agreement_versions VALUES(?,?,?,?,?,?,?)', space, agreementId, threadId, seq(messageId), v, text, confirmed);
  agreement(ids.agreement1, ids.consultation, ids.message1, 1, 'Old agreement', 1);
  agreement(ids.agreement1, ids.consultation, ids.message2, 2, 'Current agreement', 1);
  agreement(ids.agreement2, null, ids.message1, 1, 'Global principle', 1);
  agreement(ids.agreement3, ids.consultation, ids.message2, 1, 'Unconfirmed', 0);
  return { db, execute: createQueryExecutor(db), scope: { actor_id: ids.actor, space_id: space, snapshot_seq: seq(ids.message1), consultation_thread_id: ids.consultation }, seq };
}

test('incremental and full pages use exclusive UUID cursors and stable ordering', async () => {
  const { db, execute, scope } = setup();
  try {
    const first = await execute('get_messages', { thread_id: ids.consultation, after_message_id: null, limit: 1 }, { ...scope, snapshot_seq: scope.snapshot_seq + 1 });
    assert.deepEqual(first.items.map((item) => item.message_id), [ids.message1]);
    assert.equal(first.has_more, true);
    assert.equal(first.next_after_id, ids.message1);
    const second = await execute('get_messages', { thread_id: ids.consultation, after_message_id: first.next_after_id, limit: 1 }, { ...scope, snapshot_seq: scope.snapshot_seq + 1 });
    assert.deepEqual(second.items.map((item) => item.message_id), [ids.message2]);
    assert.equal(second.has_more, false);
    assert.equal(second.next_after_id, ids.message2);
    const empty = await execute('get_messages', { thread_id: ids.consultation, after_message_id: second.next_after_id, limit: 1 }, { ...scope, snapshot_seq: scope.snapshot_seq + 1 });
    assert.deepEqual(empty.items, []);
    assert.equal(empty.next_after_id, ids.message2);
    const all = await execute('get_messages', { thread_id: ids.consultation, after_message_id: null, limit: 20 }, { ...scope, snapshot_seq: scope.snapshot_seq + 1 });
    assert.deepEqual(all.items.map((item) => item.message_id), [ids.message1, ids.message2]);
    assert.deepEqual(all.items[0].body, { text: 'one' });
    assert.equal(all.items[0].actor_id, ids.actor);
  } finally { db.close(); }
});

test('late inserts are excluded by the immutable snapshot', async () => {
  const { db, execute, scope } = setup();
  try {
    db.run('INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)', ids.message6, space, ids.consultation, 'utterance', ids.actor, '{"text":"late"}', '2026-10-08T00:01:00Z');
    const result = await execute('get_messages', { thread_id: ids.consultation, after_message_id: null, limit: 20 }, scope);
    assert.deepEqual(result.items.map((item) => item.message_id), [ids.message1]);
  } finally { db.close(); }
});

test('thread reads select the latest version at the snapshot, and lists page by UUID', async () => {
  const { db, execute, scope, seq } = setup();
  try {
    const thread = await execute('get_thread', { thread_id: ids.consultation }, { ...scope, snapshot_seq: seq(ids.message5) });
    assert.deepEqual(thread, { thread_id: ids.consultation, title: 'Final title', status: 'settled', summary: 'Official conclusion', message_seq: seq(ids.message5) });
    const page = await execute('list_threads', { status: null, after_thread_id: null, limit: 1 }, { ...scope, snapshot_seq: seq(ids.message3) });
    assert.equal(page.items.length, 1);
    assert.equal(page.has_more, true);
    const next = await execute('list_threads', { status: null, after_thread_id: page.next_after_id, limit: 10 }, { ...scope, snapshot_seq: seq(ids.message3) });
    assert.equal(next.items.some((item) => item.thread_id === ids.oldThread), true);
    assert.equal(next.has_more, false);
    assert.equal(next.next_after_id, next.items.at(-1).thread_id);
    const empty = await execute('list_threads', { status: null, after_thread_id: next.next_after_id, limit: 10 }, { ...scope, snapshot_seq: seq(ids.message3) });
    assert.deepEqual(empty.items, []);
    assert.equal(empty.next_after_id, next.next_after_id);
  } finally { db.close(); }
});

test('omitted list and agreement filters canonicalize to the same SQLite results as explicit nulls', async () => {
  const { db, execute, scope, seq } = setup();
  try {
    const omittedThreads = validateToolArguments('list_threads', {});
    const explicitThreads = validateToolArguments('list_threads', { status: null, after_thread_id: null, limit: null });
    assert.deepEqual(omittedThreads, explicitThreads);
    const implicitThreadPage = await execute('list_threads', omittedThreads, { ...scope, snapshot_seq: seq(ids.message3) });
    const explicitThreadPage = await execute('list_threads', explicitThreads, { ...scope, snapshot_seq: seq(ids.message3) });
    assert.deepEqual(implicitThreadPage, explicitThreadPage);

    const omittedAgreements = validateToolArguments('get_agreements', {});
    const explicitAgreements = validateToolArguments('get_agreements', { thread_id: null, after_agreement_id: null, limit: null });
    assert.deepEqual(omittedAgreements, explicitAgreements);
    const implicitAgreementPage = await execute('get_agreements', omittedAgreements, { ...scope, snapshot_seq: seq(ids.message2) });
    const explicitAgreementPage = await execute('get_agreements', explicitAgreements, { ...scope, snapshot_seq: seq(ids.message2) });
    assert.deepEqual(implicitAgreementPage, explicitAgreementPage);

    const omittedMessages = validateToolArguments('get_messages', { thread_id: ids.consultation });
    assert.deepEqual(omittedMessages, { thread_id: ids.consultation, after_message_id: null, limit: null });
  } finally { db.close(); }
});

test('settled and non-consultation transcripts are denied; get_message is scoped too', async () => {
  const { db, execute, scope, seq } = setup();
  try {
    await assert.rejects(execute('get_messages', { thread_id: ids.consultation, after_message_id: null, limit: 10 }, { ...scope, snapshot_seq: seq(ids.message5) }), /settled/i);
    await assert.rejects(execute('get_messages', { thread_id: ids.oldThread, after_message_id: null, limit: 10 }, { ...scope, snapshot_seq: seq(ids.message3) }), /consultation/i);
    await assert.rejects(execute('get_message', { message_id: ids.message3 }, { ...scope, snapshot_seq: seq(ids.message3) }), /consultation/i);
    const memberView = { ...scope, purpose: 'member_view', snapshot_seq: seq(ids.message5) };
    const closed = await execute('get_messages', { thread_id: ids.consultation, after_message_id: null, limit: 10 }, memberView);
    assert.deepEqual(closed.items.map((item) => item.message_id), [ids.message1, ids.message2, ids.message5]);
    await assert.rejects(execute('get_message', { message_id: ids.message3 }, { ...memberView, actor_id: ids.otherActor }), /membership/i);
  } finally { db.close(); }
});

test('membership is checked before object lookup and foreign cursors and threads fail explicitly', async () => {
  const { db, execute, scope } = setup();
  try {
    await assert.rejects(execute('get_thread', { thread_id: '00000000-0000-4000-8000-000000000099' }, { ...scope, actor_id: ids.otherActor }), /membership/i);
    await assert.rejects(execute('get_messages', { thread_id: ids.foreignThread, after_message_id: null, limit: 10 }, scope), /thread/i);
    await assert.rejects(execute('get_messages', { thread_id: ids.consultation, after_message_id: ids.message4, limit: 10 }, { ...scope, snapshot_seq: scope.snapshot_seq + 100, purpose: 'member_view' }), /cursor/i);
    await assert.rejects(execute('list_threads', { status: null, after_thread_id: ids.foreignThread, limit: 10 }, scope), /cursor/i);
  } finally { db.close(); }
});

test('agreements return confirmed snapshot versions and global principles', async () => {
  const { db, execute, scope } = setup();
  try {
    const result = await execute('get_agreements', { thread_id: ids.consultation, after_agreement_id: null, limit: 20 }, { ...scope, snapshot_seq: scope.snapshot_seq + 1 });
    assert.deepEqual(result.items.map((item) => item.text).sort(), ['Current agreement', 'Global principle']);
    const current = result.items.find((item) => item.text === 'Current agreement');
    assert.equal(current.confirmation_message_id, ids.message2);
    assert.equal(current.confirmation_actor_id, ids.actor);
    assert.equal(current.confirmed_at, '2026-10-08T00:00:02Z');
    assert.equal(result.items.some((item) => item.text === 'Unconfirmed'), false);
    const first = await execute('get_agreements', { thread_id: ids.consultation, after_agreement_id: null, limit: 1 }, { ...scope, snapshot_seq: scope.snapshot_seq + 1 });
    assert.equal(first.items[0].agreement_id, ids.agreement2, 'the earlier confirmation sequence comes first even though its UUID sorts later');
    const last = await execute('get_agreements', { thread_id: ids.consultation, after_agreement_id: first.next_after_id, limit: 10 }, { ...scope, snapshot_seq: scope.snapshot_seq + 1 });
    assert.equal(last.items[0].agreement_id, ids.agreement1);
    assert.equal(last.has_more, false);
    assert.equal(last.next_after_id, last.items.at(-1).agreement_id);
    const empty = await execute('get_agreements', { thread_id: ids.consultation, after_agreement_id: last.next_after_id, limit: 10 }, { ...scope, snapshot_seq: scope.snapshot_seq + 1 });
    assert.deepEqual(empty.items, []);
    assert.equal(empty.next_after_id, last.next_after_id);
  } finally { db.close(); }
});

test('malformed JSON and unknown tools fail explicitly', async () => {
  const { db, execute, scope } = setup();
  try {
    db.run('UPDATE messages SET body_json = ? WHERE message_id = ?', '{broken', ids.message1);
    await assert.rejects(execute('get_messages', { thread_id: ids.consultation, after_message_id: null, limit: 10 }, scope), /JSON/i);
    await assert.rejects(execute('run_sql', {}, scope), /unsupported.*tool/i);
    await assert.rejects(execute('toString', {}, scope), /unsupported.*tool/i);
    await assert.rejects(execute('constructor', {}, scope), /unsupported.*tool/i);
  } finally { db.close(); }
});


test('agreement thread filter must name a thread visible at the requested snapshot', async () => {
  const { db, execute, scope } = setup();
  try {
    await assert.rejects(execute('get_agreements', { thread_id: ids.foreignThread, after_agreement_id: null, limit: 10 }, scope), /thread/i);
    await assert.rejects(execute('get_agreements', { thread_id: ids.consultation, after_agreement_id: null, limit: 10 }, { ...scope, snapshot_seq: 0 }), /thread/i);
  } finally { db.close(); }
});

test('malformed D1 result envelopes fail explicitly instead of looking like empty history', async () => {
  const { db, scope } = setup();
  try {
    const malformedDb = { prepare(sql) { const statement = db.prepare(sql); return { bind(...values) { const bound = statement.bind(...values); return { first: () => bound.first(), all: async () => ({}) }; } }; } };
    await assert.rejects(createQueryExecutor(malformedDb)('get_messages', { thread_id: ids.consultation, after_message_id: null, limit: 10 }, scope), /result/i);
  } finally { db.close(); }
});
