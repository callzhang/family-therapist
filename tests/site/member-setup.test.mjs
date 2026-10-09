import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import test from 'node:test';
import { initializeMemberSpace, MemberSetupError, parseMemberSetupSeed } from '../../sites/family-therapist/src/server/member-setup.mjs';
import { MemberTokenError } from '../../sites/family-therapist/src/server/member-token.mjs';

const migrationDir = path.resolve('sites/family-therapist/drizzle');
const spaceId = 'e6f62c7d-e975-4cc3-a62e-0e3a4ba6a7cd';
const actors = ['partner-husband', 'partner-wife'];
const roles = ['husband', 'wife'];
const tokens = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')];
const digest = (token) => createHash('sha256').update(token).digest('hex');
const members = actors.map((actor_id, index) => ({ actor_id, role: roles[index], token_sha256: digest(tokens[index]) }));
const seed = { space_id: spaceId, members };
const seedJson = JSON.stringify(seed);

class D1Sqlite {
  constructor() { this.sqlite = new DatabaseSync(':memory:'); this.sqlite.exec('PRAGMA foreign_keys = ON'); this.batchCalls = 0; this.failStatementAt = null; this.beforeBatch = null; }
  async migrate() {
    const files = (await readdir(migrationDir)).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort();
    assert.ok(files.length >= 4, 'member setup tests require actual generated migrations');
    for (const name of files) this.sqlite.exec((await readFile(path.join(migrationDir, name), 'utf8')).replaceAll('--> statement-breakpoint', ''));
  }
  prepare(sql) {
    return { bind: (...values) => ({
      all: async () => ({ results: this.sqlite.prepare(sql).all(...values) }),
      first: async () => this.sqlite.prepare(sql).get(...values) ?? null,
      run: () => this.sqlite.prepare(sql).run(...values),
    }) };
  }
  async batch(statements) {
    this.batchCalls += 1;
    this.beforeBatch?.();
    this.beforeBatch = null;
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      for (const [index, statement] of statements.entries()) {
        if (this.failStatementAt === index + 1) { this.failStatementAt = null; throw new Error('simulated batch failure'); }
        statement.run();
      }
      this.sqlite.exec('COMMIT');
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.sqlite.close(); }
}

