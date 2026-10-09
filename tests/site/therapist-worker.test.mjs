import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { getExpressionReceipt, submitConfirmedExpression } from '../../sites/family-therapist/src/server/intake.mjs';
import { retryFailedTherapistTask, runNextTherapistTask } from '../../sites/family-therapist/src/server/therapist-worker.mjs';
import { createQueryExecutor } from '../../sites/family-therapist/src/server/queries.mjs';
import { THERAPIST_OUTPUT_SCHEMA } from '../../packages/therapist/output.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '../../sites/family-therapist');
const space = 'worker-space';
const ids = {
  one: '00000000-0000-4000-8000-000000000001',
  two: '00000000-0000-4000-8000-000000000002',
  thread: '00000000-0000-4000-8000-000000000010',
  anchor: '00000000-0000-4000-8000-000000000020',
  expressionOne: '00000000-0000-4000-8000-000000000101',
  expressionTwo: '00000000-0000-4000-8000-000000000102',
  expressionThree: '00000000-0000-4000-8000-000000000103',
  missingMessage: '00000000-0000-4000-8000-000000000199',
};

class Statement {
  constructor(sqlite, sql, values = []) { this.sqlite = sqlite; this.sql = sql; this.values = values; }
  bind(...values) { return new Statement(this.sqlite, this.sql, values); }
  async all() { return { results: this.sqlite.prepare(this.sql).all(...this.values) }; }
  async first() { return this.sqlite.prepare(this.sql).get(...this.values) ?? null; }
  async run() {
    const result = this.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class D1Sqlite {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys=ON'); this.batchQueue = Promise.resolve(); }
  prepare(sql) { return new Statement(this.sqlite, sql); }
  async batch(statements) {
    const next = this.batchQueue.then(async () => {
      this.sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        this.sqlite.exec('COMMIT');
        return results;
      } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
    });
    this.batchQueue = next.catch(() => {});
    return next;
  }
  close() { this.sqlite.close(); }
}

async function database() {
  const db = new D1Sqlite();
  for (const name of (await readdir(join(site, 'drizzle'))).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort()) {
    const sql = await readFile(join(site, 'drizzle', name), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) db.sqlite.exec(statement);
  }
  await db.prepare('INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)').bind(space, ids.one, 'husband').run();
  await db.prepare('INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)').bind(space, ids.two, 'wife').run();
  await db.prepare(`INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)`)
    .bind(ids.anchor, space, ids.thread, 'thread_created', ids.one, JSON.stringify({ title: 'Current' }), '2026-10-08T00:00:00.000Z').run();
  const anchor = await db.prepare('SELECT seq FROM messages WHERE message_id=?').bind(ids.anchor).first();
  await db.prepare('INSERT INTO thread_versions(space_id,thread_id,message_seq,title,status,summary) VALUES(?,?,?,?,?,?)')
    .bind(space, ids.thread, anchor.seq, 'Current', 'active', 'A two-person discussion').run();
  for (const [message_id, actor_id, text] of [[ids.expressionOne, ids.one, 'I want us to decide together.'], [ids.expressionTwo, ids.two, 'I also want room to say what matters to me.']]) {
    await submitConfirmedExpression({ db, scope: { actor_id, space_id: space }, command: {
      message_id, thread_id: ids.thread, expected_thread_seq: anchor.seq, text, confirmed: true,
    }, now: () => '2026-10-08T12:00:00.000Z' });
  }
  return db;
}

test('task migration preserves historical message identity and explicitly obsoletes uncaptured rows', async () => {
  const db = new D1Sqlite();
  try {
    const files = (await readdir(join(site, 'drizzle'))).filter((file) => /^\d{4}_.+\.sql$/.test(file)).sort();
    for (const name of files.filter((file) => file < '0005_magical_goblin_queen.sql')) {
      const sql = await readFile(join(site, 'drizzle', name), 'utf8');
      for (const statement of sql.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) db.sqlite.exec(statement);
    }
    await db.prepare('INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)').bind(space, ids.one, 'husband').run();
    await db.prepare('INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)').bind(space, ids.two, 'wife').run();
    await db.prepare('INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(ids.expressionOne, space, ids.thread, 'member_expression', ids.one, JSON.stringify({ text: 'preserved exactly' }), 'original-time').run();
    const message = await db.prepare('SELECT seq FROM messages WHERE message_id=?').bind(ids.expressionOne).first();
    await db.prepare('INSERT INTO therapist_tasks(message_id,message_seq,space_id,thread_id,status,created_at) VALUES(?,?,?,?,?,?)')
      .bind(ids.expressionOne, message.seq, space, ids.thread, 'queued', 'original-task-time').run();
    const migration = await readFile(join(site, 'drizzle/0005_magical_goblin_queen.sql'), 'utf8');
    for (const statement of migration.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) db.sqlite.exec(statement);
    await db.prepare(`UPDATE therapist_tasks SET lease_id=?, lease_expires_at=?, run_snapshot_seq=?, run_config_json=?, checkpoint_json=?,
      reply_message_id=?, understanding_message_id=?, candidate_id=?, covered_by=?, last_error_code=?, last_error_at=? WHERE message_id=?`)
      .bind('lease-stable', 'expiry-stable', 77, '{"frozen":true}', '{"checkpoint":true}', 'reply-stable', 'understanding-stable',
        'candidate-stable', 'covered-stable', 'prior-error', 'prior-error-time', ids.expressionOne).run();
    const preserved = await db.prepare('SELECT * FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    assert.equal(preserved.status, 'queued');
    assert.equal(preserved.created_at, 'original-task-time');
    assert.equal(preserved.input_thread_seq, 0);
    const extension = await readFile(join(site, 'drizzle/0006_marvelous_skreet.sql'), 'utf8');
    for (const statement of extension.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) db.sqlite.exec(statement);
    const extended = await db.prepare('SELECT * FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    for (const [column, value] of Object.entries({ status: 'queued', created_at: 'original-task-time', input_thread_seq: 0, lease_id: 'lease-stable',
      lease_expires_at: 'expiry-stable', run_snapshot_seq: 77, run_config_json: '{"frozen":true}', checkpoint_json: '{"checkpoint":true}',
      reply_message_id: 'reply-stable', understanding_message_id: 'understanding-stable', candidate_id: 'candidate-stable', covered_by: 'covered-stable',
      last_error_code: 'prior-error', last_error_at: 'prior-error-time', retry_count: 0 })) assert.equal(extended[column], value, column);
    assert.equal((await db.prepare('SELECT body_json, created_at FROM messages WHERE message_id=?').bind(ids.expressionOne).first()).body_json, JSON.stringify({ text: 'preserved exactly' }));
  } finally { db.close(); }
});

const config = Object.freeze({
  model: 'injected-test-model', skill_version: 'cloud-therapist@test', instructions: 'Use the scoped read tools and cite formal expressions.',
  output_schema: THERAPIST_OUTPUT_SCHEMA, max_tool_calls: 6,
});

function finalOutput(citations = [ids.expressionOne, ids.expressionTwo]) {
  return {
    reply: 'You both described wanting a shared decision process.',
    source_message_ids: citations,
    common_points: [{ text: 'Both want to make this decision together.', source_message_ids: citations }],
    differences: [], hypotheses: [], consensus_proposal: null,
  };
}

function provider({ output = finalOutput(), secondTool = true, onCall = async () => {} } = {}) {
  let index = 0;
  return async (payload) => {
    await onCall(payload, index);
    index += 1;
    if (index === 1) return { id: 'resp-tool-1', status: 'completed', output: [{
      type: 'function_call', call_id: 'call-thread', name: 'get_thread', arguments: JSON.stringify({ thread_id: ids.thread }),
    }] };
    if (index === 2 && secondTool) return { id: 'resp-tool-2', status: 'completed', output: [{
      type: 'function_call', call_id: 'call-messages', name: 'get_messages', arguments: JSON.stringify({ thread_id: ids.thread, after_message_id: null, limit: 25 }),
    }] };
    if (index === (secondTool ? 3 : 2)) return { id: `resp-evidence-${index}`, status: 'completed', output: [] };
    return { id: `resp-final-${index}`, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] };
  };
}

