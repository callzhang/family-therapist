import { QueryReadError } from './queries.mjs';
import { TOOL_DEFINITIONS, validateToolArguments } from '../../../../packages/therapist/tools.mjs';

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 100;
const updateFields = new Set(['after_message_id', 'limit', 'snapshot_seq']);
const queryNames = new Set(TOOL_DEFINITIONS.map(({ name }) => name));

const errorText = Object.freeze({
  invalid_updates_request: '更新请求格式无效。',
  unsupported_query: '不支持此读取请求。',
  invalid_query: '查询参数格式无效。',
  storage_unavailable: '共同空间暂时无法读取，请稍后重试。',
});

const queryErrorText = Object.freeze({
  invalid_scope: '读取范围无效。',
  unsupported_purpose: '不支持此读取方式。',
  unsupported_query: '不支持此读取请求。',
  membership_required: '当前账号尚未加入共同空间。',
  transcript_forbidden: '这段对话当前不可读取。',
  thread_not_found: '共同空间中没有找到这段对话。',
  message_not_found: '共同空间中没有找到这条记录。',
  invalid_cursor: '读取位置已失效，请重新开始同步。',
  agreement_thread_not_found: '共同空间中没有找到相关议题。',
  invalid_result_set: '共同空间暂时无法读取，请稍后重试。',
  invalid_message_json: '一条已保存记录无法正常解析，请联系维护者。',
  invalid_record: '一条已保存记录格式无效，请联系维护者。',
});

export class AgentReadError extends Error {
  constructor(code, status, options) {
    super(errorText[code] ?? '读取请求暂时无法处理。', options);
    this.name = 'AgentReadError';
    this.code = code;
    this.status = status;
  }
}