function setupRequest(token, body) {
  return new Request('https://family.example/api/setup', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function emptyStreamSetupRequest(token) {
  return new Request('https://family.example/api/setup', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-length': '0' },
    body: new ReadableStream({ start(controller) { controller.close(); } }),
    duplex: 'half',
  });
}

async function createDb() {
  const db = new D1Sqlite();
  await db.migrate();
  return db;
}

async function rowCounts(db) {
  return {
    members: db.sqlite.prepare('SELECT COUNT(*) AS count FROM members WHERE space_id = ?').get(spaceId).count,
    tokens: db.sqlite.prepare('SELECT COUNT(*) AS count FROM member_tokens WHERE space_id = ?').get(spaceId).count,
  };
}

test('bodyless authenticated setup creates both fixed members and hashes atomically, then verifies exact repeats', async () => {
  const db = await createDb();
  try {
    const first = await initializeMemberSpace({ db, seedJson, request: setupRequest(tokens[0]) });
    assert.deepEqual(first, { status: 'initialized', actor_id: actors[0], role: roles[0] });
    assert.deepEqual(db.sqlite.prepare('SELECT user_id, role FROM members WHERE space_id = ? ORDER BY user_id').all(spaceId).map((row) => ({ ...row })), [
      { user_id: actors[0], role: roles[0] }, { user_id: actors[1], role: roles[1] },
    ]);
    assert.deepEqual(db.sqlite.prepare('SELECT token_sha256, user_id, revoked_at FROM member_tokens WHERE space_id = ? ORDER BY user_id').all(spaceId).map((row) => ({ ...row })), members.map(({ actor_id, token_sha256 }) => ({ token_sha256, user_id: actor_id, revoked_at: null })));
    assert.ok(!JSON.stringify(first).includes(tokens[0]));

    const repeated = await initializeMemberSpace({ db, seedJson, request: setupRequest(tokens[1]) });
    assert.deepEqual(repeated, { status: 'initialized', actor_id: actors[1], role: roles[1] });
    assert.equal(db.batchCalls, 1);
  } finally { db.close(); }
});

test('bodyless setup accepts a runtime request represented by a zero-byte stream', async () => {
  const db = await createDb();
  try {
    const result = await initializeMemberSpace({ db, seedJson, request: emptyStreamSetupRequest(tokens[0]) });
    assert.deepEqual(result, { status: 'initialized', actor_id: actors[0], role: roles[0] });
    assert.deepEqual(await rowCounts(db), { members: 2, tokens: 2 });
  } finally { db.close(); }
});

test('setup rejects request bodies and caller tokens outside the configured pair without creating rows', async () => {
  const db = await createDb();
  try {
    await assert.rejects(initializeMemberSpace({ db, seedJson, request: setupRequest(tokens[0], { actor_id: actors[1], space_id: 'other' }) }), { code: 'request_body_not_allowed', status: 400 });
    const outsider = randomBytes(32).toString('base64url');
    await assert.rejects(initializeMemberSpace({ db, seedJson, request: setupRequest(outsider) }), (error) => error instanceof MemberTokenError && error.status === 401 && error.code === 'invalid_member_token' && !error.message.includes(outsider));
    await assert.rejects(initializeMemberSpace({ db, seedJson, request: new Request('https://family.example/api/setup', { method: 'POST' }) }), { code: 'member_token_required', status: 401 });
    assert.deepEqual(await rowCounts(db), { members: 0, tokens: 0 });
  } finally { db.close(); }
});

test('seed parser enforces the exact pair, fixed roles, UUID, unique lowercase hashes, keys and size', () => {
  assert.deepEqual(parseMemberSetupSeed(seedJson), seed);
  const invalidSeeds = [
    JSON.stringify({ ...seed, space_id: "x'); DELETE FROM members; --" }),
    JSON.stringify({ ...seed, members: [{ ...members[0], role: 'wife' }, members[1]] }),
    JSON.stringify({ ...seed, members: [{ ...members[0], actor_id: 'visitor' }, members[1]] }),
    JSON.stringify({ ...seed, members: [{ ...members[0], token_sha256: 'A'.repeat(64) }, members[1]] }),
    JSON.stringify({ ...seed, members: [members[0], { ...members[1], token_sha256: members[0].token_sha256 }] }),
    JSON.stringify({ ...seed, unexpected: true }),
    ' '.repeat(4097),
  ];
  for (const value of invalidSeeds) assert.throws(() => parseMemberSetupSeed(value), { code: 'setup_configuration_invalid', status: 503 });
  assert.throws(() => parseMemberSetupSeed(undefined), { code: 'setup_not_configured', status: 503 });
});

test('setup refuses partial, conflicting, revoked and reconfigured states without repairing or rotating them', async () => {
  const db = await createDb();
  try {
    db.prepare('INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)').bind(spaceId, actors[0], roles[0]).run();
    await assert.rejects(initializeMemberSpace({ db, seedJson, request: setupRequest(tokens[0]) }), { code: 'setup_conflict', status: 409 });
    assert.deepEqual(await rowCounts(db), { members: 1, tokens: 0 });

    db.prepare('DELETE FROM members WHERE space_id = ?').bind(spaceId).run();
    await initializeMemberSpace({ db, seedJson, request: setupRequest(tokens[0]) });
    db.prepare("UPDATE member_tokens SET revoked_at = '2026-10-08T00:00:00Z' WHERE space_id = ? AND user_id = ?").bind(spaceId, actors[0]).run();
    await assert.rejects(initializeMemberSpace({ db, seedJson, request: setupRequest(tokens[0]) }), { code: 'setup_conflict', status: 409 });
    db.prepare('UPDATE member_tokens SET revoked_at = NULL WHERE space_id = ? AND user_id = ?').bind(spaceId, actors[0]).run();

    const changedToken = randomBytes(32).toString('base64url');
    const changedSeed = JSON.stringify({ ...seed, members: [{ ...members[0], token_sha256: digest(changedToken) }, members[1]] });
    await assert.rejects(initializeMemberSpace({ db, seedJson: changedSeed, request: setupRequest(changedToken) }), { code: 'setup_conflict', status: 409 });
    assert.deepEqual(db.sqlite.prepare('SELECT token_sha256, user_id, revoked_at FROM member_tokens WHERE space_id = ? ORDER BY user_id').all(spaceId).map((row) => ({ ...row })), members.map(({ actor_id, token_sha256 }) => ({ token_sha256, user_id: actor_id, revoked_at: null })));
  } finally { db.close(); }
});

test('setup refuses an empty registry when consultation history already exists', async () => {
  const db = await createDb();
  try {
    db.prepare('INSERT INTO messages(message_id,space_id,thread_id,kind,actor_id,body_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .bind('history-message', spaceId, null, 'expression', actors[0], '{}', '2026-10-08T00:00:00Z').run();
    await assert.rejects(initializeMemberSpace({ db, seedJson, request: setupRequest(tokens[0]) }), { code: 'setup_conflict', status: 409 });
    assert.deepEqual(await rowCounts(db), { members: 0, tokens: 0 });
  } finally { db.close(); }
});

test('a complete membership pair appearing after preflight cannot have its token registry auto-filled', async () => {
  const db = await createDb();
  try {
    db.beforeBatch = () => {
      for (const member of members) db.sqlite.prepare('INSERT INTO members(space_id,user_id,role) VALUES(?,?,?)').run(spaceId, member.actor_id, member.role);
    };
    await assert.rejects(initializeMemberSpace({ db, seedJson, request: setupRequest(tokens[0]) }), { code: 'setup_conflict', status: 409 });
    assert.deepEqual(await rowCounts(db), { members: 2, tokens: 0 });
  } finally { db.close(); }
});

test('concurrent setup calls are guarded by D1 batch SQL and both read back the single exact winner', async () => {
  const db = await createDb();
  try {
    const results = await Promise.all([
      initializeMemberSpace({ db, seedJson, request: setupRequest(tokens[0]) }),
      initializeMemberSpace({ db, seedJson, request: setupRequest(tokens[1]) }),
    ]);
    assert.deepEqual(results, [
      { status: 'initialized', actor_id: actors[0], role: roles[0] },
      { status: 'initialized', actor_id: actors[1], role: roles[1] },
    ]);
    assert.deepEqual(await rowCounts(db), { members: 2, tokens: 2 });
    assert.ok(db.batchCalls >= 1 && db.batchCalls <= 2);
  } finally { db.close(); }
});

test('a batch failure between member and token inserts rolls back the whole initialization', async () => {
  const db = await createDb();
  try {
    db.failStatementAt = 2;
    await assert.rejects(initializeMemberSpace({ db, seedJson, request: setupRequest(tokens[0]) }), (error) => error instanceof MemberSetupError && error.status === 503 && error.code === 'setup_unavailable');
    assert.deepEqual(await rowCounts(db), { members: 0, tokens: 0 });
  } finally { db.close(); }
});
