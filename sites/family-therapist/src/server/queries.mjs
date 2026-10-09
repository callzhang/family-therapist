const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

function assertScope(scope) {
  if (!scope || typeof scope.space_id !== 'string' || typeof scope.actor_id !== 'string' || !Number.isSafeInteger(scope.snapshot_seq) || scope.snapshot_seq < 0) {
    throw new Error('Query scope requires authenticated actor_id, space_id, and snapshot_seq');
  }
  if (scope.purpose !== undefined && !['therapist', 'member_view'].includes(scope.purpose)) {
    throw new Error('Unsupported server query purpose');
  }
}

async function membership(db, scope) {
  const row = await db.prepare('SELECT 1 AS allowed FROM members WHERE space_id = ? AND user_id = ?').bind(scope.space_id, scope.actor_id).first();
  if (!row) throw new Error('Actor membership is required for this space');
}

function limitValue(value) {
  return Math.min(value ?? DEFAULT_LIMIT, MAX_LIMIT);
}

async function rows(db, sql, ...values) {
  const result = await db.prepare(sql).bind(...values).all();
  if (!result || !Array.isArray(result.results)) throw new Error('D1 query returned an invalid result set');
  return result.results;
}

async function one(db, sql, ...values) {
  return db.prepare(sql).bind(...values).first();
}

function parseMessage(row) {
  let body;
  try { body = JSON.parse(row.body_json); }
  catch (error) { throw new Error(`Message ${row.message_id} has invalid JSON body`, { cause: error }); }
  return { message_id: row.message_id, thread_id: row.thread_id, kind: row.kind, actor_id: row.actor_id, body, created_at: row.created_at, seq: row.seq };
}

function threadResult(row) {
  return { thread_id: row.thread_id, title: row.title, status: row.status, summary: row.summary, message_seq: row.message_seq };
}
function agreementResult(row) {
  return { agreement_id: row.agreement_id, thread_id: row.thread_id, version: row.version, text: row.text, message_seq: row.message_seq };
}

async function latestThread(db, scope, threadId) {
  return one(db, `SELECT tv.thread_id, tv.message_seq, tv.title, tv.status, tv.summary
    FROM thread_versions tv
    WHERE tv.space_id = ? AND tv.thread_id = ? AND tv.message_seq <= ?
      AND tv.message_seq = (SELECT MAX(v.message_seq) FROM thread_versions v WHERE v.space_id = tv.space_id AND v.thread_id = tv.thread_id AND v.message_seq <= ?)
    LIMIT 1`, scope.space_id, threadId, scope.snapshot_seq, scope.snapshot_seq);
}

function transcriptAllowed(scope, threadId, thread) {
  if (scope.purpose === 'member_view') return;
  if (threadId !== scope.consultation_thread_id) throw new Error('Transcript access is limited to the consultation thread');
  if (thread?.status === 'settled') throw new Error('Settled consultation transcripts are unavailable');
}

async function listThreads(db, args, scope) {
  let cursor = null;
  if (args.after_thread_id) {
    cursor = await one(db, `SELECT tv.message_seq, tv.thread_id FROM thread_versions tv
      WHERE tv.space_id = ? AND tv.thread_id = ? AND tv.message_seq <= ?
        AND tv.message_seq = (SELECT MAX(v.message_seq) FROM thread_versions v WHERE v.space_id = tv.space_id AND v.thread_id = tv.thread_id AND v.message_seq <= ?)
        AND (? IS NULL OR tv.status = ?)`, scope.space_id, args.after_thread_id, scope.snapshot_seq, scope.snapshot_seq, args.status, args.status);
    if (!cursor) throw new Error('Unknown or out-of-scope thread cursor');
  }
  const limit = limitValue(args.limit);
  const found = await rows(db, `SELECT tv.thread_id, tv.message_seq, tv.title, tv.status, tv.summary
    FROM thread_versions tv
    WHERE tv.space_id = ? AND tv.message_seq <= ?
      AND tv.message_seq = (SELECT MAX(v.message_seq) FROM thread_versions v WHERE v.space_id = tv.space_id AND v.thread_id = tv.thread_id AND v.message_seq <= ?)
      AND (? IS NULL OR tv.status = ?)
      AND (? IS NULL OR tv.message_seq > ? OR (tv.message_seq = ? AND tv.thread_id > ?))
    ORDER BY tv.message_seq ASC, tv.thread_id ASC LIMIT ?`, scope.space_id, scope.snapshot_seq, scope.snapshot_seq, args.status, args.status, cursor?.thread_id ?? null, cursor?.message_seq ?? null, cursor?.message_seq ?? null, cursor?.thread_id ?? null, limit + 1);
  const page = found.slice(0, limit);
  const hasMore = found.length > limit;
  return { items: page.map(threadResult), next_after_id: page.at(-1)?.thread_id ?? args.after_thread_id ?? null, has_more: hasMore, snapshot_seq: scope.snapshot_seq };
}