test('worker reads through scoped tools and atomically publishes one reply plus shared understanding', async () => {
  const db = await database();
  try {
    let initialInput = '';
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.two, config,
      request: provider({ onCall: async (payload, index) => { if (!index) initialInput = payload.input[0].content; } }) });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.match(initialInput, new RegExp(`${ids.expressionOne}.*${ids.one}.*husband.*${ids.one}.*husband.*${ids.two}.*wife`));
    const task = await db.prepare('SELECT status, reply_message_id, understanding_message_id, candidate_id, run_snapshot_seq FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    assert.match(initialInput, new RegExp(`Authoritative current consultation thread UUID: ${ids.thread}\\. Frozen message snapshot sequence: ${task.run_snapshot_seq}(?:\\D|$)`));
    assert.equal(task.status, 'completed');
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE kind=?').bind('therapist_reply').first()).n, 1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM messages WHERE kind=?').bind('understanding_updated').first()).n, 1);
    const body = await db.prepare('SELECT body_json FROM messages WHERE message_id=?').bind(task.understanding_message_id).first();
    assert.equal(JSON.parse(body.body_json).candidate_status, null);
    assert.ok(task.candidate_id);
    assert.equal(task.run_snapshot_seq, (await db.prepare('SELECT seq FROM messages WHERE message_id=?').bind(ids.expressionTwo).first()).seq);
    const covered = await db.prepare('SELECT status, covered_by FROM therapist_tasks WHERE message_id=?').bind(ids.expressionTwo).first();
    assert.equal(covered.status, 'completed');
    assert.equal(covered.covered_by, ids.expressionOne);
    const receipt = await getExpressionReceipt({ db, scope: { actor_id: ids.one, space_id: space }, messageId: ids.expressionOne });
    assert.equal(receipt.task_status, 'completed');
    assert.equal(receipt.message_id, ids.expressionOne);
    assert.equal(receipt.text, 'I want us to decide together.');
  } finally { db.close(); }
});

