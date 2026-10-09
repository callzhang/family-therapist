import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import test from 'node:test';
import { authenticateMemberToken, MemberTokenError } from '../../sites/family-therapist/src/server/member-token.mjs';
import { snapshotSequence } from '../../sites/family-therapist/src/server/snapshot-sequence.mjs';

const migrationDir = path.resolve('sites/family-therapist/drizzle');

class D1Sqlite {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys = ON'); }
  async migrate() {
    const files = (await readdir(migrationDir)).filter((name) => /^000[0-3]_.*\.sql$/.test(name)).sort();
    assert.equal(files.length, 4, 'the member-token test requires the four actual generated migrations');
    for (const name of files) this.sqlite.exec((await readFile(path.join(migrationDir, name), 'utf8')).replaceAll('--> statement-breakpoint', ''));
  }
  prepare(sql) {
    return { bind: (...values) => ({ first: async () => this.sqlite.prepare(sql).get(...values) ?? null }) };
  }
  run(sql, ...values) { this.sqlite.prepare(sql).run(...values); }
  close() { this.sqlite.close(); }
}

const spaceId = 'family-space';
const actors = ['partner-husband', 'partner-wife'];
const tokens = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const bearerRequest = (value) => new Request('https://example.test/api/messages', { headers: value === undefined ? {} : { authorization: value } });

async function setup() {
  const db = new D1Sqlite();
  await db.migrate();
  actors.forEach((actor, index) => db.run('INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)', spaceId, actor, index === 0 ? 'husband' : 'wife'));
  actors.forEach((actor, index) => db.run('INSERT INTO member_tokens(token_sha256,space_id,user_id) VALUES(?,?,?)', tokenHash(tokens[index]), spaceId, actor));
  return db;
}

test('the actual generated migrations bind each distinct member token to its own current actor', async () => {
  const db = await setup();
  try {
    assert.deepEqual(await authenticateMemberToken({ db, request: bearerRequest(`Bearer ${tokens[0]}`) }), { space_id: spaceId, actor_id: actors[0], role: 'husband' });
    assert.deepEqual(await authenticateMemberToken({ db, request: bearerRequest(`Bearer ${tokens[1]}`) }), { space_id: spaceId, actor_id: actors[1], role: 'wife' });
  } finally { db.close(); }
});

test('missing, malformed, unknown and revoked tokens return stable 401 errors without exposing secrets', async () => {
  const db = await setup();
  try {
    const cases = [
      [bearerRequest(undefined), 'member_token_required'],
      [bearerRequest('Basic visitor-identity'), 'invalid_member_token'],
      [bearerRequest('Bearer too-short-secret'), 'invalid_member_token'],
      [bearerRequest(`Bearer ${randomBytes(32).toString('base64url')}`), 'invalid_member_token'],
    ];
    for (const [request, code] of cases) {
      await assert.rejects(authenticateMemberToken({ db, request }), (error) => error instanceof MemberTokenError && error.status === 401 && error.code === code && !tokens.some((token) => error.message.includes(token)));
    }
    db.run("UPDATE member_tokens SET revoked_at = '2026-10-08T00:00:00Z' WHERE user_id = ?", actors[0]);
    await assert.rejects(authenticateMemberToken({ db, request: bearerRequest(`Bearer ${tokens[0]}`) }), { status: 401, code: 'invalid_member_token' });
  } finally { db.close(); }
});

test('removing current membership invalidates its token through the membership join', async () => {
  const db = await setup();
  try {
    db.run('DELETE FROM members WHERE space_id = ? AND user_id = ?', spaceId, actors[1]);
    await assert.rejects(authenticateMemberToken({ db, request: bearerRequest(`Bearer ${tokens[1]}`) }), { status: 401, code: 'invalid_member_token' });
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM member_tokens WHERE user_id = ?').get(actors[1]).count, 0);
  } finally { db.close(); }
});

test('visitor identity and request body fields cannot select an authenticated actor', async () => {
  const db = await setup();
  try {
    const visitorOnly = new Request('https://example.test/api/messages', { method: 'POST', headers: { 'x-user-id': actors[1], 'content-type': 'application/json' }, body: JSON.stringify({ actor_id: actors[1] }) });
    await assert.rejects(authenticateMemberToken({ db, request: visitorOnly }), { status: 401, code: 'member_token_required' });
    const authenticated = new Request('https://example.test/api/messages', { method: 'POST', headers: { authorization: `Bearer ${tokens[0]}`, 'content-type': 'application/json' }, body: JSON.stringify({ actor_id: actors[1] }) });
    assert.equal((await authenticateMemberToken({ db, request: authenticated })).actor_id, actors[0]);
  } finally { db.close(); }
});

test('snapshot sequence accepts only nonnegative safe integers', () => {
  assert.equal(snapshotSequence({ snapshot_seq: 0 }), 0);
  assert.equal(snapshotSequence({ snapshot_seq: 12 }), 12);
  for (const snapshot of [null, {}, { snapshot_seq: -1 }, { snapshot_seq: 1.5 }, { snapshot_seq: NaN }, { snapshot_seq: Infinity }, { snapshot_seq: '12' }]) {
    assert.equal(snapshotSequence(snapshot), null);
  }
});
