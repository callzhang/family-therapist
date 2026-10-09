import { randomUUID } from 'node:crypto';
import { runTherapistTurn } from '../../../../packages/therapist/responses.mjs';
import { THERAPIST_OUTPUT_SCHEMA, validateTherapistOutput } from '../../../../packages/therapist/output.mjs';
import { createQueryExecutor } from './queries.mjs';

const nowIso = (value) => (value instanceof Date ? value : new Date(value)).toISOString();
const json = (value) => JSON.stringify(value);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class WorkerError extends Error {
  constructor(code, metadata = {}) { super(code); this.name = 'WorkerError'; this.code = code; Object.assign(this, metadata); }
}

async function first(db, sql, ...values) { return db.prepare(sql).bind(...values).first(); }
async function all(db, sql, ...values) {
  const result = await db.prepare(sql).bind(...values).all();
  if (!result || !Array.isArray(result.results)) throw new Error('storage_result_invalid');
  return result.results;
}
async function run(db, sql, ...values) { return db.prepare(sql).bind(...values).run(); }

async function latestThread(db, spaceId, threadId, snapshot) {
  return first(db, `SELECT message_seq, status, title, summary FROM thread_versions
    WHERE space_id = ? AND thread_id = ? AND message_seq <= ?
      AND message_seq = (SELECT MAX(v.message_seq) FROM thread_versions v WHERE v.space_id = ? AND v.thread_id = ? AND v.message_seq <= ?)
    LIMIT 1`, spaceId, threadId, snapshot, spaceId, threadId, snapshot);
}

async function currentPrinciples(db, spaceId, snapshot) {
  return all(db, `SELECT agreement_id, message_seq, version, text FROM agreement_versions a
    WHERE a.space_id = ? AND a.thread_id IS NULL AND a.message_seq <= ? AND a.confirmed = 1
      AND a.message_seq = (SELECT MAX(v.message_seq) FROM agreement_versions v
        WHERE v.space_id = a.space_id AND v.agreement_id = a.agreement_id AND v.message_seq <= ?)
    ORDER BY agreement_id`, spaceId, snapshot, snapshot);
}

async function currentSnapshot(db, spaceId) {
  const row = await first(db, 'SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE space_id = ?', spaceId);
  if (!row || !Number.isSafeInteger(row.seq) || row.seq < 0) throw new Error('storage_snapshot_invalid');
  return row.seq;
}

async function sourceRecord(db, task) {
  return first(db, `SELECT message_id, seq, space_id, thread_id, kind, actor_id, body_json, created_at
    FROM messages WHERE message_id = ? AND seq = ? AND space_id = ? AND thread_id = ? AND kind = 'member_expression'`,
  task.message_id, task.message_seq, task.space_id, task.thread_id);
}

function decodeText(bodyJson) {
  let body;
  try { body = JSON.parse(bodyJson); } catch { throw new Error('source_expression_invalid'); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.text !== 'string') throw new Error('source_expression_invalid');
  return body.text;
}

async function markObsolete(db, task, now, leaseId = null) {
  const expiredLease = task.status === 'running' && task.lease_expires_at <= now;
  if (task.status === 'running') {
    await run(db, `UPDATE therapist_tasks SET status = 'obsolete', lease_id = NULL, lease_expires_at = NULL,
      last_error_code = 'source_state_changed', last_error_at = ?
      WHERE message_id = ? AND status = 'running' AND lease_id = ? AND lease_expires_at ${expiredLease ? '<=' : '>'} ?`,
    now, task.message_id, leaseId, now);
    return;
  }
  await run(db, `UPDATE therapist_tasks SET status = 'obsolete', lease_id = NULL, lease_expires_at = NULL,
    last_error_code = 'source_state_changed', last_error_at = ? WHERE message_id = ? AND status = 'queued'`, now, task.message_id);
}