test('worker returns an in-scope missing-message tool error so the model can query real evidence and complete', async () => {
  const db = await database();
  try {
    const before = (await db.prepare('SELECT COUNT(*) AS n FROM messages').first()).n;
    const snapshot = (await db.prepare('SELECT seq FROM messages WHERE message_id=?').bind(ids.expressionTwo).first()).seq;
    const directQuery = createQueryExecutor(db);
    const queryScope = { actor_id: ids.one, space_id: space, snapshot_seq: snapshot, thread_id: ids.thread, consultation_thread_id: ids.thread };
    await assert.rejects(directQuery('get_message', { message_id: ids.missingMessage }, { ...queryScope, purpose: 'member_view' }),
      (error) => error.code === 'message_not_found' && error.status === 404);
    assert.deepEqual(await directQuery('get_message', { message_id: ids.missingMessage }, { ...queryScope, purpose: 'therapist' }),
      { error: { code: 'message_not_found' } });

    const requests = [];
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config,
      request: async (payload) => {
        requests.push(payload);
        if (requests.length === 1) return { id: 'resp-missing', status: 'completed', output: [{
          type: 'function_call', call_id: 'call-missing', name: 'get_message', arguments: JSON.stringify({ message_id: ids.missingMessage }),
        }] };
        if (requests.length === 2) {
          assert.deepEqual(JSON.parse(payload.input[0].output), { error: { code: 'message_not_found' } });
          assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM messages').first()).n, before);
          return { id: 'resp-real-thread', status: 'completed', output: [{
            type: 'function_call', call_id: 'call-real-thread', name: 'get_messages', arguments: JSON.stringify({ thread_id: ids.thread, after_message_id: null, limit: 25 }),
          }] };
        }
        if (requests.length === 3) {
          const toolResult = JSON.parse(payload.input[0].output);
          assert.deepEqual(toolResult.items.map((message) => message.message_id), [ids.anchor, ids.expressionOne, ids.expressionTwo]);
          assert.equal(toolResult.snapshot_seq, snapshot);
          return { id: 'resp-finalize', status: 'completed', output: [] };
        }
        return { id: 'resp-final', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(finalOutput()) }] }] };
      } });

    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(requests.length, 4);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind IN ('therapist_reply','understanding_updated')").first()).n, 2);
    assert.equal((await db.prepare('SELECT status FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).status, 'completed');
    assert.equal((await db.prepare('SELECT status, covered_by FROM therapist_tasks WHERE message_id=?').bind(ids.expressionTwo).first()).covered_by, ids.expressionOne);
  } finally { db.close(); }
});

