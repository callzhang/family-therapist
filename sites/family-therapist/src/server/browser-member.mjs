import { authenticateMemberToken, MemberTokenError } from './member-token.mjs';

const COOKIE_NAME = 'therapist_member';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class BrowserMemberError extends Error {
  constructor(code) {
    super(code === 'same_origin_required' ? '请从共同空间页面提交此操作。' : '浏览器成员会话无效。');
    this.name = 'BrowserMemberError';
    this.code = code;
    this.status = code === 'same_origin_required' ? 403 : 401;
  }
}

function tokenFromCookieHeader(cookieHeader) {
  const matches = [];
  for (const part of (cookieHeader ?? '').split(';')) {
    const separator = part.indexOf('=');
    const name = (separator === -1 ? part : part.slice(0, separator)).trim();
    if (name === COOKIE_NAME) matches.push(separator === -1 ? '' : part.slice(separator + 1).trim());
  }
  if (matches.length === 0) throw new MemberTokenError('member_token_required');
  if (matches.length !== 1 || !TOKEN_PATTERN.test(matches[0])) throw new MemberTokenError('invalid_member_token');
  return matches[0];
}

function tokenFromBearerHeader(request) {
  const authorization = request.headers.get('authorization');
  const match = authorization === null ? null : /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
  if (!match) throw new MemberTokenError(authorization === null ? 'member_token_required' : 'invalid_member_token');
  return match[1];
}

function sameOriginRequest(request) {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null') throw new BrowserMemberError('same_origin_required');
  try {
    if (new URL(origin).origin !== new URL(request.url).origin) throw new BrowserMemberError('same_origin_required');
  } catch (error) {
    if (error instanceof BrowserMemberError) throw error;
    throw new BrowserMemberError('same_origin_required');
  }
}

function cookieFlags(request) {
  return `Path=/; HttpOnly; SameSite=Strict${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}

export function clearBrowserMemberCookie(request) {
  return `${COOKIE_NAME}=; ${cookieFlags(request)}; Max-Age=0`;
}

export async function authenticateBrowserMember({ db, cookieHeader }) {
  const token = tokenFromCookieHeader(cookieHeader);
  const request = new Request('https://member-session.invalid/', { headers: { authorization: `Bearer ${token}` } });
  return authenticateMemberToken({ db, request });
}

export async function createBrowserMemberSession({ db, request }) {
  sameOriginRequest(request);
  const token = tokenFromBearerHeader(request);
  const identity = await authenticateMemberToken({ db, request });
  return Response.json({ actor_id: identity.actor_id, role: identity.role }, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Set-Cookie': `${COOKIE_NAME}=${token}; ${cookieFlags(request)}`,
    },
  });
}

export function clearBrowserMemberSession(request) {
  sameOriginRequest(request);
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'private, no-store', 'Set-Cookie': clearBrowserMemberCookie(request) } });
}