async function freezeRun({ db, task, config, actorId, now, leaseId }) {
  const prior = task.run_config_json ? JSON.parse(task.run_config_json) : null;
  if (prior) return prior;
  const snapshot = await currentSnapshot(db, task.space_id);
  const thread = await latestThread(db, task.space_id, task.thread_id, snapshot);
  const source = await sourceRecord(db, task);
  const members = await all(db, 'SELECT user_id, role FROM members WHERE space_id = ? ORDER BY user_id', task.space_id);
  if (!source || !task.input_thread_seq || task.input_thread_seq !== thread?.message_seq || thread.status !== 'active' ||
    members.length !== 2 || !members.some((member) => member.user_id === actorId) || !members.some((member) => member.user_id === source.actor_id)) {
    return null;
  }
  const principles = await currentPrinciples(db, task.space_id, snapshot);
  const runConfig = {
    model: config.model,
    skill_version: config.skill_version,
    instructions: config.instructions,
    output_schema: config.output_schema ?? THERAPIST_OUTPUT_SCHEMA,
    max_tool_calls: config.max_tool_calls,
    scope: {
      run_id: randomUUID(),
      actor_id: source.actor_id,
      space_id: task.space_id,
      thread_id: task.thread_id,
      consultation_thread_id: task.thread_id,
      snapshot_seq: snapshot,
      member_ids: members.map((member) => member.user_id),
      members: members.map(({ user_id, role }) => ({ user_id, role })),
      principles: principles.map(({ agreement_id, message_seq, version, text }) => ({ agreement_id, message_seq, version, text })),
    },
    ids: { reply: randomUUID(), understanding: randomUUID(), candidate: randomUUID() },
  };
  if (typeof runConfig.model !== 'string' || !runConfig.model || typeof runConfig.skill_version !== 'string' || !runConfig.skill_version ||
    typeof runConfig.instructions !== 'string' || !runConfig.instructions || !Number.isInteger(runConfig.max_tool_calls) || runConfig.max_tool_calls < 0) {
    throw new Error('worker_config_invalid');
  }
  const result = await run(db, `UPDATE therapist_tasks SET run_snapshot_seq = ?, run_config_json = ?, reply_message_id = ?,
      understanding_message_id = ?, candidate_id = ?
    WHERE message_id = ? AND lease_id = ? AND status = 'running' AND lease_expires_at > ? AND run_config_json IS NULL`,
  snapshot, json(runConfig), runConfig.ids.reply, runConfig.ids.understanding, runConfig.ids.candidate, task.message_id, leaseId, now);
  if (Number(result?.meta?.changes) !== 1) throw new WorkerError('worker_lease_lost');
  return runConfig;
}

function ownKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validateFrozenRunConfig(task, value, source) {
  if (!ownKeys(value, ['model', 'skill_version', 'instructions', 'output_schema', 'max_tool_calls', 'scope', 'ids']) ||
    typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 ||
    typeof value.skill_version !== 'string' || !value.skill_version.trim() || value.skill_version.length > 200 ||
    typeof value.instructions !== 'string' || !value.instructions.trim() || value.instructions.length > 100_000 ||
    !value.output_schema || typeof value.output_schema !== 'object' || Array.isArray(value.output_schema) ||
    !Number.isSafeInteger(value.max_tool_calls) || value.max_tool_calls < 0 || value.max_tool_calls > 100 ||
    !ownKeys(value.scope, ['run_id', 'actor_id', 'space_id', 'thread_id', 'consultation_thread_id', 'snapshot_seq', 'member_ids', 'members', 'principles']) ||
    !UUID.test(value.scope.run_id) || value.scope.actor_id !== source.actor_id || value.scope.space_id !== task.space_id ||
    value.scope.thread_id !== task.thread_id || value.scope.consultation_thread_id !== task.thread_id ||
    !Number.isSafeInteger(value.scope.snapshot_seq) || value.scope.snapshot_seq < task.message_seq ||
    value.scope.snapshot_seq !== task.run_snapshot_seq || !Array.isArray(value.scope.members) || value.scope.members.length !== 2 ||
    !Array.isArray(value.scope.member_ids) || value.scope.member_ids.length !== 2 ||
    !Array.isArray(value.scope.principles) || !ownKeys(value.ids, ['reply', 'understanding', 'candidate']) ||
    value.ids.reply !== task.reply_message_id || value.ids.understanding !== task.understanding_message_id || value.ids.candidate !== task.candidate_id ||
    !UUID.test(value.ids.reply) || !UUID.test(value.ids.understanding) || !UUID.test(value.ids.candidate)) throw new WorkerError('run_config_invalid');
  const memberIds = [];
  for (const member of value.scope.members) {
    if (!ownKeys(member, ['user_id', 'role']) || typeof member.user_id !== 'string' || !member.user_id.trim() ||
      typeof member.role !== 'string' || !member.role.trim()) throw new WorkerError('run_config_invalid');
    memberIds.push(member.user_id);
  }
  if (new Set(memberIds).size !== 2 || memberIds.join('\0') !== value.scope.member_ids.join('\0') || !memberIds.includes(source.actor_id)) {
    throw new WorkerError('run_config_invalid');
  }
  for (const principle of value.scope.principles) {
    if (!ownKeys(principle, ['agreement_id', 'message_seq', 'version', 'text']) || typeof principle.agreement_id !== 'string' ||
      !principle.agreement_id || !Number.isSafeInteger(principle.message_seq) || principle.message_seq <= 0 ||
      !Number.isSafeInteger(principle.version) || principle.version <= 0 || typeof principle.text !== 'string') throw new WorkerError('run_config_invalid');
  }
  return value;
}

