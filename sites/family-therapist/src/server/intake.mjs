import { z } from 'zod';

export const MAX_INTAKE_BODY_BYTES = 64 * 1024;

const uuid = z.string().uuid();
const expressionCommandSchema = z.object({
  message_id: uuid,
  thread_id: uuid,
  expected_thread_seq: z.number().int().positive().safe(),
  text: z.string().refine((value) => value.trim().length > 0, 'Expression text must not be blank')
    .refine((value) => new TextEncoder().encode(value).byteLength < MAX_INTAKE_BODY_BYTES, 'Expression text is too large'),
  confirmed: z.literal(true),
}).strict();

export class IntakeError extends Error {
  constructor(code, status, message, options) {
    super(message, options);
    this.name = 'IntakeError';
    this.code = code;
    this.status = status;
  }
}

export function validateExpressionCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new IntakeError('invalid_command', 400, 'A plain expression request object is required.');
  }
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new IntakeError('invalid_command', 400, 'Expression request contains a forbidden property.');
    }
  }
  const result = expressionCommandSchema.safeParse(value);
  if (!result.success) throw new IntakeError('invalid_command', 400, 'The confirmed expression request is invalid.');
  return result.data;
}

function assertScope(scope) {
  if (!scope || typeof scope.actor_id !== 'string' || !scope.actor_id || typeof scope.space_id !== 'string' || !scope.space_id) {
    throw new IntakeError('invalid_scope', 400, 'Authenticated member scope is required.');
  }
}

async function first(db, sql, ...values) {
  return db.prepare(sql).bind(...values).first();
}

async function requireMembership(db, scope) {
  const row = await first(db, 'SELECT 1 AS allowed FROM members WHERE space_id = ? AND user_id = ? LIMIT 1', scope.space_id, scope.actor_id);
  if (!row) throw new IntakeError('membership_required', 403, 'Current membership in this shared space is required.');
}

function payloadText(row) {
  let body;
  try { body = JSON.parse(row.body_json); }
  catch (error) { throw new IntakeError('persistence_invalid', 503, 'The saved expression could not be read.', { cause: error }); }
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.text !== 'string') {
    throw new IntakeError('persistence_invalid', 503, 'The saved expression could not be read.');
  }
  return body.text;
}

function sameMessage(row, { scope, command, bodyJson }) {
  return row && row.space_id === scope.space_id && row.actor_id === scope.actor_id && row.thread_id === command.thread_id
    && row.kind === 'member_expression' && row.body_json === bodyJson;
}

function receiptFromRows(message, task, duplicate) {
  if (!message || !task || task.message_seq !== message.seq || task.space_id !== message.space_id || task.thread_id !== message.thread_id || task.status !== 'queued') {
    throw new IntakeError('persistence_incomplete', 503, 'The expression was not fully queued; no receipt is available.');
  }
  return {
    message_id: message.message_id,
    thread_id: message.thread_id,
    seq: message.seq,
    created_at: message.created_at,
    text: payloadText(message),
    task_status: task.status,
    duplicate,
  };
}

async function findExisting(db, scope, command, bodyJson) {
  const row = await first(db, `SELECT message_id, seq, space_id, thread_id, kind, actor_id, body_json, created_at
    FROM messages WHERE message_id = ?`, command.message_id);
  if (!row) return null;
  if (!sameMessage(row, { scope, command, bodyJson })) {
    throw new IntakeError('message_conflict', 409, 'This message UUID is already in use.');
  }
  const task = await first(db, 'SELECT message_id, message_seq, space_id, thread_id, status, created_at FROM therapist_tasks WHERE message_id = ?', command.message_id);
  if (!task) throw new IntakeError('persistence_incomplete', 503, 'The saved expression has no complete queued receipt.');
  return receiptFromRows(row, task, true);
}

async function currentThreadVersion(db, scope, command) {
  const row = await first(db, `SELECT tv.message_seq, tv.status
    FROM thread_versions tv
    WHERE tv.space_id = ? AND tv.thread_id = ?
      AND tv.message_seq = (SELECT MAX(v.message_seq) FROM thread_versions v WHERE v.space_id = tv.space_id AND v.thread_id = tv.thread_id)
    LIMIT 1`, scope.space_id, command.thread_id);
  if (!row) throw new IntakeError('thread_not_found', 404, 'No such discussion exists in the current shared space.');
  if (row.status !== 'active') throw new IntakeError('thread_not_active', 409, 'Expressions can only be submitted to the current active discussion.');
  if (row.message_seq !== command.expected_thread_seq) throw new IntakeError('stale_thread', 409, 'The discussion changed. Refresh it before submitting the confirmed expression.');
}

