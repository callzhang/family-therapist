import { memberTokenDigestFromRequest, MemberTokenError } from './member-token.mjs';

const MAX_SEED_BYTES = 4096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MEMBERS = [
  { actor_id: 'partner-husband', role: 'husband' },
  { actor_id: 'partner-wife', role: 'wife' },
];

export class MemberSetupError extends Error {
  constructor(code, status) {
    const messages = {
      request_body_not_allowed: '初始化请求不能包含请求体。',
      setup_not_configured: '共同空间初始化尚未配置。',
      setup_configuration_invalid: '共同空间初始化配置无效。',
      setup_conflict: '共同空间已有数据或凭证与服务配置不一致，未作修改。',
      setup_unavailable: '暂时无法验证共同空间初始化状态，请稍后重试。',
    };
    super(messages[code] ?? '共同空间初始化失败。');
    this.name = 'MemberSetupError';
    this.code = code;
    this.status = status;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

export function parseMemberSetupSeed(seedJson) {
  if (seedJson === undefined || seedJson === null || seedJson === '') throw new MemberSetupError('setup_not_configured', 503);
  if (typeof seedJson !== 'string' || new TextEncoder().encode(seedJson).byteLength > MAX_SEED_BYTES) {
    throw new MemberSetupError('setup_configuration_invalid', 503);
  }

  let seed;
  try { seed = JSON.parse(seedJson); }
  catch { throw new MemberSetupError('setup_configuration_invalid', 503); }
  if (!hasExactKeys(seed, ['space_id', 'members']) || typeof seed.space_id !== 'string' || !UUID_PATTERN.test(seed.space_id) || !Array.isArray(seed.members) || seed.members.length !== MEMBERS.length) {
    throw new MemberSetupError('setup_configuration_invalid', 503);
  }

  const normalizedMembers = seed.members.map((member) => {
    if (!hasExactKeys(member, ['actor_id', 'role', 'token_sha256']) || typeof member.actor_id !== 'string' || typeof member.role !== 'string' || typeof member.token_sha256 !== 'string' || !HASH_PATTERN.test(member.token_sha256)) {
      throw new MemberSetupError('setup_configuration_invalid', 503);
    }
    return { actor_id: member.actor_id, role: member.role, token_sha256: member.token_sha256 };
  }).sort((left, right) => left.actor_id < right.actor_id ? -1 : left.actor_id > right.actor_id ? 1 : 0);

  const expectedMembers = [...MEMBERS].sort((left, right) => left.actor_id < right.actor_id ? -1 : left.actor_id > right.actor_id ? 1 : 0);
  if (normalizedMembers.some((member, index) => member.actor_id !== expectedMembers[index].actor_id || member.role !== expectedMembers[index].role) ||
    new Set(normalizedMembers.map((member) => member.token_sha256)).size !== MEMBERS.length) {
    throw new MemberSetupError('setup_configuration_invalid', 503);
  }
  return { space_id: seed.space_id, members: normalizedMembers };
}

async function currentState(db, spaceId) {
  const memberResult = await db.prepare('SELECT user_id, role FROM members WHERE space_id = ? ORDER BY user_id').bind(spaceId).all();
  const tokenResult = await db.prepare('SELECT token_sha256, user_id, revoked_at FROM member_tokens WHERE space_id = ? ORDER BY user_id').bind(spaceId).all();
  const historyResult = await db.prepare(`SELECT
    EXISTS (SELECT 1 FROM messages WHERE space_id = ?) OR
    EXISTS (SELECT 1 FROM thread_versions WHERE space_id = ?) OR
    EXISTS (SELECT 1 FROM agreement_versions WHERE space_id = ?) OR
    EXISTS (SELECT 1 FROM discussion_projection WHERE space_id = ?) OR
    EXISTS (SELECT 1 FROM therapist_tasks WHERE space_id = ?) AS has_history`).bind(spaceId, spaceId, spaceId, spaceId, spaceId).first();
  if (!Array.isArray(memberResult?.results) || !Array.isArray(tokenResult?.results) || !historyResult || ![0, 1].includes(historyResult.has_history)) throw new MemberSetupError('setup_unavailable', 503);
  return { members: memberResult.results, tokens: tokenResult.results, hasHistory: historyResult.has_history === 1 };
}

function exactlyConfigured(state, seed) {
  if (state.members.length !== seed.members.length || state.tokens.length !== seed.members.length) return false;
  const membersById = new Map(state.members.map((row) => [row.user_id, row]));
  const tokensById = new Map(state.tokens.map((row) => [row.user_id, row]));
  return seed.members.every((expected) => {
    const member = membersById.get(expected.actor_id);
    const token = tokensById.get(expected.actor_id);
    return member?.role === expected.role && token?.token_sha256 === expected.token_sha256 && token?.revoked_at === null;
  });
}

function emptyTarget(state) {
  return state.members.length === 0 && state.tokens.length === 0 && !state.hasHistory;
}

const noHistoryData = `NOT EXISTS (SELECT 1 FROM messages WHERE space_id = ?) AND
  NOT EXISTS (SELECT 1 FROM thread_versions WHERE space_id = ?) AND
  NOT EXISTS (SELECT 1 FROM agreement_versions WHERE space_id = ?) AND
  NOT EXISTS (SELECT 1 FROM discussion_projection WHERE space_id = ?) AND
  NOT EXISTS (SELECT 1 FROM therapist_tasks WHERE space_id = ?)`;
const noTargetData = `NOT EXISTS (SELECT 1 FROM members WHERE space_id = ?) AND NOT EXISTS (SELECT 1 FROM member_tokens WHERE space_id = ?) AND ${noHistoryData}`;

function memberStatement(db, seed) {
  const selectRows = seed.members.map(() => `SELECT ?, ?, ? WHERE ${noTargetData}`).join(' UNION ALL ');
  const bindings = seed.members.flatMap((member) => [seed.space_id, member.actor_id, member.role, ...Array(7).fill(seed.space_id)]);
  return db.prepare(`INSERT INTO members (space_id, user_id, role) ${selectRows}`).bind(...bindings);
}

function tokenStatement(db, seed) {
  const memberGuard = [
    'changes() = 2',
    '(SELECT COUNT(*) FROM members WHERE space_id = ?) = 2',
    ...seed.members.map(() => 'EXISTS (SELECT 1 FROM members WHERE space_id = ? AND user_id = ? AND role = ?)'),
    'NOT EXISTS (SELECT 1 FROM member_tokens WHERE space_id = ?)',
    noHistoryData,
  ].join(' AND ');
  const selectRows = seed.members.map(() => `SELECT ?, ?, ?, NULL WHERE ${memberGuard}`).join(' UNION ALL ');
  const guardBindings = [seed.space_id, ...seed.members.flatMap((member) => [seed.space_id, member.actor_id, member.role]), seed.space_id, ...Array(5).fill(seed.space_id)];
  const bindings = seed.members.flatMap((member) => [member.token_sha256, seed.space_id, member.actor_id, ...guardBindings]);
  return db.prepare(`INSERT INTO member_tokens (token_sha256, space_id, user_id, revoked_at) ${selectRows}`).bind(...bindings);
}

export async function initializeMemberSpace({ db, seedJson, request }) {
  if (!db || !request?.headers) throw new TypeError('db and request are required');
  if (request.body !== null || (request.headers.get('content-length') !== null && request.headers.get('content-length') !== '0')) {
    throw new MemberSetupError('request_body_not_allowed', 400);
  }
  const seed = parseMemberSetupSeed(seedJson);
  const tokenDigest = await memberTokenDigestFromRequest(request);
  const caller = seed.members.find((member) => member.token_sha256 === tokenDigest);
  if (!caller) throw new MemberTokenError('invalid_member_token');

  const current = await currentState(db, seed.space_id);
  if (!emptyTarget(current)) {
    if (!exactlyConfigured(current, seed)) throw new MemberSetupError('setup_conflict', 409);
    return { status: 'initialized', actor_id: caller.actor_id, role: caller.role };
  }

  let batchFailed = false;
  try { await db.batch([memberStatement(db, seed), tokenStatement(db, seed)]); }
  catch { batchFailed = true; }

  const readback = await currentState(db, seed.space_id);
  if (exactlyConfigured(readback, seed)) return { status: 'initialized', actor_id: caller.actor_id, role: caller.role };
  if (!emptyTarget(readback)) throw new MemberSetupError('setup_conflict', 409);
  throw new MemberSetupError(batchFailed ? 'setup_unavailable' : 'setup_conflict', batchFailed ? 503 : 409);
}