async function claim({ db, spaceId, actorId, config, now, leaseMs, taskMessageId = null }) {
  const candidate = await first(db, `SELECT * FROM therapist_tasks
    WHERE space_id = ? AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= ?))
      AND (? IS NULL OR message_id = ?)
      AND NOT EXISTS (SELECT 1 FROM therapist_tasks active WHERE active.space_id = therapist_tasks.space_id
        AND active.thread_id = therapist_tasks.thread_id AND active.status = 'running' AND active.lease_expires_at > ?)
    ORDER BY message_seq, message_id LIMIT 1`, spaceId, now, taskMessageId, taskMessageId, now);
  if (!candidate) return null;
  const leaseId = randomUUID();
  const expiry = nowIso(new Date(Date.parse(now) + leaseMs));
  let frozen = null;
  try { frozen = candidate.run_config_json ? JSON.parse(candidate.run_config_json) : null; }
  catch {
    await run(db, `UPDATE therapist_tasks SET status='failed', lease_id=NULL, lease_expires_at=NULL,
      last_error_code='run_config_invalid', last_error_at=? WHERE message_id=? AND
      (status='queued' OR (status='running' AND lease_expires_at <= ?))`, now, candidate.message_id, now);
    return { status: 'failed', message_id: candidate.message_id, error_code: 'run_config_invalid' };
  }
  const snapshot = await currentSnapshot(db, candidate.space_id);
  const existing = await latestThread(db, candidate.space_id, candidate.thread_id, snapshot);
  const source = await sourceRecord(db, candidate);
  const members = await all(db, 'SELECT user_id, role FROM members WHERE space_id = ? ORDER BY user_id', candidate.space_id);
  if (!source || !candidate.input_thread_seq || candidate.input_thread_seq !== existing?.message_seq || existing.status !== 'active' ||
    members.length !== 2 || !members.some((member) => member.user_id === actorId) || !members.some((member) => member.user_id === source.actor_id) ||
    (frozen?.scope && frozen.scope.actor_id !== source.actor_id)) {
    await markObsolete(db, candidate, now, candidate.status === 'running' ? candidate.lease_id : null);
    return { status: 'obsolete', message_id: candidate.message_id };
  }
  const result = await run(db, `UPDATE therapist_tasks SET status = 'running', lease_id = ?, lease_expires_at = ?,
      last_error_code = NULL, last_error_status = NULL, last_error_request_id = NULL, last_error_at = NULL
    WHERE message_id = ? AND space_id = ? AND (status = 'queued' OR (status = 'running' AND lease_expires_at <= ?))
      AND NOT EXISTS (SELECT 1 FROM therapist_tasks active WHERE active.space_id = therapist_tasks.space_id
        AND active.thread_id = therapist_tasks.thread_id AND active.status = 'running' AND active.lease_expires_at > ?)`
  , leaseId, expiry, candidate.message_id, spaceId, now, now);
  if (Number(result?.meta?.changes) !== 1) return null;
  const task = await first(db, 'SELECT * FROM therapist_tasks WHERE message_id = ? AND lease_id = ? AND status = \'running\'', candidate.message_id, leaseId);
  if (!task) return null;
  const runConfig = frozen && Object.keys(frozen).length ? frozen : await freezeRun({ db, task, config, actorId, now, leaseId });
  if (!runConfig) {
    await markObsolete(db, task, now, leaseId);
    return { status: 'obsolete', message_id: task.message_id };
  }
  const current = await first(db, 'SELECT * FROM therapist_tasks WHERE message_id = ? AND lease_id = ?', task.message_id, leaseId);
  try { validateFrozenRunConfig(current, runConfig, source); }
  catch {
    await run(db, `UPDATE therapist_tasks SET status='failed', lease_id=NULL, lease_expires_at=NULL,
      last_error_code='run_config_invalid', last_error_at=? WHERE message_id=? AND status='running' AND lease_id=?`, now, task.message_id, leaseId);
    return { status: 'failed', message_id: task.message_id, error_code: 'run_config_invalid' };
  }
  if (!await verifyCurrentState(db, current, runConfig)) {
    await markObsolete(db, current, now, leaseId);
    return { status: 'obsolete', message_id: current.message_id };
  }
  return { task: current, lease_id: leaseId, expiry, run_config: runConfig };
}

