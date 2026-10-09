import { validateToolArguments } from '../therapist/tools.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const discussionKinds = new Set(['consensus', 'settle', 'reopen', 'switch', 'principle']);


async function readBoundedBody(response) {
  const limit = 32 * 1024 * 1024;
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new Error('Configured private site response exceeds the size limit');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}
function uuid(value, label) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new TypeError(`${label} must be a UUID`);
  return value;
}
function text(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be nonblank`);
  return value;
}
function assertExpression(command) {
  if (!plainObject(command) || Object.keys(command).sort().join(',') !== 'confirmed,expected_thread_seq,message_id,text,thread_id' || command.confirmed !== true || !Number.isSafeInteger(command.expected_thread_seq) || command.expected_thread_seq < 1) throw new TypeError('Invalid confirmed expression command');
  uuid(command.message_id, 'message_id'); uuid(command.thread_id, 'thread_id'); text(command.text, 'text');
  if (new TextEncoder().encode(command.text).byteLength >= 64 * 1024) throw new TypeError('Expression text is too large');
  return command;
}
function assertDiscussion(command) {
  if (!plainObject(command) || Object.keys(command).sort().join(',') !== 'action,confirmed,message_id' || command.confirmed !== true || !plainObject(command.action)) throw new TypeError('Invalid confirmed discussion command');
  uuid(command.message_id, 'message_id');
  const a = command.action;
  if (a.type === 'create') {
    if (Object.keys(a).sort().join(',') !== 'id,title,type') throw new TypeError('Invalid create action');
    uuid(a.id, 'action.id'); text(a.title, 'action.title');
  } else if (a.type === 'propose') {
    if (Object.keys(a).sort().join(',') !== 'id,kind,target_id,text,thread_id,type' || !discussionKinds.has(a.kind)) throw new TypeError('Invalid proposal action');
    uuid(a.id, 'action.id'); uuid(a.thread_id, 'action.thread_id'); text(a.text, 'action.text');
    if ((a.kind === 'switch') !== (a.target_id !== null)) throw new TypeError('target_id must match proposal kind');
    if (a.target_id !== null) uuid(a.target_id, 'action.target_id');
  } else if (a.type === 'approve') {
    if (Object.keys(a).sort().join(',') !== 'id,text,type') throw new TypeError('Invalid approval action');
    uuid(a.id, 'action.id'); text(a.text, 'action.text');
  } else throw new TypeError('Unknown discussion action');
  if (new TextEncoder().encode(JSON.stringify(command)).byteLength > 64 * 1024) throw new TypeError('Discussion command is too large');
  return command;
}

export function validateMember(member) {
  if (!plainObject(member) || Object.keys(member).sort().join(',') !== 'actor_id,member_token,role,space_id' || !['partner-husband', 'partner-wife'].includes(member.actor_id) || !['husband', 'wife'].includes(member.role) || !uuidPattern.test(member.space_id) || typeof member.member_token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(member.member_token)) throw new TypeError('Invalid member credentials');
  if ((member.actor_id === 'partner-husband') !== (member.role === 'husband')) throw new TypeError('Member role does not match actor');
  return member;
}
export function validateConnection(connection) {
  if (!plainObject(connection) || Object.keys(connection).sort().join(',') !== 'base_url,site_access_token' || typeof connection.base_url !== 'string' || !(connection.site_access_token === null || typeof connection.site_access_token === 'string')) throw new TypeError('Invalid connection configuration');
  let url;
  try { url = new URL(connection.base_url); } catch { throw new TypeError('Invalid configured base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || !url.hostname) throw new TypeError('Base URL must be an origin without credentials, path, query, or fragment');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new TypeError('HTTPS is required outside localhost');
  if (connection.site_access_token !== null && (!connection.site_access_token || /[\r\n]/.test(connection.site_access_token))) throw new TypeError('Invalid Sites access token');
  return { ...connection, base_url: url.origin };
}

export function createAgentClient({ member: rawMember, connection: rawConnection, fetchImpl = fetch, timeoutMs = 15000 }) {
  const member = validateMember(rawMember);
  const connection = validateConnection(rawConnection);
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new TypeError('Invalid fetch configuration');
  async function request(method, pathname, { query, body } = {}) {
    const url = new URL(pathname, `${connection.base_url}/`);
    if (query) for (const [key, value] of Object.entries(query)) if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
    const headers = { authorization: `Bearer ${member.member_token}`, accept: 'application/json' };
    if (connection.site_access_token) headers['OAI-Sites-Authorization'] = `Bearer ${connection.site_access_token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let raw;
    try {
      response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) throw new Error('Configured private site returned a redirect; credentials were not forwarded');
      if (Number(response.headers.get('content-length')) > 32 * 1024 * 1024) throw new Error('Configured private site response exceeds the size limit');
      raw = await readBoundedBody(response);
    } catch (error) {
      if (error?.message === 'Configured private site returned a redirect; credentials were not forwarded' || error?.message === 'Configured private site response exceeds the size limit') throw error;
      throw new Error('Configured private site request failed');
    } finally { clearTimeout(timer); }
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new Error(`Configured private site returned invalid JSON (HTTP ${response.status})`); }
    if (!response.ok) {
      const code = typeof payload?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(payload.code) ? `, ${payload.code}` : '';
      const error = new Error(`Configured private site request failed (HTTP ${response.status}${code})`);
      error.status = response.status; error.code = code ? payload.code : undefined; throw error;
    }
    return payload;
  }
  return Object.freeze({
    getUpdates: ({ after_message_id = null, snapshot_seq = null, limit = 100 } = {}) => {
      if (after_message_id !== null) uuid(after_message_id, 'after_message_id');
      if (snapshot_seq !== null && (!Number.isSafeInteger(snapshot_seq) || snapshot_seq < 0)) throw new TypeError('snapshot_seq must be a nonnegative safe integer or null');
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be from 1 to 100');
      return request('GET', '/api/updates', { query: { after_message_id, snapshot_seq, limit } });
    },
    getSkillRelease: () => request('GET', '/api/skill/release'),
    query: (name, args) => { validateToolArguments(name, args); return request('POST', `/api/query/${encodeURIComponent(name)}`, { body: args }); },
    getDiscussion: () => request('GET', '/api/discussion'),
    submitExpression: (command) => request('POST', '/api/messages', { body: assertExpression(command) }),
    executeDiscussion: (command) => request('POST', '/api/discussion', { body: assertDiscussion(command) }),
    getExpressionReceipt: (id) => request('GET', `/api/messages/${encodeURIComponent(uuid(id, 'message_id'))}`),
    getDiscussionReceipt: (id) => request('GET', `/api/discussion/${encodeURIComponent(uuid(id, 'message_id'))}`),
  });
}