test('worker still aborts a transcript-forbidden read without publishing or exposing records', async () => {
  const db = await database();
  try {
    const foreignThread = '00000000-0000-4000-8000-000000000011';
    const foreignAnchor = '00000000-0000-4000-8000-000000000021';
    await db.prepare('INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind(foreignAnchor, space, foreignThread, 'thread_created', ids.one, '{}', 'foreign-anchor').run();
    const anchor = await db.prepare('SELECT seq FROM messages WHERE message_id=?').bind(foreignAnchor).first();
    await db.prepare('INSERT INTO thread_versions(space_id,thread_id,message_seq,title,status,summary) VALUES(?,?,?,?,?,?)')
      .bind(space, foreignThread, anchor.seq, 'Other topic', 'active', '').run();
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, request: async () => ({
      id: 'resp-forbidden-thread', status: 'completed', output: [{
        type: 'function_call', call_id: 'call-forbidden-thread', name: 'get_messages',
        arguments: JSON.stringify({ thread_id: foreignThread, after_message_id: null, limit: 25 }),
      }],
    }) });
    assert.equal(result.status, 'failed');
    assert.equal(result.error_code, 'transcript_forbidden');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind IN ('therapist_reply','understanding_updated')").first()).n, 0);
    const checkpoint = JSON.parse((await db.prepare('SELECT checkpoint_json FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).checkpoint_json);
    assert.equal(checkpoint.tool_results.length, 0);
  } finally { db.close(); }
});

test('worker leaves a queued expression uncovered when the final sources include only the triggering expression', async () => {
  const db = await database();
  try {
    const output = finalOutput([ids.expressionOne]);
    output.common_points = [];
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, request: provider({ output }) });
    assert.equal(result.status, 'completed');
    const first = await db.prepare('SELECT status FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    const second = await db.prepare('SELECT status, covered_by FROM therapist_tasks WHERE message_id=?').bind(ids.expressionTwo).first();
    assert.equal(first.status, 'completed');
    assert.equal(second.status, 'queued');
    assert.equal(second.covered_by, null);
  } finally { db.close(); }
});

test('worker rejects a completed result that does not cite the expression that triggered its task', async () => {
  const db = await database();
  try {
    const output = finalOutput();
    output.source_message_ids = [ids.expressionTwo];
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, request: provider({ output }) });
    assert.deepEqual({ status: result.status, error_code: result.error_code }, { status: 'failed', error_code: 'invalid_output' });
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind IN ('therapist_reply','understanding_updated')").first()).n, 0);
    assert.equal((await db.prepare('SELECT status FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).status, 'failed');
  } finally { db.close(); }
});

test('thread change during generation makes the task obsolete without publishing a reply', async () => {
  const db = await database();
  try {
    let changed = false;
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config,
      request: provider({ onCall: async (_payload, index) => {
        if (index !== 2 || changed) return;
        changed = true;
        await db.prepare(`INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)`)
          .bind('00000000-0000-4000-8000-000000000090', space, ids.thread, 'thread_updated', ids.one, '{}', '2026-10-08T12:30:00.000Z').run();
        const next = await db.prepare('SELECT seq FROM messages WHERE message_id=?').bind('00000000-0000-4000-8000-000000000090').first();
        await db.prepare('INSERT INTO thread_versions(space_id,thread_id,message_seq,title,status,summary) VALUES(?,?,?,?,?,?)')
          .bind(space, ids.thread, next.seq, 'Changed topic', 'active', '').run();
      } }) });
    assert.equal(result.status, 'obsolete');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='therapist_reply'").first()).n, 0);
    assert.equal((await db.prepare('SELECT status FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).status, 'obsolete');
  } finally { db.close(); }
});

test('legacy uncaptured task status is preserved by migration then explicitly obsoleted by runtime', async () => {
  const db = await database();
  try {
    await db.prepare('UPDATE therapist_tasks SET input_thread_seq=0 WHERE message_id=?').bind(ids.expressionOne).run();
    let providerCalls = 0;
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config,
      request: async () => { providerCalls += 1; return provider()(); } });
    assert.equal(result.status, 'obsolete');
    assert.equal(providerCalls, 0);
    assert.equal((await db.prepare('SELECT status, input_thread_seq FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).status, 'obsolete');
  } finally { db.close(); }
});

test('a database failure after reply insertion rolls back status and all public output', async () => {
  const db = await database();
  try {
    const batch = db.batch.bind(db);
    db.batch = (statements) => batch(statements.map((statement, index) => index === 2
      ? new Statement(db.sqlite, 'INSERT INTO missing_table(value) VALUES(?)', ['failure'])
      : statement));
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, request: provider() });
    assert.equal(result.status, 'failed');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind IN ('therapist_reply','understanding_updated')").first()).n, 0);
    assert.equal((await db.prepare('SELECT status FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).status, 'failed');
  } finally { db.close(); }
});

test('one-partner common point or unknown citation fails without publishing any therapist output', async () => {
  const db = await database();
  try {
    const invalid = finalOutput();
    invalid.common_points[0].source_message_ids = [ids.expressionOne, ids.expressionOne];
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, request: provider({ output: invalid }) });
    assert.deepEqual({ status: result.status, error_code: result.error_code }, { status: 'failed', error_code: 'invalid_output' });
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind IN ('therapist_reply','understanding_updated')").first()).n, 0);
    assert.equal((await db.prepare('SELECT status FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).status, 'failed');
  } finally { db.close(); }
});

test('expired lease recovery keeps the frozen run ID and stale owner cannot save a checkpoint', async () => {
  const db = await database();
  try {
    let current = new Date('2026-10-08T12:00:00.000Z');
    let entered;
    let release;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    const firstProvider = provider();
    const first = runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config,
      now: () => current, lease_ms: 1_000,
      request: async (payload) => {
        if (!payload.previous_response_id) { entered(); await blocked; }
        return firstProvider(payload);
      },
    });
    await enteredPromise;
    const before = await db.prepare('SELECT run_config_json FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    const runId = JSON.parse(before.run_config_json).scope.run_id;
    assert.equal(before.run_config_json.includes('THERAPIST_API_KEY'), false);
    const thread = await db.prepare('SELECT message_seq FROM thread_versions WHERE space_id=? AND thread_id=?').bind(space, ids.thread).first();
    await submitConfirmedExpression({ db, scope: { actor_id: ids.two, space_id: space }, command: {
      message_id: ids.expressionThree, thread_id: ids.thread, expected_thread_seq: thread.message_seq,
      text: 'A newer thought waits for its own run.', confirmed: true,
    }, now: () => '2026-10-08T12:00:01.000Z' });
    current = new Date('2026-10-08T12:00:02.000Z');
    const recovered = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, now: () => current, request: provider() });
    assert.equal(recovered.status, 'completed');
    release();
    const stale = await first;
    assert.equal(stale.error_code, 'worker_lease_lost');
    const after = await db.prepare('SELECT status, run_config_json FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    assert.equal(after.status, 'completed');
    assert.equal(JSON.parse(after.run_config_json).scope.run_id, runId);
    assert.equal((await db.prepare('SELECT status FROM therapist_tasks WHERE message_id=?').bind(ids.expressionThree).first()).status, 'queued');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='therapist_reply'").first()).n, 1);
  } finally { db.close(); }
});

test('default worker clock extends the lease from the time of each checkpoint', async () => {
  const db = await database();
  try {
    let initialExpiry;
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, lease_ms: 1_000,
      request: provider({ onCall: async (_payload, index) => {
        if (index === 0) {
          initialExpiry = Date.parse((await db.prepare('SELECT lease_expires_at FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).lease_expires_at);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (index === 1) {
          const expiry = Date.parse((await db.prepare('SELECT lease_expires_at FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).lease_expires_at);
          assert.ok(expiry > initialExpiry, `checkpoint did not extend lease beyond ${new Date(initialExpiry).toISOString()}`);
        }
      } }) });
    assert.equal(result.status, 'completed', JSON.stringify(result));
  } finally { db.close(); }
});

test('default worker clock refuses to checkpoint or publish after a provider call outlasts its lease', async () => {
  const db = await database();
  try {
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, lease_ms: 1_000,
      request: provider({ onCall: async (_payload, index) => { if (index === 0) await new Promise((resolve) => setTimeout(resolve, 1_200)); } }) });
    assert.equal(result.status, 'failed');
    assert.equal(result.error_code, 'worker_lease_lost');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind IN ('therapist_reply','understanding_updated')").first()).n, 0);
    assert.equal((await db.prepare('SELECT status FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).status, 'running');
  } finally { db.close(); }
});

test('expired stale job is obsoleted before a resumed provider call when principles changed', async () => {
  const db = await database();
  try {
    let now = new Date('2026-10-08T12:00:00.000Z');
    let entered;
    let release;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    const first = runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, now: () => now, lease_ms: 1_000,
      request: async () => { entered(); await blocked; return { id: 'late-provider', status: 'completed', output: [] }; } });
    await enteredPromise;
    await db.prepare(`INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)`)
      .bind('00000000-0000-4000-8000-000000000092', space, ids.thread, 'agreement_confirmed', ids.one, '{}', 'principle-change').run();
    const principleSeq = (await db.prepare('SELECT seq FROM messages WHERE message_id=?').bind('00000000-0000-4000-8000-000000000092').first()).seq;
    await db.prepare(`INSERT INTO agreement_versions(space_id,agreement_id,thread_id,message_seq,version,confirmed,text)
      VALUES(?,?,?,?,?,?,?)`).bind(space, 'global-principle', null, principleSeq, 1, 1, 'A new shared principle').run();
    now = new Date('2026-10-08T12:00:02.000Z');
    let resumedCalls = 0;
    const resumed = await runNextTherapistTask({ db, space_id: space, actor_id: ids.two, config, now: () => now,
      request: async () => { resumedCalls += 1; throw new Error('must not spend'); } });
    assert.equal(resumed.status, 'obsolete');
    assert.equal(resumedCalls, 0);
    assert.equal((await db.prepare('SELECT status, lease_id FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).status, 'obsolete');
    release();
    assert.equal((await first).error_code, 'worker_lease_lost');
  } finally { db.close(); }
});

test('checkpoint byte budget fails explicitly without persisting an oversized row or publishing', async () => {
  const db = await database();
  try {
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.two, config,
      request: async () => ({ id: 'large-response', status: 'completed', output: [{
        type: 'function_call', call_id: 'large-call', name: 'get_thread', arguments: `{"thread_id":"${'x'.repeat(1_000_100)}"}`,
      }] }) });
    assert.equal(result.status, 'failed');
    assert.equal(result.error_code, 'checkpoint_budget_exceeded');
    assert.equal((await db.prepare('SELECT checkpoint_json FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).checkpoint_json, null);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind IN ('therapist_reply','understanding_updated')").first()).n, 0);
  } finally { db.close(); }
});

test('a state change between preflight and publish rolls back leader outputs and leaves newer queued input untouched', async () => {
  const db = await database();
  try {
    const batch = db.batch.bind(db);
    let changed = false;
    db.batch = async (statements) => {
      if (!changed) {
        changed = true;
        await db.prepare(`INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)`)
          .bind('00000000-0000-4000-8000-000000000091', space, ids.thread, 'thread_updated', ids.one, '{}', '2026-10-08T12:30:00.000Z').run();
        const next = await db.prepare('SELECT seq FROM messages WHERE message_id=?').bind('00000000-0000-4000-8000-000000000091').first();
        await db.prepare('INSERT INTO thread_versions(space_id,thread_id,message_seq,title,status,summary) VALUES(?,?,?,?,?,?)')
          .bind(space, ids.thread, next.seq, 'Changed before commit', 'active', '').run();
      }
      return batch(statements);
    };
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, request: provider() });
    assert.equal(result.status, 'obsolete');
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind IN ('therapist_reply','understanding_updated')").first()).n, 0);
    assert.equal((await db.prepare('SELECT status FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).status, 'obsolete');
    assert.equal((await db.prepare('SELECT status FROM therapist_tasks WHERE message_id=?').bind(ids.expressionTwo).first()).status, 'queued');
  } finally { db.close(); }
});

test('a preallocated output UUID collision fails the batch without completing leader or covered receipt', async () => {
  const db = await database();
  try {
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config,
      request: provider({ onCall: async (_payload, index) => {
        if (index) return;
        const task = await db.prepare('SELECT reply_message_id FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
        await db.prepare('INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)')
          .bind(task.reply_message_id, space, ids.thread, 'member_expression', ids.one, JSON.stringify({ text: 'collision fixture' }), 'collision-time').run();
      } }) });
    assert.equal(result.status, 'failed');
    assert.equal(result.error_code, 'output_uuid_collision');
    const task = await db.prepare('SELECT reply_message_id FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    assert.equal((await db.prepare('SELECT kind, body_json FROM messages WHERE message_id=?').bind(task.reply_message_id).first()).kind, 'member_expression');
    assert.equal((await db.prepare('SELECT status FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).status, 'failed');
    assert.equal((await db.prepare('SELECT status FROM therapist_tasks WHERE message_id=?').bind(ids.expressionTwo).first()).status, 'queued');
  } finally { db.close(); }
});

test('explicit retry is bounded, preserves frozen request identity, and does not happen automatically', async () => {
  const db = await database();
  try {
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config,
      request: async () => { throw Object.assign(new Error('safe provider failure'), { code: 'credit_balance_exhausted', status: 429, request_id: 'req_123' }); } });
    assert.equal(result.status, 'failed');
    assert.equal(result.error_code, 'credit_balance_exhausted');
    assert.equal(result.error_status, 429);
    assert.equal(result.error_request_id, 'req_123');
    const failed = await db.prepare('SELECT status, run_config_json, checkpoint_json, reply_message_id, retry_count, last_error_status, last_error_request_id FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    assert.equal(failed.status, 'failed');
    assert.equal(failed.last_error_status, 429);
    assert.equal(failed.last_error_request_id, 'req_123');
    assert.equal((await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, task_message_id: ids.expressionOne, request: provider() })).status, 'idle');
    const retried = await retryFailedTherapistTask({ db, space_id: space, actor_id: ids.two, message_id: ids.expressionOne });
    assert.equal(retried.status, 'queued');
    assert.equal(retried.retry_count, 1);
    const after = await db.prepare('SELECT status, run_config_json, checkpoint_json, reply_message_id, retry_count FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    assert.equal(after.run_config_json, failed.run_config_json);
    assert.equal(after.checkpoint_json, failed.checkpoint_json);
    assert.equal(after.reply_message_id, failed.reply_message_id);
    assert.equal(after.retry_count, 1);
  } finally { db.close(); }
});

test('explicit retry resumes an orchestration-failed checkpoint after optional tool arguments become valid', async () => {
  const db = await database();
  try {
    const originalPrepare = db.prepare.bind(db);
    let failFirstListQuery = true;
    db.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (!failFirstListQuery || !sql.includes('ORDER BY tv.message_seq ASC, tv.thread_id ASC LIMIT ?')) return statement;
      return { bind: (...values) => {
        const bound = statement.bind(...values);
        return { all: async () => {
          if (failFirstListQuery) { failFirstListQuery = false; throw new Error('temporary query read failure'); }
          return bound.all();
        } };
      } };
    };
    const failed = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, request: async () => ({
      id: 'resp-pending-list', status: 'completed', output: [{
        type: 'function_call', call_id: 'call-list', name: 'list_threads', arguments: '{}',
      }],
    }) });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_code, 'orchestration_failed');
    const before = await db.prepare('SELECT checkpoint_json, retry_count FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    const checkpoint = JSON.parse(before.checkpoint_json);
    assert.equal(checkpoint.phase, 'tools_pending');
    assert.equal(checkpoint.pending_calls[0].arguments, '{}');

    const accepted = await retryFailedTherapistTask({ db, space_id: space, actor_id: ids.two, message_id: ids.expressionOne });
    assert.equal(accepted.status, 'queued');
    assert.equal(accepted.retry_count, before.retry_count + 1);

    const requests = [];
    const resumed = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config,
      task_message_id: ids.expressionOne,
      request: async (payload) => {
        requests.push(payload);
        if (requests.length === 1) return { id: 'resp-list-done', status: 'completed', output: [] };
        return { id: 'resp-final', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(finalOutput()) }] }] };
      },
    });
    assert.equal(resumed.status, 'completed');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].previous_response_id, 'resp-pending-list');
    const listResult = JSON.parse(requests[0].input[0].output);
    assert.equal(listResult.items.length, 1);
    assert.equal(listResult.items[0].thread_id, ids.thread);
    const completed = await db.prepare('SELECT status, retry_count, checkpoint_json FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    assert.equal(completed.status, 'completed');
    assert.equal(completed.retry_count, before.retry_count + 1);
    assert.equal(completed.checkpoint_json, null);
  } finally { db.close(); }
});

test('explicit retry resumes a legacy missing-record checkpoint through the model error result without changing run identity', async () => {
  const db = await database();
  try {
    const originalPrepare = db.prepare.bind(db);
    let failMessageRead = true;
    db.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (!failMessageRead || !sql.includes('FROM messages WHERE space_id = ? AND message_id = ? AND seq <= ?')) return statement;
      return { bind: (...values) => {
        const bound = statement.bind(...values);
        return { first: async () => { failMessageRead = false; throw new Error('legacy query failure'); } };
      } };
    };
    const failed = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, request: async () => ({
      id: 'resp-pending-missing', status: 'completed', output: [{
        type: 'function_call', call_id: 'call-missing-legacy', name: 'get_message', arguments: JSON.stringify({ message_id: ids.missingMessage }),
      }],
    }) });
    assert.equal(failed.status, 'failed');
    const before = await db.prepare('SELECT run_config_json, checkpoint_json, reply_message_id, understanding_message_id, retry_count FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    const checkpoint = JSON.parse(before.checkpoint_json);
    assert.equal(checkpoint.phase, 'tools_pending');
    assert.equal(checkpoint.pending_calls[0].arguments, JSON.stringify({ message_id: ids.missingMessage }));
    db.prepare = originalPrepare;
    const exhaustedCheckpoint = { ...checkpoint, tool_call_count: config.max_tool_calls };
    await db.prepare("UPDATE therapist_tasks SET last_error_code='message_not_found', last_error_status=404, checkpoint_json=? WHERE message_id=?")
      .bind(JSON.stringify(exhaustedCheckpoint), ids.expressionOne).run();
    const exhausted = await retryFailedTherapistTask({ db, space_id: space, actor_id: ids.two, message_id: ids.expressionOne });
    assert.equal(exhausted.status, 'retry_unavailable');
    const invalidArgsCheckpoint = { ...checkpoint, pending_calls: checkpoint.pending_calls.map((call) => ({ ...call, arguments: '{"message_id":"invalid"}' })) };
    await db.prepare('UPDATE therapist_tasks SET checkpoint_json=? WHERE message_id=?').bind(JSON.stringify(invalidArgsCheckpoint), ids.expressionOne).run();
    assert.equal((await retryFailedTherapistTask({ db, space_id: space, actor_id: ids.two, message_id: ids.expressionOne })).status, 'retry_unavailable');
    const changedScopeCheckpoint = { ...checkpoint, scope: { ...checkpoint.scope, actor_id: ids.two } };
    await db.prepare('UPDATE therapist_tasks SET checkpoint_json=? WHERE message_id=?').bind(JSON.stringify(changedScopeCheckpoint), ids.expressionOne).run();
    assert.equal((await retryFailedTherapistTask({ db, space_id: space, actor_id: ids.two, message_id: ids.expressionOne })).status, 'retry_unavailable');
    await db.prepare('UPDATE therapist_tasks SET retry_count=3 WHERE message_id=?').bind(ids.expressionOne).run();
    assert.equal((await retryFailedTherapistTask({ db, space_id: space, actor_id: ids.two, message_id: ids.expressionOne })).status, 'retry_unavailable');
    await db.prepare('UPDATE therapist_tasks SET retry_count=? WHERE message_id=?').bind(before.retry_count, ids.expressionOne).run();
    await db.prepare('UPDATE therapist_tasks SET checkpoint_json=? WHERE message_id=?').bind(before.checkpoint_json, ids.expressionOne).run();
    await db.prepare("UPDATE therapist_tasks SET last_error_code='message_not_found', last_error_status=404 WHERE message_id=?").bind(ids.expressionOne).run();

    const accepted = await retryFailedTherapistTask({ db, space_id: space, actor_id: ids.two, message_id: ids.expressionOne });
    assert.equal(accepted.status, 'queued');
    const afterAccept = await db.prepare('SELECT run_config_json, checkpoint_json, reply_message_id, understanding_message_id, retry_count FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    assert.equal(afterAccept.run_config_json, before.run_config_json);
    assert.equal(afterAccept.checkpoint_json, before.checkpoint_json);
    assert.equal(afterAccept.reply_message_id, before.reply_message_id);
    assert.equal(afterAccept.understanding_message_id, before.understanding_message_id);

    const requests = [];
    const resumed = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, task_message_id: ids.expressionOne,
      request: async (payload) => {
        requests.push(payload);
        if (requests.length === 1) {
          assert.equal(payload.previous_response_id, 'resp-pending-missing');
          assert.deepEqual(JSON.parse(payload.input[0].output), { error: { code: 'message_not_found' } });
          return { id: 'resp-resume-thread', status: 'completed', output: [{
            type: 'function_call', call_id: 'call-resume-thread', name: 'get_messages', arguments: JSON.stringify({ thread_id: ids.thread, after_message_id: null, limit: 25 }),
          }] };
        }
        if (requests.length === 2) {
          const output = JSON.parse(payload.input[0].output);
          assert.deepEqual(output.items.map((message) => message.message_id), [ids.anchor, ids.expressionOne, ids.expressionTwo]);
          return { id: 'resp-resume-finalize', status: 'completed', output: [] };
        }
        return { id: 'resp-resumed-final', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(finalOutput()) }] }] };
      } });
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
    assert.equal(requests.length, 3);
    const completed = await db.prepare('SELECT status, retry_count, reply_message_id, understanding_message_id FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    assert.equal(completed.status, 'completed');
    assert.equal(completed.retry_count, before.retry_count + 1);
    assert.equal(completed.reply_message_id, before.reply_message_id);
    assert.equal(completed.understanding_message_id, before.understanding_message_id);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind IN ('therapist_reply','understanding_updated')").first()).n, 2);
  } finally { db.close(); }
});