async function verifyCurrentState(db, task, config) {
  const snapshot = await currentSnapshot(db, task.space_id);
  const thread = await latestThread(db, task.space_id, task.thread_id, snapshot);
  const members = await all(db, 'SELECT user_id, role FROM members WHERE space_id = ? ORDER BY user_id', task.space_id);
  const principles = await currentPrinciples(db, task.space_id, snapshot);
  return Boolean(thread && thread.status === 'active' && thread.message_seq === task.input_thread_seq && task.input_thread_seq > 0 &&
    members.length === 2 && members.every((member, index) => member.user_id === config.scope.members[index].user_id && member.role === config.scope.members[index].role) &&
    json(principles) === json(config.scope.principles));
}

async function saveCheckpoint(db, task, leaseId, now, leaseMs, checkpoint) {
  const checkpointJson = json(checkpoint);
  if (new TextEncoder().encode(checkpointJson).byteLength > 1_000_000) throw new WorkerError('checkpoint_budget_exceeded');
  const nextExpiry = nowIso(new Date(Date.parse(now) + leaseMs));
  const result = await run(db, `UPDATE therapist_tasks SET checkpoint_json = ?, lease_expires_at = ?
    WHERE message_id = ? AND status = 'running' AND lease_id = ? AND lease_expires_at > ?`,
  checkpointJson, nextExpiry, task.message_id, leaseId, now);
  if (Number(result?.meta?.changes) !== 1) throw new WorkerError('worker_lease_lost');
}

async function evidenceContext(db, task, config) {
  const messages = await all(db, `SELECT message_id, space_id, thread_id, seq, kind, actor_id
    FROM messages WHERE space_id = ? AND thread_id = ? AND seq <= ? AND kind = 'member_expression' ORDER BY seq`,
  task.space_id, task.thread_id, config.scope.snapshot_seq);
  return { space_id: task.space_id, thread_id: task.thread_id, snapshot_seq: config.scope.snapshot_seq,
    member_ids: config.scope.member_ids, messages };
}

function safeFailure(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/i.test(error.code) ? error.code : 'orchestration_failed';
  if (code === 'worker_lease_lost') return null;
  const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null;
  const requestId = typeof error?.request_id === 'string' && /^[\w.-]{1,128}$/.test(error.request_id) ? error.request_id : null;
  return { code, status, request_id: requestId };
}

async function failOwned(db, task, leaseId, now, error) {
  const code = safeFailure(error);
  if (!code) return;
  await run(db, `UPDATE therapist_tasks SET status='failed', lease_id=NULL, lease_expires_at=NULL,
      last_error_code=?, last_error_status=?, last_error_request_id=?, last_error_at=?
    WHERE message_id=? AND status='running' AND lease_id=? AND lease_expires_at > ?`,
  code.code, code.status, code.request_id, now, task.message_id, leaseId, now);
}

const RETRYABLE_PROVIDER_CODES = new Set(['credit_balance_exhausted', 'rate_limit_exceeded', 'provider_http_error', 'provider_transport_error']);

