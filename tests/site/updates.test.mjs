import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  AgentReadError,
  agentReadErrorResponse,
  getSpaceUpdates,
  parseSpaceUpdateParams,
  validateAgentQueryArguments,
} from '../../sites/family-therapist/src/server/updates.mjs';
import { readBoundedJson } from '../../sites/family-therapist/src/server/intake-http.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '../../sites/family-therapist');
const space = 'local-fixture';
const otherSpace = 'other-fixture';
const ids = {
  actorA: 'local_seedy', actorB: 'fixture_partner', outsider: 'unjoined_agent', system: 'system',
  thread: '00000000-0000-4000-8000-000000000010', otherThread: '00000000-0000-4000-8000-000000000011',
  expressionA: '00000000-0000-4000-8000-000000000101', expressionB: '00000000-0000-4000-8000-000000000102',
  therapist: '00000000-0000-4000-8000-000000000103', operation: '00000000-0000-4000-8000-000000000104',
  release: '00000000-0000-4000-8000-000000000105', foreign: '00000000-0000-4000-8000-000000000106',
  later: '00000000-0000-4000-8000-000000000107',
};

class SqliteD1 {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); }
  exec(sql) { this.sqlite.exec(sql); }
  prepare(sql) {
    const db = this.sqlite;
    return {
      bind: (...values) => ({
        all: async () => ({ results: db.prepare(sql).all(...values) }),
        first: async () => db.prepare(sql).get(...values) ?? null,
      }),
    };
  }
  close() { this.sqlite.close(); }
}

async function migratedDb() {
  const db = new SqliteD1();
  db.exec('PRAGMA foreign_keys = ON');
  const files = (await readdir(join(site, 'drizzle'))).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const name of files) {
    const sql = await readFile(join(site, 'drizzle', name), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) db.exec(statement);
  }
  for (const userId of [ids.actorA, ids.actorB]) await db.prepare('INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)').bind(space, userId, 'member').all();
  await db.prepare('INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)').bind(otherSpace, ids.actorA, 'member').all();
  const insert = async (messageId, spaceId, threadId, kind, actorId, body, createdAt = '2026-10-08T12:00:00.000Z') =>
    db.prepare('INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(messageId, spaceId, threadId, kind, actorId, JSON.stringify(body), createdAt).all();
  await insert(ids.expressionA, space, ids.thread, 'member_expression', ids.actorA, { text: 'I would like a calmer check-in.' });
  await insert(ids.expressionB, space, ids.thread, 'member_expression', ids.actorB, { text: 'I would like to understand what changed.' });
  await insert(ids.therapist, space, ids.thread, 'therapist_reply', ids.system, { reply: 'I hear each of you.' });
  await insert(ids.operation, space, ids.thread, 'thread_settled', ids.system, { status: 'settled' });
  await insert(ids.release, space, null, 'skill_release', ids.system, { version: '2026-10-08', notes: 'Read API support.' });
  await insert(ids.foreign, otherSpace, ids.otherThread, 'member_expression', ids.actorA, { text: 'Foreign space.' });
  return { db, insert };
}

const scope = (snapshot_seq = 5, actor_id = ids.actorA, space_id = space) => ({ actor_id, space_id, snapshot_seq, purpose: 'member_view' });
const query = (values = {}) => ({ after_message_id: null, limit: 100, ...values });

test('space updates traverse all members and formal message kinds in stable UUID cursor pages', async () => {
  const { db } = await migratedDb();
  try {
    const first = await getSpaceUpdates({ db, scope: scope(), ...query({ limit: 2 }) });
    assert.deepEqual(first.items.map((item) => item.message_id), [ids.expressionA, ids.expressionB]);
    assert.equal(first.items[1].actor_id, ids.actorB);
    assert.deepEqual(first.items[0].body, { text: 'I would like a calmer check-in.' });
    assert.equal(first.items[0].seq, 1);
    assert.equal(first.items[0].space_id, space);
    assert.equal(first.items[0].thread_id, ids.thread);
    assert.equal(first.has_more, true);
    assert.equal(first.next_after_id, ids.expressionB);
    assert.equal(first.snapshot_seq, 5);

    const second = await getSpaceUpdates({ db, scope: scope(), ...query({ after_message_id: first.next_after_id, limit: 2 }) });
    assert.deepEqual(second.items.map((item) => item.kind), ['therapist_reply', 'thread_settled']);
    assert.equal(second.has_more, true);

    const final = await getSpaceUpdates({ db, scope: scope(), ...query({ after_message_id: second.next_after_id }) });
    assert.deepEqual(final.items.map((item) => item.kind), ['skill_release']);
    assert.equal(final.items[0].thread_id, null);
    assert.equal(final.has_more, false);
    assert.equal(final.next_after_id, ids.release);

    const empty = await getSpaceUpdates({ db, scope: scope(), ...query({ after_message_id: final.next_after_id }) });
    assert.deepEqual(empty.items, []);
    assert.equal(empty.next_after_id, final.next_after_id);
  } finally { db.close(); }
});

