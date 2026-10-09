import { open, lstat, mkdir, readFile, rename, unlink, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateMember } from './client.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAGES_PER_RUN = 1000;
const MAX_SYNC_BYTES = 32 * 1024 * 1024;
function fail(message) { throw new Error(`Sync stopped: ${message}`); }
function assertUuid(value, label) { if (typeof value !== 'string' || !UUID.test(value)) fail(`${label} is not a UUID`); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail('state directory must be a private, non-symlink directory');
}
async function assertSafeFile(file, { missing = true } = {}) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail(`refusing unsafe state file ${path.basename(file)}`);
    return stat;
  } catch (error) {
    if (error?.code === 'ENOENT' && missing) return null;
    throw error;
  }
}
async function atomicJson(directory, filename, value) {
  const target = path.join(directory, filename);
  await assertSafeFile(target);
  const temp = path.join(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(temp, target);
    const dirHandle = await open(directory, 'r');
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } catch (error) {
    if (handle) await handle.close();
    try { await unlink(temp); } catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') throw cleanupError; }
    throw error;
  }
}
async function readJson(file) {
  const stat = await assertSafeFile(file);
  if (!stat) return null;
  if (stat.size > MAX_SYNC_BYTES) fail(`state file ${path.basename(file)} exceeds the size limit`);
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { fail(`state file ${path.basename(file)} is corrupt (${error instanceof SyntaxError ? 'invalid JSON' : 'read failure'})`); }
}
function validState(state, member) {
  if (!state || Object.getPrototypeOf(state) !== Object.prototype || JSON.stringify(Object.keys(state).sort()) !== JSON.stringify(['actor_id', 'cursor_message_id', 'previous_seq', 'snapshot_seq', 'space_id', 'version']) || state.version !== 1 || state.actor_id !== member.actor_id || state.space_id !== member.space_id || (state.cursor_message_id !== null && !UUID.test(state.cursor_message_id)) || (state.snapshot_seq !== null && (!Number.isSafeInteger(state.snapshot_seq) || state.snapshot_seq < 0)) || !Number.isSafeInteger(state.previous_seq) || state.previous_seq < 0) fail('sync metadata is corrupt or belongs to another member');
  if ((state.cursor_message_id === null) !== (state.previous_seq === 0)) fail('sync cursor metadata is inconsistent');
  return state;
}
function validatePage(page, { member, requestedCursor, requestedSnapshot, previousSeq }) {
  if (!page || Object.getPrototypeOf(page) !== Object.prototype || !Array.isArray(page.items) || typeof page.has_more !== 'boolean' || !Number.isSafeInteger(page.snapshot_seq) || page.snapshot_seq < 0 || !(page.next_after_id === null || typeof page.next_after_id === 'string')) fail('server page shape is invalid');
  if (requestedSnapshot !== null && page.snapshot_seq !== requestedSnapshot) fail('server changed the retained snapshot');
  if (page.items.length > 100) fail('server returned more than the requested page size');
  const seen = new Set(); let seq = previousSeq; let lastId = requestedCursor;
  for (const item of page.items) {
    if (!item || Object.getPrototypeOf(item) !== Object.prototype || JSON.stringify(Object.keys(item).sort()) !== JSON.stringify(['actor_id', 'body', 'created_at', 'kind', 'message_id', 'seq', 'space_id', 'thread_id'])) fail('server returned a malformed record');
    assertUuid(item.message_id, 'message_id');
    if (item.space_id !== member.space_id || (item.thread_id !== null && (typeof item.thread_id !== 'string' || !UUID.test(item.thread_id))) || typeof item.actor_id !== 'string' || !item.actor_id || typeof item.kind !== 'string' || !item.kind || typeof item.created_at !== 'string' || !item.created_at || !Object.hasOwn(item, 'body') || JSON.stringify(item.body) === undefined || !Number.isSafeInteger(item.seq) || item.seq <= seq || item.seq > page.snapshot_seq) fail('server record scope or sequence is invalid');
    if (seen.has(item.message_id)) fail('server returned a duplicate UUID within one page');
    seen.add(item.message_id); seq = item.seq; lastId = item.message_id;
  }
  if (page.items.length && page.next_after_id !== lastId) fail('server page cursor does not match its last record');
  if (!page.items.length && page.next_after_id !== requestedCursor) fail('empty page changed its cursor');
  if (page.has_more && page.items.length === 0) fail('server returned an empty page with has_more');
  if (page.has_more && (page.items.length < 1 || seq >= page.snapshot_seq)) fail('server paging marker is inconsistent with its snapshot');
  return { nextCursor: lastId, nextSeq: seq, snapshotSeq: page.snapshot_seq };
}
async function acquireLock(directory) {
  const lockDirectory = path.join(directory, '.sync-locks');
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(lockDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) fail('sync lock directory must be private and must not be a symlink');
  const nonce = randomUUID();
  const claimName = `claim-${process.pid}-${nonce}.json`;
  const claimPath = path.join(lockDirectory, claimName);
  const claim = { pid: process.pid, nonce };
  const claimText = `${JSON.stringify(claim)}\n`;
  const tempPath = path.join(lockDirectory, `.pending-${process.pid}-${nonce}`);
  let handle;
  let published = false;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(claimText, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(tempPath, claimPath);
    published = true;
    const dirHandle = await open(lockDirectory, 'r');
    try { await dirHandle.sync(); } finally { await dirHandle.close(); }
  } catch (error) {
    if (handle) await handle.close();
    try { await unlink(tempPath); } catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') throw cleanupError; }
    if (published) {
      try { if (await readFile(claimPath, 'utf8') === claimText) await unlink(claimPath); } catch (cleanupError) { if (cleanupError?.code !== 'ENOENT') throw cleanupError; }
    }
    throw error;
  }

  async function removeOwnedClaim() {
    try {
      const first = await readFile(claimPath, 'utf8');
      const firstStat = await lstat(claimPath);
      const second = await readFile(claimPath, 'utf8');
      if (first === claimText && second === first && firstStat.isFile() && !firstStat.isSymbolicLink()) await unlink(claimPath);
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }

  try {
    const entries = await readdir(lockDirectory);
    let liveConflict = false;
    for (const entry of entries) {
      if (entry.startsWith('.pending-')) continue;
      const match = /^claim-([1-9][0-9]*)-([0-9a-f-]{36})\.json$/.exec(entry);
      if (!match) fail('sync lock directory contains an unknown entry; inspect it manually');
      const otherPath = path.join(lockDirectory, entry);
      let otherStat; let raw;
      try { otherStat = await lstat(otherPath); raw = await readFile(otherPath, 'utf8'); }
      catch (readError) { if (readError?.code === 'ENOENT') continue; throw readError; }
      if (!otherStat.isFile() || otherStat.isSymbolicLink() || (otherStat.mode & 0o077) !== 0) fail('sync lock claim is unsafe; inspect it manually');
      let owner;
      try { owner = JSON.parse(raw); } catch { fail('sync lock claim is corrupt; inspect it manually'); }
      const ownerPid = Number(match[1]);
      if (!Number.isSafeInteger(ownerPid) || ownerPid < 1 || !UUID.test(match[2])) fail('sync lock filename is malformed; inspect it manually');
      if (!owner || Object.getPrototypeOf(owner) !== Object.prototype || JSON.stringify(Object.keys(owner).sort()) !== '["nonce","pid"]' || owner.pid !== ownerPid || owner.nonce !== match[2]) fail('sync lock claim does not match its filename; inspect it manually');
      if (entry === claimName) continue;
      let alive = true;
      try { process.kill(ownerPid, 0); }
      catch (probeError) {
        if (probeError?.code === 'ESRCH') alive = false;
        else fail('cannot prove a sync lock owner is gone; inspect it manually');
      }
      if (alive) { liveConflict = true; continue; }
      try {
        const beforeDelete = await lstat(otherPath);
        const verifyText = await readFile(otherPath, 'utf8');
        if (!beforeDelete.isFile() || beforeDelete.isSymbolicLink() || beforeDelete.dev !== otherStat.dev || beforeDelete.ino !== otherStat.ino || verifyText !== raw) fail('stale sync lock claim changed during owner check');
        await unlink(otherPath);
      } catch (unlinkError) { if (unlinkError?.code !== 'ENOENT') throw unlinkError; }
    }
    if (liveConflict) fail('another live process owns the sync lock');
  } catch (error) {
    await removeOwnedClaim();
    throw error;
  }
  return removeOwnedClaim;
}

export async function syncFormalMessages({ client, member: rawMember, stateDirectory }) {
  const member = validateMember(rawMember);
  if (!client || typeof client.getUpdates !== 'function' || typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory)) throw new TypeError('client and absolute stateDirectory are required');
  await ensurePrivateDirectory(stateDirectory);
  const release = await acquireLock(stateDirectory);
  const result = { saved: 0, duplicates: 0, cursor: null, snapshot_seq: null, complete: false };
  try {
    const metaPath = path.join(stateDirectory, 'sync-state.json');
    let state = await readJson(metaPath);
    if (state) validState(state, member);
    else state = { version: 1, actor_id: member.actor_id, space_id: member.space_id, cursor_message_id: null, previous_seq: 0, snapshot_seq: null };
    if (state.snapshot_seq === null) {
      // A previous completed batch starts from its durable cursor with a fresh server snapshot.
      state = { ...state, snapshot_seq: null };
    }
    let completed = false;
    for (let pageNo = 0; pageNo < MAX_PAGES_PER_RUN; pageNo += 1) {
      const page = await client.getUpdates({ after_message_id: state.cursor_message_id, snapshot_seq: state.snapshot_seq, limit: 100 });
      const validated = validatePage(page, { member, requestedCursor: state.cursor_message_id, requestedSnapshot: state.snapshot_seq, previousSeq: state.previous_seq });
      if (state.snapshot_seq === null) {
        state = { ...state, snapshot_seq: validated.snapshotSeq };
        await atomicJson(stateDirectory, 'sync-state.json', state);
      }
      if (validated.nextSeq < state.previous_seq || (validated.nextSeq === state.previous_seq && page.items.length)) fail('server sequence did not advance');
      const pageBytes = new TextEncoder().encode(JSON.stringify(page)).byteLength;
      if (pageBytes > MAX_SYNC_BYTES) fail('server page exceeds the in-memory size limit');
      for (const item of page.items) {
        const filepath = path.join(stateDirectory, `${item.message_id}.json`);
        const existing = await readJson(filepath);
        if (existing) {
          if (!same(existing, item)) fail(`immutable message ${item.message_id} changed`);
          result.duplicates += 1;
        } else {
          await atomicJson(stateDirectory, `${item.message_id}.json`, item);
          result.saved += 1;
        }
      }
      state = { version: 1, actor_id: member.actor_id, space_id: member.space_id, cursor_message_id: validated.nextCursor, previous_seq: validated.nextSeq, snapshot_seq: state.snapshot_seq };
      await atomicJson(stateDirectory, 'sync-state.json', state);
      result.cursor = state.cursor_message_id; result.snapshot_seq = state.snapshot_seq;
      if (!page.has_more) {
        state = { ...state, snapshot_seq: null };
        await atomicJson(stateDirectory, 'sync-state.json', state);
        result.snapshot_seq = null; result.complete = true; completed = true; break;
      }
    }
    if (!completed) fail(`page limit reached; resume from cursor ${result.cursor ?? 'start'} and retained snapshot`);
    return result;
  } finally { await release(); }
}