export async function submitConfirmedExpression({ db, scope, command: rawCommand, now = () => new Date().toISOString() }) {
  const command = validateExpressionCommand(rawCommand);
  assertScope(scope);
  await requireMembership(db, scope);
  const bodyJson = JSON.stringify({ text: command.text });

  const prior = await findExisting(db, scope, command, bodyJson);
  if (prior) return prior;
  await currentThreadVersion(db, scope, command);

  const createdAt = now();
  const messageInsert = db.prepare(`INSERT INTO messages(message_id, space_id, thread_id, kind, actor_id, body_json, created_at)
    SELECT ?, ?, ?, 'member_expression', ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM members WHERE space_id = ? AND user_id = ?)
      AND EXISTS (SELECT 1 FROM thread_versions tv WHERE tv.space_id = ? AND tv.thread_id = ? AND tv.message_seq = ? AND tv.status = 'active'
        AND tv.message_seq = (SELECT MAX(v.message_seq) FROM thread_versions v WHERE v.space_id = tv.space_id AND v.thread_id = tv.thread_id))
    ON CONFLICT(message_id) DO NOTHING`)
    .bind(command.message_id, scope.space_id, command.thread_id, scope.actor_id, bodyJson, createdAt,
      scope.space_id, scope.actor_id, scope.space_id, command.thread_id, command.expected_thread_seq);
  const taskInsert = db.prepare(`INSERT INTO therapist_tasks(message_id, message_seq, space_id, thread_id, status, created_at)
    SELECT m.message_id, m.seq, m.space_id, m.thread_id, 'queued', ?
    FROM messages m
    WHERE m.message_id = ? AND m.space_id = ? AND m.actor_id = ? AND m.thread_id = ? AND m.kind = 'member_expression' AND m.body_json = ?
      AND EXISTS (SELECT 1 FROM members WHERE space_id = ? AND user_id = ?)
    ON CONFLICT(message_id) DO NOTHING`)
    .bind(createdAt, command.message_id, scope.space_id, scope.actor_id, command.thread_id, bodyJson, scope.space_id, scope.actor_id);
  let insertedMessage;
  try {
    const results = await db.batch([messageInsert, taskInsert]);
    if (!Array.isArray(results) || results.length !== 2) throw new Error('D1 batch returned an incomplete result set');
    const messageChanges = Number(results[0]?.meta?.changes);
    if (!Number.isSafeInteger(messageChanges) || messageChanges < 0 || messageChanges > 1) throw new Error('D1 batch returned an invalid message result');
    insertedMessage = messageChanges === 1;
  } catch (error) {
    throw new IntakeError('persistence_failed', 503, 'The expression could not be saved and queued atomically.', { cause: error });
  }

  const message = await first(db, `SELECT message_id, seq, space_id, thread_id, kind, actor_id, body_json, created_at
    FROM messages WHERE message_id = ?`, command.message_id);
  if (message && !sameMessage(message, { scope, command, bodyJson })) {
    throw new IntakeError('message_conflict', 409, 'This message UUID is already in use.');
  }
  if (!message) {
    const exists = await first(db, 'SELECT 1 AS present FROM messages WHERE message_id = ?', command.message_id);
    if (exists) throw new IntakeError('message_conflict', 409, 'This message UUID is already in use.');
    throw new IntakeError('intake_rejected', 409, 'Membership or discussion status changed before the expression was saved. Refresh and try again.');
  }
  const task = await first(db, 'SELECT message_id, message_seq, space_id, thread_id, status, created_at FROM therapist_tasks WHERE message_id = ?', command.message_id);
  return receiptFromRows(message, task, !insertedMessage);
}

export async function getExpressionReceipt({ db, scope, messageId }) {
  assertScope(scope);
  const parsedId = uuid.safeParse(messageId);
  if (!parsedId.success) throw new IntakeError('invalid_message_id', 400, 'A message UUID is required.');
  await requireMembership(db, scope);
  const message = await first(db, `SELECT message_id, seq, space_id, thread_id, kind, actor_id, body_json, created_at
    FROM messages WHERE message_id = ? AND space_id = ? AND actor_id = ? AND kind = 'member_expression'`, messageId, scope.space_id, scope.actor_id);
  if (!message) return null;
  const task = await first(db, 'SELECT message_id, message_seq, space_id, thread_id, status, created_at FROM therapist_tasks WHERE message_id = ?', messageId);
  return receiptFromRows(message, task, false);
}
