import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { provisionMemberTokens } from '../../scripts/provision-member-tokens.mjs';

const hashToken = (token) => createHash('sha256').update(token).digest('hex');

test('provisioning creates two private member configs and hash-only seed SQL, then reuses them without rotation', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'member-token-provisioning-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(rootDir, { recursive: true, force: true }); });

  const first = await provisionMemberTokens({ rootDir });
  const directoryMode = (await stat(first.directory)).mode & 0o777;
  assert.equal(directoryMode, 0o700);
  assert.equal(first.created, true);
  const names = (await readdir(first.directory)).sort();
  assert.deepEqual(names, ['partner-husband.json', 'partner-wife.json', 'seed.sql']);

  const configs = await Promise.all(['partner-husband.json', 'partner-wife.json'].map(async (name) => {
    const filepath = path.join(first.directory, name);
    assert.equal((await stat(filepath)).mode & 0o777, 0o600);
    return JSON.parse(await readFile(filepath, 'utf8'));
  }));
  assert.deepEqual(configs.map(({ actor_id, role }) => [actor_id, role]), [['partner-husband', 'member'], ['partner-wife', 'member']]);
  assert.equal(configs[0].space_id, configs[1].space_id);
  assert.notEqual(configs[0].member_token, configs[1].member_token);
  assert.ok(configs.every(({ member_token }) => /^[A-Za-z0-9_-]{43}$/.test(member_token)));
  const seed = await readFile(path.join(first.directory, 'seed.sql'), 'utf8');
  for (const config of configs) {
    assert.ok(seed.includes(hashToken(config.member_token)));
    assert.ok(!seed.includes(config.member_token));
  }

  const before = await Promise.all(names.map((name) => readFile(path.join(first.directory, name), 'utf8')));
  const second = await provisionMemberTokens({ rootDir });
  assert.equal(second.created, false);
  assert.deepEqual(await Promise.all(names.map((name) => readFile(path.join(second.directory, name), 'utf8'))), before);
  assert.ok(!JSON.stringify(second).includes(configs[0].member_token));
});

test('provisioning refuses partial configurations instead of replacing or rotating them', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'member-token-partial-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(rootDir, { recursive: true, force: true }); });
  const first = await provisionMemberTokens({ rootDir });
  const configPath = path.join(first.directory, 'partner-husband.json');
  const original = await readFile(configPath, 'utf8');
  await import('node:fs/promises').then(({ unlink }) => unlink(path.join(first.directory, 'partner-wife.json')));
  await assert.rejects(provisionMemberTokens({ rootDir }), /partial/);
  assert.equal(await readFile(configPath, 'utf8'), original);
});

test('provisioning refuses private-directory permission drift', async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'member-token-permissions-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(rootDir, { recursive: true, force: true }); });
  const first = await provisionMemberTokens({ rootDir });
  await chmod(first.directory, 0o755);
  await assert.rejects(provisionMemberTokens({ rootDir }), /unsafe local member directory/);
});
