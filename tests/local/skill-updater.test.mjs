import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { installSkillRelease, updateSkillRelease, validateSkillRelease } from '../../packages/local-client/skill-updater.mjs';
import { acquireLock } from '../../packages/local-client/sync.mjs';
import { createAgentClient } from '../../packages/local-client/client.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sourcePath = path.join(root, 'skills/local-therapist-assistant/release-bundle.json');
const canonical = async () => JSON.parse(await readFile(sourcePath, 'utf8'));
function rehash(release) {
  release.sha256 = createHash('sha256').update(JSON.stringify({ version: release.version, files: release.files }), 'utf8').digest('hex');
  const chars = release.sha256.slice(0, 32).split(''); chars[12] = '5'; chars[16] = ((Number.parseInt(chars[16], 16) & 3) | 8).toString(16);
  const hex = chars.join(''); release.release_id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return release;
}
const notice = ({ version, release_id, sha256 }) => ({ version, release_id, sha256 });
async function temp() { const dir = await mkdtemp(path.join(os.tmpdir(), 'skill-release-')); await chmod(dir, 0o700); return dir; }

test('checked release bundle matches the deterministic source generator output', async () => {
  const before = await readFile(sourcePath, 'utf8');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await promisify(execFile)(process.execPath, ['scripts/build-skill-release.mjs'], { cwd: root });
  assert.equal(await readFile(sourcePath, 'utf8'), before);
  const release = validateSkillRelease(JSON.parse(before));
  assert.equal(release.files.length, 3);
});

test('installation atomically publishes pointer, preserves unrelated state, and same release is a no-op', async () => {
  const directory = await temp();
  try {
    const personal = path.join(directory, 'draft.json');
    await writeFile(personal, '{"private":"draft"}\n', { mode: 0o600 });
    const release = await canonical();
    const first = await installSkillRelease({ release, notice: notice(release), installDirectory: directory });
    assert.equal(first.installed, true);
    const second = await installSkillRelease({ release, notice: notice(release), installDirectory: directory });
    assert.equal(second.installed, false);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'current.json'), 'utf8')), notice(release));
    assert.equal(await readFile(personal, 'utf8'), '{"private":"draft"}\n');
    assert.equal((await lstat(path.join(directory, 'versions', release.version))).isDirectory(), true);
    assert.match(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), /^---\nname: local-therapist-assistant\n/);
    assert.match(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), /current\.json/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('changed release switches pointer only after complete files and leaves old release available', async () => {
  const directory = await temp();
  try {
    const old = await canonical();
    await installSkillRelease({ release: old, notice: notice(old), installDirectory: directory });
    const next = await canonical(); next.version = '2026-10-08.4'; next.files[1].content += '\nRelease addition.\n'; rehash(next);
    const staged = await installSkillRelease({ release: next, notice: notice(next), installDirectory: directory, consultationBusy: true });
    assert.equal(staged.staged, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'current.json'), 'utf8')), notice(old));
    const result = await installSkillRelease({ release: next, notice: notice(next), installDirectory: directory });
    assert.equal(result.version, next.version);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'current.json'), 'utf8')), notice(next));
    assert.equal(await readFile(path.join(directory, 'versions', old.version, 'skills/local-therapist-assistant/references/method.md'), 'utf8'), old.files[1].content);
    assert.equal(await readFile(path.join(directory, 'versions', next.version, next.files[1].path), 'utf8'), next.files[1].content);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('hash mismatch, changed same-version digest, and unsafe file names fail before pointer publication', async () => {
  const directory = await temp();
  try {
    const release = await canonical();
    await assert.rejects(installSkillRelease({ release, notice: { ...notice(release), sha256: '0'.repeat(64) }, installDirectory: directory }), /digest/);
    release.files[0].path = '../../outside.md';
    rehash(release);
    await assert.rejects(installSkillRelease({ release, notice: notice(release), installDirectory: directory }), /file list/);
    assert.equal(await readFile(path.join(directory, 'current.json')).then(() => true, () => false), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unsafe symlink directories are refused and an announcement can be retried without changing cursor state', async () => {
  const base = await temp(); const target = await temp();
  try {
    const link = path.join(base, 'install'); await symlink(target, link);
    const release = await canonical();
    await assert.rejects(installSkillRelease({ release, notice: notice(release), installDirectory: link }), /owner-private/);
    const statePath = path.join(base, 'cursor.json');
    const cursor = '{"cursor":"unchanged"}\n';
    await writeFile(statePath, cursor, { mode: 0o600 });
    const flaky = { getSkillRelease: async () => { throw new Error('temporary response failure'); } };
    await assert.rejects(updateSkillRelease({ client: flaky, notice: notice(release), installDirectory: path.join(base, 'safe') }), /temporary response failure/);
    assert.equal(await readFile(statePath, 'utf8'), cursor);
    const retry = { getSkillRelease: async () => release };
    assert.equal((await updateSkillRelease({ client: retry, notice: notice(release), installDirectory: path.join(base, 'safe') })).installed, true);
  } finally { await rm(base, { recursive: true, force: true }); await rm(target, { recursive: true, force: true }); }
});

test('install lock spans release publication and existing nested symlinks are rejected on no-op', async () => {
  const directory = await temp();
  try {
    const release = await canonical();
    const unlock = await acquireLock(directory);
    await assert.rejects(installSkillRelease({ release, notice: notice(release), installDirectory: directory }), /live process owns/);
    await unlock();
    await installSkillRelease({ release, notice: notice(release), installDirectory: directory });
    const referenceDir = path.join(directory, 'versions', release.version, 'skills/local-therapist-assistant/references');
    const backup = path.join(directory, 'references-backup');
    await import('node:fs/promises').then(({ rename }) => rename(referenceDir, backup));
    await symlink(backup, referenceDir);
    await assert.rejects(installSkillRelease({ release, notice: notice(release), installDirectory: directory }), /private and must not be a symlink/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('authenticated release fetch runs under the install lock', async () => {
  const directory = await temp();
  try {
    const release = await canonical();
    let enteredFetch; let continueFetch;
    const entered = new Promise((resolve) => { enteredFetch = resolve; });
    const hold = new Promise((resolve) => { continueFetch = resolve; });
    const updating = updateSkillRelease({ client: { async getSkillRelease() { enteredFetch(); await hold; return release; } }, notice: notice(release), installDirectory: directory });
    await entered;
    await assert.rejects(installSkillRelease({ release, notice: notice(release), installDirectory: directory }), /live process owns/);
    continueFetch();
    assert.equal((await updating).installed, true);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'current.json'), 'utf8')), notice(release));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('release bundle uses the configured fixed origin and member authentication headers', async () => {
  const calls = [];
  const member = { actor_id: 'partner-husband', role: 'husband', space_id: '00000000-0000-4000-8000-000000000001', member_token: 'A'.repeat(43) };
  const connection = { base_url: 'https://private.example', site_access_token: 'site-access' };
  const client = createAgentClient({ member, connection, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(await canonical()), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const release = await client.getSkillRelease();
  assert.equal(release.version, (await canonical()).version);
  assert.equal(calls[0].url, 'https://private.example/api/skill/release');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${member.member_token}`);
  assert.equal(calls[0].options.headers['OAI-Sites-Authorization'], 'Bearer site-access');
  assert.equal(calls[0].options.redirect, 'manual');
});