async function getThread(db, args, scope) {
  const row = await latestThread(db, scope, args.thread_id);
  if (!row) throw new Error('Unknown or out-of-scope thread');
  return threadResult(row);
}

async function getMessages(db, args, scope) {
  const thread = await latestThread(db, scope, args.thread_id);
  if (!thread) throw new Error('Unknown or out-of-scope thread');
  transcriptAllowed(scope, args.thread_id, thread);
  let cursorSeq = null;
  if (args.after_message_id) {
    const cursor = await one(db, `SELECT seq FROM messages WHERE space_id = ? AND thread_id = ? AND message_id = ? AND seq <= ?`, scope.space_id, args.thread_id, args.after_message_id, scope.snapshot_seq);
    if (!cursor) throw new Error('Unknown or out-of-scope message cursor');
    cursorSeq = cursor.seq;
  }
  const limit = limitValue(args.limit);
  const found = await rows(db, `SELECT seq, message_id, thread_id, kind, actor_id, body_json, created_at FROM messages
    WHERE space_id = ? AND thread_id = ? AND seq <= ? AND (? IS NULL OR seq > ?)
    ORDER BY seq ASC LIMIT ?`, scope.space_id, args.thread_id, scope.snapshot_seq, cursorSeq, cursorSeq, limit + 1);
  const page = found.slice(0, limit);
  const hasMore = found.length > limit;
  return { items: page.map(parseMessage), next_after_id: page.at(-1)?.message_id ?? args.after_message_id ?? null, has_more: hasMore, snapshot_seq: scope.snapshot_seq };
}

async function getMessage(db, args, scope) {
  const row = await one(db, `SELECT seq, message_id, thread_id, kind, actor_id, body_json, created_at FROM messages WHERE space_id = ? AND message_id = ? AND seq <= ?`, scope.space_id, args.message_id, scope.snapshot_seq);
  if (!row) throw new Error('Unknown or out-of-scope message');
  const thread = row.thread_id ? await latestThread(db, scope, row.thread_id) : null;
  transcriptAllowed(scope, row.thread_id, thread);
  return parseMessage(row);
}

async function getAgreements(db, args, scope) {
  if (args.thread_id != null) {
    const thread = await latestThread(db, scope, args.thread_id);
    if (!thread) throw new Error('Unknown or out-of-scope agreement thread');
  }
  let cursor = null;
  if (args.after_agreement_id) {
    cursor = await one(db, `SELECT av.message_seq, av.agreement_id FROM agreement_versions av
      WHERE av.space_id = ? AND av.agreement_id = ? AND av.message_seq <= ?
        AND av.message_seq = (SELECT MAX(v.message_seq) FROM agreement_versions v WHERE v.space_id = av.space_id AND v.agreement_id = av.agreement_id AND v.message_seq <= ?)
        AND av.confirmed = 1 AND (av.thread_id IS NULL OR ? IS NULL OR av.thread_id = ?)`, scope.space_id, args.after_agreement_id, scope.snapshot_seq, scope.snapshot_seq, args.thread_id, args.thread_id);
    if (!cursor) throw new Error('Unknown or out-of-scope agreement cursor');
  }
  const limit = limitValue(args.limit);
  const found = await rows(db, `SELECT av.agreement_id, av.thread_id, av.message_seq, av.version, av.text
    FROM agreement_versions av
    WHERE av.space_id = ? AND av.message_seq <= ?
      AND av.message_seq = (SELECT MAX(v.message_seq) FROM agreement_versions v WHERE v.space_id = av.space_id AND v.agreement_id = av.agreement_id AND v.message_seq <= ?)
      AND av.confirmed = 1 AND (av.thread_id IS NULL OR ? IS NULL OR av.thread_id = ?)
      AND (? IS NULL OR av.message_seq > ? OR (av.message_seq = ? AND av.agreement_id > ?))
    ORDER BY av.message_seq ASC, av.agreement_id ASC LIMIT ?`, scope.space_id, scope.snapshot_seq, scope.snapshot_seq, args.thread_id, args.thread_id, cursor?.agreement_id ?? null, cursor?.message_seq ?? null, cursor?.message_seq ?? null, cursor?.agreement_id ?? null, limit + 1);
  const page = found.slice(0, limit);
  const hasMore = found.length > limit;
  return { items: page.map(agreementResult), next_after_id: page.at(-1)?.agreement_id ?? args.after_agreement_id ?? null, has_more: hasMore, snapshot_seq: scope.snapshot_seq };
}

const handlers = { list_threads: listThreads, get_thread: getThread, get_messages: getMessages, get_message: getMessage, get_agreements: getAgreements };

export function createQueryExecutor(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('A D1 database binding is required');
  return async function execute(name, args, scope) {
    const handler = Object.hasOwn(handlers, name) ? handlers[name] : null;
    if (!handler) throw new Error(`Unsupported query tool: ${name}`);
    assertScope(scope);
    await membership(db, scope);
    return handler(db, args, scope);
  };
}
