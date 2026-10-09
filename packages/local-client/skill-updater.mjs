import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { acquireLock } from './sync.mjs';

const EXPECTED = [
  'skills/local-therapist-assistant/SKILL.md',
  'skills/local-therapist-assistant/references/method.md',
  'skills/local-therapist-assistant/references/initialization.md',
];
const HASH = /^[0-9a-f]{64}$/;
const VERSION = /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[1-9][0-9]*$/;
const MAX_FILE_BYTES = 128 * 1024;
const MAX_BUNDLE_BYTES = 320 * 1024;
const BOOTSTRAP = '---\nname: local-therapist-assistant\ndescription: Help one partner privately understand an experience and shape a complete, editable expression for the shared relationship therapist.\n---\n\n# Local Therapist Assistant release entry\n\nRead current.json in this directory and verify its version, release_id, and SHA-256. Then load versions/<version>/skills/local-therapist-assistant/SKILL.md and referenced files from that same version directory. These Markdown files are the complete shared Skill release. Never execute package contents.\n\nUse the locally configured Therapist client for authenticated sync-and-update before each consultation and during the configured hourly heartbeat. The member configuration, connection configuration, message state directory, and Skill install directory are set up privately by the operator and stay outside shared Skill text. Personal drafts, preferences, and pending confirmation state also stay outside the Skill install directory.\n';

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function fail(message) { throw new Error(`Skill update stopped: ${message}`); }
function digest(version, files) { return createHash('sha256').update(JSON.stringify({ version, files }), 'utf8').digest('hex'); }
function releaseId(sha256) {
  const chars = sha256.slice(0, 32).split('');
  chars[12] = '5'; chars[16] = ((Number.parseInt(chars[16], 16) & 3) | 8).toString(16);
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function validateSkillRelease(value, notice) {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'files,release_id,sha256,version' || !VERSION.test(value.version) || !HASH.test(value.sha256) || typeof value.release_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.release_id) || !Array.isArray(value.files) || value.files.length !== EXPECTED.length) fail('release shape is invalid');
  const files = [];
  let byteTotal = 0;
  for (let index = 0; index < EXPECTED.length; index += 1) {
    const entry = value.files[index];
    if (!object(entry) || Object.keys(entry).sort().join(',') !== 'content,path' || entry.path !== EXPECTED[index] || typeof entry.content !== 'string') fail('release file list is invalid');
    const bytes = Buffer.from(entry.content, 'utf8');
    if (bytes.toString('utf8') !== entry.content || bytes.byteLength > MAX_FILE_BYTES) fail('release file encoding or size is invalid');
    byteTotal += bytes.byteLength;
    files.push({ path: entry.path, content: entry.content });
  }
  if (byteTotal > MAX_BUNDLE_BYTES) fail('release exceeds the size limit');
  const actual = digest(value.version, files);
  if (actual !== value.sha256 || releaseId(actual) !== value.release_id || (notice && (!object(notice) || Object.keys(notice).sort().join(',') !== 'release_id,sha256,version' || notice.version !== value.version || notice.sha256 !== value.sha256 || notice.release_id !== value.release_id))) fail('release digest does not match its notice');
  return { version: value.version, release_id: value.release_id, sha256: value.sha256, files };
}