test('an orchestration-failed checkpoint with invalid optional tool arguments remains unavailable for retry', async () => {
  const db = await database();
  try {
    const failed = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, request: async () => ({
      id: 'resp-pending-invalid-list', status: 'completed', output: [{
        type: 'function_call', call_id: 'call-list-invalid', name: 'list_threads', arguments: JSON.stringify({ status: 'unknown' }),
      }],
    }) });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_code, 'orchestration_failed');
    const retried = await retryFailedTherapistTask({ db, space_id: space, actor_id: ids.two, message_id: ids.expressionOne });
    assert.equal(retried.status, 'retry_unavailable');
    const task = await db.prepare('SELECT status, retry_count FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    assert.equal(task.status, 'failed');
    assert.equal(task.retry_count, 0);
  } finally { db.close(); }
});

test('an orchestration-failed checkpoint with a changed frozen thread scope remains unavailable for retry', async () => {
  const db = await database();
  try {
    const originalPrepare = db.prepare.bind(db);
    let failFirstListQuery = true;
    db.prepare = (sql) => {
      const statement = originalPrepare(sql);
      if (!failFirstListQuery || !sql.includes('ORDER BY tv.message_seq ASC, tv.thread_id ASC LIMIT ?')) return statement;
      return { bind: (...values) => {
        const bound = statement.bind(...values);
        return { all: async () => {
          if (failFirstListQuery) { failFirstListQuery = false; throw new Error('temporary query read failure'); }
          return bound.all();
        } };
      } };
    };
    const failed = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, request: async () => ({
      id: 'resp-pending-list-scope', status: 'completed', output: [{
        type: 'function_call', call_id: 'call-list-scope', name: 'list_threads', arguments: '{}',
      }],
    }) });
    assert.equal(failed.status, 'failed');
    const row = await db.prepare('SELECT checkpoint_json FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    const checkpoint = JSON.parse(row.checkpoint_json);
    checkpoint.scope.thread_id = ids.expressionThree;
    await db.prepare('UPDATE therapist_tasks SET checkpoint_json=? WHERE message_id=?').bind(JSON.stringify(checkpoint), ids.expressionOne).run();

    const retried = await retryFailedTherapistTask({ db, space_id: space, actor_id: ids.two, message_id: ids.expressionOne });
    assert.equal(retried.status, 'retry_unavailable');
    assert.equal((await db.prepare('SELECT status, retry_count FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).retry_count, 0);
  } finally { db.close(); }
});

test('an orchestration failure outside tools_pending remains unavailable for retry', async () => {
  const db = await database();
  try {
    const failed = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config,
      request: async () => { throw new Error('provider request failed before a tool call'); },
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error_code, 'orchestration_failed');
    const checkpoint = JSON.parse((await db.prepare('SELECT checkpoint_json FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first()).checkpoint_json);
    assert.equal(checkpoint.phase, 'request');

    const retried = await retryFailedTherapistTask({ db, space_id: space, actor_id: ids.two, message_id: ids.expressionOne });
    assert.equal(retried.status, 'retry_unavailable');
    const task = await db.prepare('SELECT status, retry_count FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    assert.equal(task.status, 'failed');
    assert.equal(task.retry_count, 0);
  } finally { db.close(); }
});
