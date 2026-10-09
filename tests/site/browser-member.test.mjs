import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import test from 'node:test';
import {
  authenticateBrowserMember,
  BrowserMemberError,
  clearBrowserMemberSession,
  createBrowserMemberSession,
} from '../../sites/family-therapist/src/server/browser-member.mjs';
import { MemberTokenError } from '../../sites/family-therapist/src/server/member-token.mjs';

const migrationDir = path.resolve('sites/family-therapist/drizzle');
const spaceId = 'family-space';
const actors = ['partner-husband', 'partner-wife'];
const roles = ['husband', 'wife'];
const tokens = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

class D1Sqlite {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys = ON'); }
  async migrate() {
    const files = (await readdir(migrationDir)).filter((name) => /^000[0-3]_.*\.sql$/.test(name)).sort();
    assert.equal(files.length, 4, 'browser auth tests require the actual generated migrations');
    for (const name of files) this.sqlite.exec((await readFile(path.join(migrationDir, name), 'utf8')).replaceAll('--> statement-breakpoint', ''));
  }
  run(sql, ...values) { this.sqlite.prepare(sql).run(...values); }
  prepare(sql) { return { bind: (...values) => ({ first: async () => this.sqlite.prepare(sql).get(...values) ?? null }) }; }
  close() { this.sqlite.close(); }
}

async function setup() {
  const db = new D1Sqlite();
  await db.migrate();
  actors.forEach((actor, index) => db.run('INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)', spaceId, actor, roles[index]));
  actors.forEach((actor, index) => db.run('INSERT INTO member_tokens(token_sha256,space_id,user_id) VALUES(?,?,?)', tokenHash(tokens[index]), spaceId, actor));
  return db;
}

const cookieFor = (token) => `therapist_member=${token}`;
const bearerRequest = (token, origin = 'https://family.example') => new Request('https://family.example/api/member-session', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' },
  body: JSON.stringify({ actor_id: actors[1], role: roles[1] }),
});

test('browser cookie resolves each member through actual current membership, without visitor identity fallback', async () => {
  const db = await setup();
  try {
    assert.deepEqual(await authenticateBrowserMember({ db, cookieHeader: cookieFor(tokens[0]) }), { space_id: spaceId, actor_id: actors[0], role: roles[0] });
    assert.deepEqual(await authenticateBrowserMember({ db, cookieHeader: cookieFor(tokens[1]) }), { space_id: spaceId, actor_id: actors[1], role: roles[1] });
    const siteVisitorOnly = new Request('https://family.example/api/view', { headers: { 'oai-authenticated-user-id': actors[1], 'oai-authenticated-user-email': 'visitor@example.test' } });
    await assert.rejects(authenticateBrowserMember({ db, cookieHeader: siteVisitorOnly.headers.get('cookie') }), { status: 401, code: 'member_token_required' });
  } finally { db.close(); }
});

test('missing, malformed, forged, duplicate and revoked browser cookies are rejected without exposing token values', async () => {
  const db = await setup();
  try {
    const cases = [
      [null, 'member_token_required'],
      ['', 'member_token_required'],
      [`therapist_member=${tokens[0]}; therapist_member=${tokens[0]}`, 'invalid_member_token'],
      ['therapist_member=short', 'invalid_member_token'],
      [`therapist_member=${randomBytes(32).toString('base64url')}`, 'invalid_member_token'],
    ];
    for (const [cookieHeader, code] of cases) {
      await assert.rejects(authenticateBrowserMember({ db, cookieHeader }), (error) => error instanceof MemberTokenError && error.status === 401 && error.code === code && !tokens.some((token) => error.message.includes(token)));
    }
    db.run("UPDATE member_tokens SET revoked_at='2026-10-08T00:00:00Z' WHERE user_id=?", actors[0]);
    await assert.rejects(authenticateBrowserMember({ db, cookieHeader: cookieFor(tokens[0]) }), { status: 401, code: 'invalid_member_token' });
  } finally { db.close(); }
});

test('session creation returns server-bound identity and only places the token in a protected session cookie', async () => {
  const db = await setup();
  try {
    const response = await createBrowserMemberSession({ db, request: bearerRequest(tokens[0]) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    const setCookie = response.headers.get('set-cookie');
    assert.ok(setCookie?.includes(`therapist_member=${tokens[0]}`));
    assert.match(setCookie, /; Path=\//);
    assert.match(setCookie, /; HttpOnly/);
    assert.match(setCookie, /; SameSite=Strict/);
    assert.match(setCookie, /; Secure/);
    assert.doesNotMatch(setCookie, /Max-Age=|Expires=/);
    const body = await response.text();
    assert.deepEqual(JSON.parse(body), { actor_id: actors[0], role: roles[0] });
    assert.ok(!body.includes(tokens[0]));
    assert.ok(!JSON.stringify([...response.headers]).replace(setCookie, '').includes(tokens[0]));

    const localResponse = await createBrowserMemberSession({
      db,
      request: new Request('http://localhost/api/member-session', { method: 'POST', headers: { authorization: `Bearer ${tokens[1]}`, origin: 'http://localhost' } }),
    });
    const localCookie = localResponse.headers.get('set-cookie') ?? '';
    assert.match(localCookie, /; HttpOnly/);
    assert.match(localCookie, /; SameSite=Strict/);
    assert.doesNotMatch(localCookie, /; Secure|Max-Age=|Expires=/);
  } finally { db.close(); }
});

test('session creation refuses absent or cross-origin mutation requests before checking credentials', async () => {
  const db = await setup();
  try {
    for (const request of [bearerRequest(tokens[0], 'https://attacker.example'), new Request('https://family.example/api/member-session', { method: 'POST', headers: { authorization: `Bearer ${tokens[0]}` } })]) {
      await assert.rejects(createBrowserMemberSession({ db, request }), (error) => error instanceof BrowserMemberError && error.status === 403 && error.code === 'same_origin_required');
    }
  } finally { db.close(); }
});

test('logout clears only the browser session and also rejects cross-origin mutation', () => {
  const request = new Request('https://family.example/api/member-session', { method: 'DELETE', headers: { origin: 'https://family.example' } });
  const response = clearBrowserMemberSession(request);
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('set-cookie'), 'therapist_member=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0');
  assert.throws(() => clearBrowserMemberSession(new Request('https://family.example/api/member-session', { method: 'DELETE', headers: { origin: 'https://attacker.example' } })), { code: 'same_origin_required', status: 403 });
});
