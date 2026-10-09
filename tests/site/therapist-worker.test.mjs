import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { getExpressionReceipt, submitConfirmedExpression } from '../../sites/family-therapist/src/server/intake.mjs';
import { runNextTherapistTask } from '../../sites/family-therapist/src/server/therapist-worker.mjs';
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
    const preserved = await db.prepare('SELECT * FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    assert.equal(preserved.status, 'obsolete');
    assert.equal(preserved.created_at, 'original-task-time');
    assert.equal(preserved.input_thread_seq, 0);
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
    return { id: `resp-final-${index}`, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(output) }] }] };
  };
}

test('worker reads through scoped tools and atomically publishes one reply plus shared understanding', async () => {
  const db = await database();
  try {
    const result = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, request: provider() });
    assert.equal(result.status, 'completed');
    const task = await db.prepare('SELECT status, reply_message_id, understanding_message_id, candidate_id, run_snapshot_seq FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
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
    assert.equal(before.run_config_json.includes('OPENAI_API_KEY'), false);
    current = new Date('2026-10-08T12:00:02.000Z');
    const recovered = await runNextTherapistTask({ db, space_id: space, actor_id: ids.one, config, now: () => current, request: provider() });
    assert.equal(recovered.status, 'completed');
    release();
    const stale = await first;
    assert.equal(stale.error_code, 'worker_lease_lost');
    const after = await db.prepare('SELECT status, run_config_json FROM therapist_tasks WHERE message_id=?').bind(ids.expressionOne).first();
    assert.equal(after.status, 'completed');
    assert.equal(JSON.parse(after.run_config_json).scope.run_id, runId);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='therapist_reply'").first()).n, 1);
  } finally { db.close(); }
});