/** Requeues one failed task after an explicit authenticated retry request; its checkpoint and frozen run remain unchanged. */
export async function retryFailedTherapistTask({ db, space_id: spaceId, actor_id: actorId, message_id: messageId, now = new Date() }) {
  const timestamp = nowIso(typeof now === 'function' ? now() : now);
  if (!UUID.test(messageId ?? '')) return { status: 'invalid' };
  const member = await first(db, 'SELECT 1 AS present FROM members WHERE space_id=? AND user_id=?', spaceId, actorId);
  if (!member) return { status: 'not_found' };
  const task = await first(db, `SELECT * FROM therapist_tasks WHERE message_id=? AND space_id=? AND status='failed'`, messageId, spaceId);
  if (!task) return { status: 'not_found' };
  const retryable = RETRYABLE_PROVIDER_CODES.has(task.last_error_code) || task.last_error_status === 429 ||
    (Number.isInteger(task.last_error_status) && task.last_error_status >= 500 && task.last_error_status <= 599);
  if (!retryable || task.retry_count >= 3 || !task.checkpoint_json || !task.run_config_json) {
    return { status: 'retry_unavailable', message_id: messageId, error_code: task.last_error_code ?? 'retry_limit_reached' };
  }
  const source = await sourceRecord(db, task);
  try { validateFrozenRunConfig(task, JSON.parse(task.run_config_json), source); }
  catch { return { status: 'retry_unavailable', message_id: messageId, error_code: 'run_config_invalid' }; }
  const result = await run(db, `UPDATE therapist_tasks SET status='queued', retry_count=retry_count+1
    WHERE message_id=? AND space_id=? AND status='failed' AND retry_count=? AND retry_count<3
      AND checkpoint_json IS NOT NULL AND run_config_json IS NOT NULL`, messageId, spaceId, task.retry_count);
  if (Number(result?.meta?.changes) !== 1) return { status: 'retry_unavailable', message_id: messageId, error_code: 'retry_state_changed' };
  return { status: 'queued', message_id: messageId, retry_count: task.retry_count + 1, accepted_at: timestamp };
}