async function privateDirectory(directory, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('install directory must be owner-private and must not be a symlink');
  return stat;
}
async function atomicWrite(directory, name, content, mode = 0o600) {
  const destination = path.join(directory, name);
  try {
    const stat = await lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail(`unsafe install file ${name}`);
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const temp = path.join(directory, `.${name}.${randomUUID()}.tmp`);
  const handle = await open(temp, 'wx', mode);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, destination);
  const dir = await open(directory, 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
async function readPointer(directory) {
  const file = path.join(directory, 'current.json');
  let stat;
  try { stat = await lstat(file); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('current release pointer is unsafe');
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  if (!object(parsed) || Object.keys(parsed).sort().join(',') !== 'release_id,sha256,version' || !VERSION.test(parsed.version) || !HASH.test(parsed.sha256) || typeof parsed.release_id !== 'string') fail('current release pointer is corrupt');
  return parsed;
}
async function verifyExistingRelease(directory, release) {
  await privateDirectory(directory);
  const files = [];
  for (const expected of release.files) {
    const filepath = path.join(directory, expected.path);
    const parentParts = expected.path.split('/').slice(0, -1);
    let parent = directory;
    for (const part of parentParts) { parent = path.join(parent, part); await privateDirectory(parent); }
    const stat = await lstat(filepath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('staged release contains an unsafe file');
    const content = await readFile(filepath, 'utf8');
    if (content !== expected.content) fail('staged release content does not match its digest');
    files.push({ path: expected.path, content });
  }
  return digest(release.version, files) === release.sha256;
}
async function installSkillReleaseUnlocked({ release: rawRelease, notice, installDirectory, consultationBusy = false }) {
  if (typeof installDirectory !== 'string' || !path.isAbsolute(installDirectory)) throw new TypeError('absolute installDirectory is required');
  if (typeof consultationBusy !== 'boolean') throw new TypeError('consultationBusy must be boolean');
  const release = validateSkillRelease(rawRelease, notice);
  await privateDirectory(installDirectory, true);
  const versions = path.join(installDirectory, 'versions');
  await privateDirectory(versions, true);
  const pointer = await readPointer(installDirectory);
  if (pointer?.version === release.version && pointer.sha256 === release.sha256 && pointer.release_id === release.release_id) {
    if (!await verifyExistingRelease(path.join(versions, release.version), release)) fail('active release does not match its pointer');
    await ensureBootstrap(installDirectory, false);
    return { installed: false, staged: false, version: release.version, release_id: release.release_id, sha256: release.sha256 };
  }
  if (pointer?.version === release.version) fail('version already exists with a different digest');

  const releaseDir = path.join(versions, release.version);
  let alreadyStaged = false;
  try {
    await lstat(releaseDir);
    if (!await verifyExistingRelease(releaseDir, release)) fail('version directory already exists with different content; inspect it manually');
    alreadyStaged = true;
  } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  if (!alreadyStaged) {
    const staging = path.join(versions, `.staging-${randomUUID()}`);
    await privateDirectory(staging, true);
    for (const file of release.files) {
      const destination = path.join(staging, file.path);
      const parent = path.dirname(destination);
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await privateDirectory(parent);
      const handle = await open(destination, 'wx', 0o600);
      try { await handle.writeFile(file.content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    }
    const directories = [path.join(staging, 'skills/local-therapist-assistant/references'), path.join(staging, 'skills/local-therapist-assistant'), path.join(staging, 'skills'), staging];
    for (const directory of directories) { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
    await rename(staging, releaseDir);
    const versionHandle = await open(versions, 'r'); try { await versionHandle.sync(); } finally { await versionHandle.close(); }
  }
  if (consultationBusy) return { installed: false, staged: true, version: release.version, release_id: release.release_id, sha256: release.sha256 };
  await ensureBootstrap(installDirectory, true);
  await atomicWrite(installDirectory, 'current.json', `${JSON.stringify({ version: release.version, release_id: release.release_id, sha256: release.sha256 })}\n`);
  return { installed: true, staged: false, version: release.version, release_id: release.release_id, sha256: release.sha256 };
}

async function ensureBootstrap(directory, create) {
  const bootstrapPath = path.join(directory, 'SKILL.md');
  try {
    const stat = await lstat(bootstrapPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid()) || await readFile(bootstrapPath, 'utf8') !== BOOTSTRAP) fail('existing Skill entry point is not the known bootstrap');
  } catch (error) {
    if (error?.code !== 'ENOENT' || !create) throw error;
    await atomicWrite(directory, 'SKILL.md', BOOTSTRAP);
  }
}
export async function installSkillRelease(options) {
  if (!options || typeof options.installDirectory !== 'string' || !path.isAbsolute(options.installDirectory)) throw new TypeError('absolute installDirectory is required');
  await privateDirectory(options.installDirectory, true);
  const unlock = await acquireLock(options.installDirectory);
  try { return await installSkillReleaseUnlocked(options); }
  finally { await unlock(); }
}

export async function updateSkillRelease({ client, notice, installDirectory, consultationBusy = false }) {
  if (!client || typeof client.getSkillRelease !== 'function') throw new TypeError('client.getSkillRelease is required');
  if (!notice) fail('authenticated sync did not include a Skill release notice');
  if (typeof installDirectory !== 'string' || !path.isAbsolute(installDirectory)) throw new TypeError('absolute installDirectory is required');
  await privateDirectory(installDirectory, true);
  const unlock = await acquireLock(installDirectory);
  try {
    const bundle = await client.getSkillRelease();
    return await installSkillReleaseUnlocked({ release: bundle, notice, installDirectory, consultationBusy });
  } finally { await unlock(); }
}