test('fixed snapshot excludes later inserts while a fresh snapshot includes them', async () => {
  const { db, insert } = await migratedDb();
  try {
    const frozen = scope(5);
    await insert(ids.later, space, ids.thread, 'member_expression', ids.actorB, { text: 'Added after this snapshot.' });
    const oldBatch = await getSpaceUpdates({ db, scope: frozen, ...query({ after_message_id: ids.release }) });
    assert.deepEqual(oldBatch.items, []);
    assert.equal(oldBatch.snapshot_seq, 5);
    assert.equal(oldBatch.next_after_id, ids.release);

    const fresh = await getSpaceUpdates({ db, scope: scope(7), ...query({ after_message_id: ids.release }) });
    assert.deepEqual(fresh.items.map((item) => item.message_id), [ids.later]);
    assert.equal(fresh.snapshot_seq, 7);
  } finally { db.close(); }
});

test('membership is checked before cursor lookup and foreign, unknown, or out-of-snapshot cursors fail explicitly', async () => {
  const { db } = await migratedDb();
  try {
    await assert.rejects(getSpaceUpdates({ db, scope: scope(5), ...query({ snapshot_seq: 6 }) }), { code: 'invalid_updates_request' });
    await assert.rejects(getSpaceUpdates({ db, scope: scope(5, ids.outsider), ...query({ after_message_id: ids.foreign }) }), { code: 'membership_required' });
    await assert.rejects(getSpaceUpdates({ db, scope: scope(), ...query({ after_message_id: ids.foreign }) }), { code: 'invalid_cursor' });
    await assert.rejects(getSpaceUpdates({ db, scope: scope(), ...query({ after_message_id: ids.later }) }), { code: 'invalid_cursor' });
    await assert.rejects(getSpaceUpdates({ db, scope: scope(2), ...query({ after_message_id: ids.therapist }) }), { code: 'invalid_cursor' });
  } finally { db.close(); }
});

test('request parsing and shared query argument validation keep the agent API strict', () => {
  assert.deepEqual(parseSpaceUpdateParams(new URLSearchParams()), { after_message_id: null, limit: 100, snapshot_seq: null });
  assert.deepEqual(parseSpaceUpdateParams(new URLSearchParams('after_message_id=' + ids.expressionA + '&limit=10&snapshot_seq=4')), { after_message_id: ids.expressionA, limit: 10, snapshot_seq: 4 });
  for (const search of ['unknown=1', 'limit=0', 'limit=101', 'limit=01', 'snapshot_seq=-1', 'snapshot_seq=1&snapshot_seq=2', 'after_message_id=not-a-uuid']) {
    assert.throws(() => parseSpaceUpdateParams(new URLSearchParams(search)), AgentReadError);
  }
  assert.deepEqual(validateAgentQueryArguments('get_thread', { thread_id: ids.thread }), { thread_id: ids.thread });
  assert.throws(() => validateAgentQueryArguments('run_sql', {}), { code: 'unsupported_query' });
  assert.throws(() => validateAgentQueryArguments('get_thread', { thread_id: ids.thread, actor_id: ids.actorB }), { code: 'invalid_query' });
  assert.throws(() => validateAgentQueryArguments('get_thread', JSON.parse('{"thread_id":"' + ids.thread + '","__proto__":{"space_id":"foreign"}}')), { code: 'invalid_query' });
});

test('bad request JSON, invalid storage envelopes, malformed message JSON, and storage faults never become empty success', async () => {
  const { db } = await migratedDb();
  try {
    await assert.rejects(readBoundedJson(new Request('https://site.example/api/query/get_thread', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })), { code: 'invalid_body' });
    await assert.rejects(readBoundedJson(new Request('https://site.example/api/query/get_thread', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })), { code: 'invalid_content_type' });

    const brokenEnvelope = { prepare(sql) { const statement = db.prepare(sql); return { bind(...values) { const bound = statement.bind(...values); return { first: () => bound.first(), all: async () => ({}) }; } }; } };
    await assert.rejects(getSpaceUpdates({ db: brokenEnvelope, scope: scope(), ...query() }), { code: 'invalid_result_set' });

    const brokenMembership = { prepare() { return { bind() { return { first: async () => ({}) }; } }; } };
    await assert.rejects(getSpaceUpdates({ db: brokenMembership, scope: scope(), ...query() }), { code: 'invalid_result_set' });

    const failedDb = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('database unavailable'); } }) }) };
    await assert.rejects(getSpaceUpdates({ db: failedDb, scope: scope(), ...query() }), { code: 'storage_unavailable' });

    await db.prepare('UPDATE messages SET message_id=? WHERE message_id=?').bind('malformed-id', ids.expressionA).all();
    await assert.rejects(getSpaceUpdates({ db, scope: scope(), ...query({ limit: 1 }) }), { code: 'invalid_record' });
    await db.prepare('UPDATE messages SET message_id=? WHERE message_id=?').bind(ids.expressionA, 'malformed-id').all();
    await db.prepare('UPDATE messages SET body_json=? WHERE message_id=?').bind('{bad', ids.expressionA).all();
    await assert.rejects(getSpaceUpdates({ db, scope: scope(), ...query({ limit: 1 }) }), { code: 'invalid_message_json' });

    const failedResponse = agentReadErrorResponse(new AgentReadError('invalid_updates_request', 400));
    assert.equal(failedResponse.status, 400);
    assert.deepEqual(await failedResponse.json(), { code: 'invalid_updates_request', error: '更新请求格式无效。' });
    assert.equal(failedResponse.headers.get('cache-control'), 'private, no-store');
  } finally { db.close(); }
});