export function agentReadErrorResponse(error) {
  if (error instanceof AgentReadError) {
    return Response.json({ code: error.code, error: errorText[error.code] }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
  }
  if (error instanceof QueryReadError) {
    return Response.json({ code: error.code, error: queryErrorText[error.code] ?? '读取失败，请稍后重试。' }, { status: error.status, headers: { 'Cache-Control': 'private, no-store' } });
  }
  return null;
}

function parseInteger(value, { minimum, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new AgentReadError('invalid_updates_request', 400);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new AgentReadError('invalid_updates_request', 400);
  return parsed;
}

export function parseSpaceUpdateParams(searchParams) {
  if (!(searchParams instanceof URLSearchParams)) throw new AgentReadError('invalid_updates_request', 400);
  for (const key of searchParams.keys()) {
    if (!updateFields.has(key) || searchParams.getAll(key).length !== 1) throw new AgentReadError('invalid_updates_request', 400);
  }
  const afterValues = searchParams.getAll('after_message_id');
  const afterMessageId = afterValues[0] ?? null;
  if (afterMessageId !== null) {
    try { validateToolArguments('get_message', { message_id: afterMessageId }); }
    catch { throw new AgentReadError('invalid_updates_request', 400); }
  }
  const limitValues = searchParams.getAll('limit');
  const limit = limitValues.length ? parseInteger(limitValues[0], { minimum: 1, maximum: MAX_LIMIT }) : DEFAULT_LIMIT;
  const snapshotValues = searchParams.getAll('snapshot_seq');
  const snapshotSeq = snapshotValues.length ? parseInteger(snapshotValues[0], { minimum: 0 }) : null;
  return { after_message_id: afterMessageId, limit, snapshot_seq: snapshotSeq };
}

export function validateAgentQueryArguments(name, value) {
  if (typeof name !== 'string' || !queryNames.has(name)) throw new AgentReadError('unsupported_query', 400);
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new AgentReadError('invalid_query', 400);
  }
  try { return validateToolArguments(name, value); }
  catch { throw new AgentReadError('invalid_query', 400); }
}

function assertScope(scope) {
  if (!scope || typeof scope.actor_id !== 'string' || !scope.actor_id.trim() || typeof scope.space_id !== 'string' || !scope.space_id.trim() ||
    !Number.isSafeInteger(scope.snapshot_seq) || scope.snapshot_seq < 0) {
    throw new QueryReadError('invalid_scope', 'Updates scope must come from authenticated member context');
  }
  if (scope.purpose !== 'member_view') throw new QueryReadError('unsupported_purpose', 'Space updates are limited to member_view scope');
}

async function first(db, sql, ...values) {
  try { return await db.prepare(sql).bind(...values).first(); }
  catch (cause) { throw new AgentReadError('storage_unavailable', 503, { cause }); }
}

async function all(db, sql, ...values) {
  let result;
  try { result = await db.prepare(sql).bind(...values).all(); }
  catch (cause) { throw new AgentReadError('storage_unavailable', 503, { cause }); }
  if (!result || !Array.isArray(result.results)) throw new QueryReadError('invalid_result_set', 'D1 query returned an invalid result set');
  return result.results;
}

function parseMessage(row, spaceId, snapshotSeq) {
  if (!row || !Number.isSafeInteger(row.seq) || row.seq <= 0 || row.seq > snapshotSeq ||
    typeof row.space_id !== 'string' || row.space_id !== spaceId || (row.thread_id !== null && typeof row.thread_id !== 'string') || typeof row.kind !== 'string' || !row.kind ||
    typeof row.actor_id !== 'string' || !row.actor_id || typeof row.created_at !== 'string' || typeof row.body_json !== 'string') {
    throw new QueryReadError('invalid_record', 'D1 returned malformed message metadata');
  }
  try {
    validateToolArguments('get_message', { message_id: row.message_id });
    if (row.thread_id !== null) validateToolArguments('get_thread', { thread_id: row.thread_id });
  } catch (cause) {
    throw new QueryReadError('invalid_record', 'D1 returned a message with a malformed UUID', { cause });
  }
  let body;
  try { body = JSON.parse(row.body_json); }
  catch (cause) { throw new QueryReadError('invalid_message_json', `Message ${row.message_id} has invalid JSON body`, { cause }); }
  return {
    message_id: row.message_id,
    space_id: row.space_id,
    thread_id: row.thread_id,
    seq: row.seq,
    kind: row.kind,
    actor_id: row.actor_id,
    body,
    created_at: row.created_at,
  };
}

/** @param {{ db: any, scope: any, after_message_id?: string | null, limit?: number, snapshot_seq?: number | null }} options */
export async function getSpaceUpdates(options) {
  const { db, scope, after_message_id = null, limit = DEFAULT_LIMIT, snapshot_seq = null } = options;
  assertScope(scope);
  if (!db || typeof db.prepare !== 'function') throw new AgentReadError('storage_unavailable', 503);
  if (after_message_id !== null) {
    try { validateToolArguments('get_message', { message_id: after_message_id }); }
    catch { throw new AgentReadError('invalid_updates_request', 400); }
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT ||
    (snapshot_seq !== null && (!Number.isSafeInteger(snapshot_seq) || snapshot_seq < 0 || snapshot_seq > scope.snapshot_seq))) {
    throw new AgentReadError('invalid_updates_request', 400);
  }
  const snapshot = snapshot_seq ?? scope.snapshot_seq;

  const member = await first(db, 'SELECT 1 AS allowed FROM members WHERE space_id = ? AND user_id = ? LIMIT 1', scope.space_id, scope.actor_id);
  if (!member) throw new QueryReadError('membership_required', 'Actor membership is required for this space');
  if (member.allowed !== 1) throw new QueryReadError('invalid_result_set', 'D1 returned an invalid membership result');

  let cursorSeq = null;
  if (after_message_id !== null) {
    const cursor = await first(db, `SELECT seq FROM messages WHERE space_id = ? AND message_id = ? AND seq <= ?`, scope.space_id, after_message_id, snapshot);
    if (!cursor || !Number.isSafeInteger(cursor.seq) || cursor.seq <= 0) throw new QueryReadError('invalid_cursor', 'Unknown or out-of-scope updates cursor');
    cursorSeq = cursor.seq;
  }

  const found = await all(db, `SELECT seq, message_id, space_id, thread_id, kind, actor_id, body_json, created_at
    FROM messages WHERE space_id = ? AND seq <= ? AND (? IS NULL OR seq > ?)
    ORDER BY seq ASC LIMIT ?`, scope.space_id, snapshot, cursorSeq, cursorSeq, limit + 1);
  const page = found.slice(0, limit).map((row) => parseMessage(row, scope.space_id, snapshot));
  const hasMore = found.length > limit;
  return {
    items: page,
    next_after_id: page.at(-1)?.message_id ?? after_message_id,
    has_more: hasMore,
    snapshot_seq: snapshot,
  };
}
