export class MemberTokenError extends Error {
  constructor(code, status = 401) {
    super(code === 'member_token_required' ? '需要成员令牌。' : '成员令牌无效。');
    this.name = 'MemberTokenError';
    this.code = code;
    this.status = status;
  }
}

function bearerToken(request) {
  const authorization = request.headers.get('authorization');
  if (authorization === null) throw new MemberTokenError('member_token_required');
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
  if (!match) throw new MemberTokenError('invalid_member_token');
  return match[1];
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function memberTokenDigestFromRequest(request) {
  if (!request?.headers) throw new TypeError('request is required');
  return sha256Hex(bearerToken(request));
}

export async function authenticateMemberToken({ db, request }) {
  if (!db || !request?.headers) throw new TypeError('db and request are required');
  const digest = await memberTokenDigestFromRequest(request);
  const member = await db.prepare(`
    SELECT mt.space_id, mt.user_id AS actor_id, m.role
    FROM member_tokens mt
    INNER JOIN members m ON m.space_id = mt.space_id AND m.user_id = mt.user_id
    WHERE mt.token_sha256 = ? AND mt.revoked_at IS NULL
    LIMIT 1
  `).bind(digest).first();
  if (!member || typeof member.space_id !== 'string' || typeof member.actor_id !== 'string' || typeof member.role !== 'string') {
    throw new MemberTokenError('invalid_member_token');
  }
  return { space_id: member.space_id, actor_id: member.actor_id, role: member.role };
}