async function publish({ db, task, leaseId, now, config, output }) {
  const context = await evidenceContext(db, task, config);
  const validated = validateTherapistOutput(output, context);
  const finalNow = nowIso(now);
  const sourceIds = [...new Set(validated.source_message_ids)];
  const replyBody = json({ text: validated.reply, source_message_ids: validated.source_message_ids,
    model: config.model, skill_version: config.skill_version, run_snapshot_seq: config.scope.snapshot_seq });
  const understandingBody = json({ common_points: validated.common_points, differences: validated.differences,
    hypotheses: validated.hypotheses, consensus_proposal: validated.consensus_proposal,
    candidate_id: config.ids.candidate, candidate_status: validated.consensus_proposal ? 'unconfirmed' : null,
    source_message_ids: sourceIds, model: config.model, skill_version: config.skill_version, run_snapshot_seq: config.scope.snapshot_seq });
  const members = config.scope.members;
  const statements = [
    db.prepare(`UPDATE therapist_tasks SET status='completed', lease_id=NULL, lease_expires_at=NULL,
      completion_lease_id=?, checkpoint_json=NULL, last_error_code=NULL, last_error_status=NULL,
      last_error_request_id=NULL, last_error_at=NULL
      WHERE message_id=? AND status='running' AND lease_id=? AND lease_expires_at > ? AND input_thread_seq=?
        AND EXISTS (SELECT 1 FROM thread_versions t WHERE t.space_id=? AND t.thread_id=? AND t.message_seq=? AND t.status='active'
          AND t.message_seq=(SELECT MAX(v.message_seq) FROM thread_versions v WHERE v.space_id=t.space_id AND v.thread_id=t.thread_id))
        AND (SELECT COUNT(*) FROM members WHERE space_id=?)=2
        AND EXISTS (SELECT 1 FROM members WHERE space_id=? AND user_id=? AND role=?)
        AND EXISTS (SELECT 1 FROM members WHERE space_id=? AND user_id=? AND role=?)
        AND (SELECT json_group_array(json_object('agreement_id', p.agreement_id, 'message_seq', p.message_seq, 'version', p.version, 'text', p.text))
          FROM (SELECT a.agreement_id, a.message_seq, a.version, a.text FROM agreement_versions a WHERE a.space_id=? AND a.thread_id IS NULL AND a.confirmed=1
            AND a.message_seq=(SELECT MAX(v.message_seq) FROM agreement_versions v WHERE v.space_id=a.space_id AND v.agreement_id=a.agreement_id)
            ORDER BY a.agreement_id) p) = ?`)
      .bind(leaseId, task.message_id, leaseId, finalNow, task.input_thread_seq, task.space_id, task.thread_id, task.input_thread_seq,
        task.space_id, task.space_id, members[0].user_id, members[0].role, task.space_id, members[1].user_id, members[1].role,
        task.space_id, json(config.scope.principles)),
    db.prepare(`INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at)
      SELECT CASE WHEN EXISTS(SELECT 1 FROM therapist_tasks WHERE message_id=? AND status='completed' AND completion_lease_id=? AND reply_message_id=?) THEN ? ELSE NULL END,
        ?,?, 'therapist_reply','therapist',?,?`)
      .bind(task.message_id, leaseId, config.ids.reply, config.ids.reply, task.space_id, task.thread_id, replyBody, finalNow),
    db.prepare(`INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at)
      SELECT CASE WHEN EXISTS(SELECT 1 FROM therapist_tasks t INNER JOIN messages r ON r.message_id=t.reply_message_id
          WHERE t.message_id=? AND t.status='completed' AND t.completion_lease_id=? AND t.understanding_message_id=?
            AND r.kind='therapist_reply' AND r.message_id=?) THEN ? ELSE NULL END,
        ?,?, 'understanding_updated','therapist',?,?`)
      .bind(task.message_id, leaseId, config.ids.understanding, config.ids.reply, config.ids.understanding,
        task.space_id, task.thread_id, understandingBody, finalNow),
    db.prepare(`UPDATE therapist_tasks SET status='completed', covered_by=?
      WHERE space_id=? AND thread_id=? AND message_id<>? AND status='queued' AND input_thread_seq=? AND message_seq<=?
        AND EXISTS (SELECT 1 FROM therapist_tasks leader INNER JOIN messages r ON r.message_id=leader.reply_message_id
          INNER JOIN messages u ON u.message_id=leader.understanding_message_id
          WHERE leader.message_id=? AND leader.status='completed' AND leader.completion_lease_id=?
            AND r.kind='therapist_reply' AND u.kind='understanding_updated')`)
      .bind(task.message_id, task.space_id, task.thread_id, task.message_id, task.input_thread_seq, config.scope.snapshot_seq, task.message_id, leaseId),
  ];
  try {
    const result = await db.batch(statements);
    if (!Array.isArray(result) || result.length !== statements.length || Number(result[0]?.meta?.changes) !== 1 ||
      Number(result[1]?.meta?.changes) !== 1 || Number(result[2]?.meta?.changes) !== 1) throw new WorkerError('publish_result_invalid');
  } catch (error) {
    const owner = await first(db, `SELECT 1 AS active FROM therapist_tasks WHERE message_id=? AND status='running'
      AND lease_id=? AND lease_expires_at > ?`, task.message_id, leaseId, finalNow);
    if (!owner) throw new WorkerError('worker_lease_lost');
    const collision = await first(db, 'SELECT message_id FROM messages WHERE message_id IN (?,?) LIMIT 1', config.ids.reply, config.ids.understanding);
    if (collision) throw new WorkerError('output_uuid_collision');
    if (!await verifyCurrentState(db, task, config)) throw new WorkerError('source_state_changed');
    if (error instanceof WorkerError) throw error;
    throw new WorkerError('publish_transaction_failed');
  }
  return { status: 'completed', message_id: task.message_id, reply_message_id: config.ids.reply,
    understanding_message_id: config.ids.understanding, snapshot_seq: config.scope.snapshot_seq };
}

/** @param {{db: any, space_id: string, actor_id: string, config: any, request: (payload: any) => Promise<any>, task_message_id?: string | null, now?: Date | (() => Date), lease_ms?: number}} options
 * Claims and runs one accepted expression using only the injected, trusted server config.
 */
export async function runNextTherapistTask({ db, space_id: spaceId, actor_id: actorId, config, request, task_message_id: taskMessageId = null, now = new Date(), lease_ms: leaseMs = 120_000 }) {
  if (!db || typeof db.prepare !== 'function' || typeof spaceId !== 'string' || !spaceId || typeof actorId !== 'string' || !actorId ||
    !config || typeof request !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 ||
    (taskMessageId !== null && !UUID.test(taskMessageId))) throw new Error('worker_config_invalid');
  const clock = typeof now === 'function' ? now : () => new Date(now);
  const nowText = nowIso(clock());
  const claimed = await claim({ db, spaceId, actorId, config, now: nowText, leaseMs, taskMessageId });
  if (!claimed) return { status: 'idle' };
  if (!claimed.task) return claimed;
  const { task, lease_id: leaseId, run_config: runConfig } = claimed;
  try {
    const turnScope = runConfig.scope;
    const executor = createQueryExecutor(db);
    const source = await sourceRecord(db, task);
    const text = decodeText(source.body_json);
    const sourceMember = runConfig.scope.members.find((member) => member.user_id === source.actor_id);
    const memberDescription = runConfig.scope.members.map(({ user_id, role }) => `${user_id} (${role})`).join('; ');
    const started = await runTherapistTurn({
      model: runConfig.model, instructions: runConfig.instructions,
      input: [{ role: 'user', content: `Process this confirmed expression in the current consultation. Expression UUID: ${task.message_id}. Author member identity: ${source.actor_id}; role: ${sourceMember?.role ?? 'unknown'}. Current two member identities and roles: ${memberDescription}. Exact expression text: ${text}` }],
      scope: turnScope, maxToolCalls: runConfig.max_tool_calls, outputSchema: runConfig.output_schema,
      request, executeTool: (name, args, scope) => executor(name, args, { ...scope, purpose: 'therapist' }),
      saveCheckpoint: (checkpoint) => saveCheckpoint(db, task, leaseId, nowIso(clock()), leaseMs, checkpoint),
      checkpoint: task.checkpoint_json ? JSON.parse(task.checkpoint_json) : undefined,
    });
    if (started.status !== 'completed') {
      const owner = await first(db, 'SELECT 1 AS active FROM therapist_tasks WHERE message_id=? AND status=\'running\' AND lease_id=? AND lease_expires_at > ?', task.message_id, leaseId, nowIso(clock()));
      if (!owner) return { status: 'failed', message_id: task.message_id, error_code: 'worker_lease_lost' };
      const err = started.error ?? new Error('therapist_turn_failed');
      await failOwned(db, task, leaseId, nowIso(clock()), err);
      const failure = safeFailure(err);
      return { status: 'failed', message_id: task.message_id, error_code: failure?.code ?? 'worker_lease_lost',
        error_status: failure?.status ?? null, error_request_id: failure?.request_id ?? null };
    }
    const finishTime = nowIso(clock());
    if (!await verifyCurrentState(db, task, runConfig)) {
      await run(db, `UPDATE therapist_tasks SET status='obsolete', lease_id=NULL, lease_expires_at=NULL, checkpoint_json=NULL,
        last_error_code='source_state_changed', last_error_at=? WHERE message_id=? AND status='running' AND lease_id=? AND lease_expires_at > ?`,
      finishTime, task.message_id, leaseId, finishTime);
      return { status: 'obsolete', message_id: task.message_id };
    }
    try { return await publish({ db, task, leaseId, now: finishTime, config: runConfig, output: started.output }); }
    catch (error) {
      if (error?.name === 'TherapistOutputValidationError') {
        await failOwned(db, task, leaseId, nowIso(clock()), Object.assign(new Error(), { code: 'invalid_output' }));
        return { status: 'failed', message_id: task.message_id, error_code: 'invalid_output' };
      }
      if (error?.code === 'source_state_changed') {
        await run(db, `UPDATE therapist_tasks SET status='obsolete', lease_id=NULL, lease_expires_at=NULL, checkpoint_json=NULL,
          last_error_code='source_state_changed', last_error_at=? WHERE message_id=? AND status='running' AND lease_id=? AND lease_expires_at > ?`,
        nowIso(clock()), task.message_id, leaseId, nowIso(clock()));
        return { status: 'obsolete', message_id: task.message_id };
      }
      throw error;
    }
  } catch (error) {
    await failOwned(db, task, leaseId, nowIso(clock()), error);
    const failure = safeFailure(error);
    return { status: 'failed', message_id: task.message_id, error_code: failure?.code ?? 'worker_lease_lost',
      error_status: failure?.status ?? null, error_request_id: failure?.request_id ?? null };
  }
}
