import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, lstat, rm, mkdir, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncFormalMessages } from '../../packages/local-client/sync.mjs';

const member = { actor_id: 'partner-husband', role: 'husband', space_id: '123e4567-e89b-42d3-a456-426614174000', member_token: 't'.repeat(43) };
const other = { actor_id: 'partner-wife', role: 'wife', space_id: member.space_id, member_token: 'w'.repeat(43) };
const id1 = '123e4567-e89b-42d3-a456-426614174001';
const id2 = '123e4567-e89b-42d3-a456-426614174002';
function record(message_id, seq, actor_id = member.actor_id) { return { message_id, space_id: member.space_id, thread_id: id1, seq, kind: 'member_expression', actor_id, body: { text: `entry ${seq}` }, created_at: '2026-10-08T00:00:00.000Z' }; }
function page(items, { snapshot_seq = 2, has_more = false, next_after_id = items.at(-1)?.message_id ?? null } = {}) { return { items, snapshot_seq, has_more, next_after_id }; }
async function temp(t) { const root = await mkdtemp(path.join(os.tmpdir(), 'local-agent-sync-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }

test('sync persists formal records before advancing and resumes the retained snapshot', async (t) => {
  const root = await temp(t); let failSecondPage = true; const calls = [];
  const client = { async getUpdates(args) {
    calls.push(args);
    if (args.after_message_id === id2) return page([], { next_after_id: id2 });
    if (args.after_message_id === null) return page([record(id1, 1)], { has_more: true });
    if (failSecondPage) throw new Error('offline');
    return page([record(id2, 2)], { has_more: false });
  } };
  await assert.rejects(syncFormalMessages({ client, member, stateDirectory: root }), /offline/);
  const statePath = path.join(root, 'sync-state.json');
  const afterFailure = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(afterFailure.cursor_message_id, id1);
  assert.equal(afterFailure.snapshot_seq, 2);
  assert.equal(JSON.parse(await readFile(path.join(root, `${id1}.json`), 'utf8')).message_id, id1);
  failSecondPage = false;
  const result = await syncFormalMessages({ client, member, stateDirectory: root });
  assert.equal(result.saved, 1); assert.equal(result.cursor, id2); assert.equal(result.complete, true);
  assert.equal(calls.at(-1).snapshot_seq, 2);
  const completed = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(completed.snapshot_seq, null); assert.equal(completed.cursor_message_id, id2);
  const repeated = await syncFormalMessages({ client, member, stateDirectory: root });
  assert.equal(repeated.duplicates, 0); assert.equal(repeated.saved, 0);
});

test('foreign scope and immutable UUID conflicts stop without cursor advancement', async (t) => {
  const root = await temp(t);
  const foreign = { ...record(id1, 1), space_id: '123e4567-e89b-42d3-a456-426614174099' };
  const client = { getUpdates: async () => page([foreign]) };
  await assert.rejects(syncFormalMessages({ client, member, stateDirectory: root }), /scope or sequence/);
  assert.equal(await lstat(path.join(root, 'sync-state.json')).then(() => true, () => false), false);
  const existing = record(id1, 1); existing.body.text = 'changed';
  await writeFile(path.join(root, `${id1}.json`), JSON.stringify(existing), { mode: 0o600 });
  const valid = { getUpdates: async () => page([record(id1, 1)]) };
  await assert.rejects(syncFormalMessages({ client: valid, member, stateDirectory: root }), /immutable message/);
  const conflictState = JSON.parse(await readFile(path.join(root, 'sync-state.json'), 'utf8'));
  assert.equal(conflictState.cursor_message_id, null); assert.equal(conflictState.snapshot_seq, 2);
});

test('parallel invocation refuses a live lock and private member states stay separate', async (t) => {
  const root = await temp(t); const firstDir = path.join(root, 'husband'); const secondDir = path.join(root, 'wife');
  let release; let entered; const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const blocker = new Promise((resolve) => { release = resolve; });
  const clientA = { async getUpdates() { entered(); await blocker; return page([],{snapshot_seq:0}); } };
  const running = syncFormalMessages({ client: clientA, member, stateDirectory: firstDir });
  await enteredPromise;
  await assert.rejects(syncFormalMessages({ client: { getUpdates: async () => page([],{snapshot_seq:0}) }, member, stateDirectory: firstDir }), /live process owns/);
  release(); await running;
  await syncFormalMessages({ client: { getUpdates: async () => page([record(id1, 1, other.actor_id)]) }, member: other, stateDirectory: secondDir });
  const husbandState = JSON.parse(await readFile(path.join(firstDir, 'sync-state.json'), 'utf8'));
  assert.equal(husbandState.actor_id, member.actor_id);
  assert.equal(JSON.parse(await readFile(path.join(secondDir, `${id1}.json`), 'utf8')).actor_id, other.actor_id);
  assert.equal(JSON.parse(await readFile(path.join(secondDir, 'sync-state.json'), 'utf8')).actor_id, other.actor_id);
});

test('state symlinks and malformed page cursors fail closed', async (t) => {
  const root = await temp(t); const outside = path.join(root, 'outside'); const state = path.join(root, 'state');
  await mkdir(state, { mode: 0o700 }); await writeFile(outside, '{}', { mode: 0o600 });
  const { symlink } = await import('node:fs/promises'); await symlink(outside, path.join(state, 'sync-state.json'));
  await assert.rejects(syncFormalMessages({ client: { getUpdates: async () => page([],{snapshot_seq:0}) }, member, stateDirectory: state }), /unsafe state file/);
  await rm(path.join(state, 'sync-state.json'));
  const malformed = { getUpdates: async () => page([record(id1, 1)], { next_after_id: id2 }) };
  await assert.rejects(syncFormalMessages({ client: malformed, member, stateDirectory: state }), /cursor does not match/);
});

test('a failed message-file read leaves the old cursor and retained batch available for retry', async (t) => {
  const root = await temp(t); const badPath = path.join(root, `${id1}.json`);
  await mkdir(badPath, { mode: 0o700 });
  const client = { getUpdates: async () => page([record(id1, 1)]) };
  await assert.rejects(syncFormalMessages({ client, member, stateDirectory: root }), /unsafe state file/);
  const state = JSON.parse(await readFile(path.join(root, 'sync-state.json'), 'utf8'));
  assert.equal(state.cursor_message_id, null);
  assert.equal(state.previous_seq, 0);
  assert.equal(state.snapshot_seq, 2);
  await rmdir(badPath);
  const result = await syncFormalMessages({ client, member, stateDirectory: root });
  assert.equal(result.cursor, id1); assert.equal(result.saved, 1); assert.equal(result.complete, true);
});

test('stale-claim cleanup cannot unlink a later unique live owner claim', async (t) => {
  const root = await temp(t); const lockDirectory = path.join(root, '.sync-locks');
  await mkdir(lockDirectory, { mode: 0o700 });
  const stalePid = process.pid + 10_000_000;
  const staleNonce = '123e4567-e89b-42d3-a456-426614174009';
  const stalePath = path.join(lockDirectory, `claim-${stalePid}-${staleNonce}.json`);
  await writeFile(stalePath, `${JSON.stringify({ pid: stalePid, nonce: staleNonce })}\n`, { mode: 0o600 });
  let releaseFetch; let enteredFetch; const entered = new Promise((resolve) => { enteredFetch = resolve; });
  const blocked = new Promise((resolve) => { releaseFetch = resolve; });
  const client = { async getUpdates() { enteredFetch(); await blocked; return page([],{snapshot_seq:0}); } };
  const running = syncFormalMessages({ client, member, stateDirectory: root });
  await entered;
  assert.equal(await lstat(stalePath).then(() => true, () => false), false);
  const liveNonce = '123e4567-e89b-42d3-a456-426614174010';
  const livePath = path.join(lockDirectory, `claim-${process.pid}-${liveNonce}.json`);
  await writeFile(livePath, `${JSON.stringify({ pid: process.pid, nonce: liveNonce })}\n`, { mode: 0o600 });
  releaseFetch(); await running;
  assert.equal(await lstat(livePath).then(() => true, () => false), true);
});

test('overlapping claimants never run synchronization concurrently, including with stale claims', async (t) => {
  const root = await temp(t); const lockDirectory = path.join(root, '.sync-locks');
  await mkdir(lockDirectory, { mode: 0o700 });
  const stalePid = process.pid + 10_000_001;
  const staleNonce = '123e4567-e89b-42d3-a456-426614174011';
  await writeFile(path.join(lockDirectory, `claim-${stalePid}-${staleNonce}.json`), `${JSON.stringify({ pid: stalePid, nonce: staleNonce })}\n`, { mode: 0o600 });
  let fetchCount = 0; let releaseFetch; let enteredFetch; const entered = new Promise((resolve) => { enteredFetch = resolve; });
  const blocker = new Promise((resolve) => { releaseFetch = resolve; });
  const client = { async getUpdates() { fetchCount += 1; enteredFetch(); await blocker; return page([],{snapshot_seq:0}); } };
  const first = syncFormalMessages({ client, member, stateDirectory: root });
  await entered;
  await assert.rejects(syncFormalMessages({ client, member, stateDirectory: root }), /live process owns/);
  assert.equal(fetchCount, 1);
  releaseFetch(); await first;
  assert.equal(fetchCount, 1);
});

test('actual updates records with string, array, and null bodies remain intact', async (t) => {
  const root = await temp(t);
  const ids = [id1, id2, '123e4567-e89b-42d3-a456-426614174003'];
  const bodies = ['legacy plain text', ['legacy', 2, null], null];
  const records = ids.map((message_id, index) => ({ ...record(message_id, index + 1), body: bodies[index] }));
  const result = await syncFormalMessages({ client: { getUpdates: async () => page(records, { snapshot_seq: 3 }) }, member, stateDirectory: root });
  assert.equal(result.saved, 3);
  for (let index = 0; index < ids.length; index += 1) {
    const saved = JSON.parse(await readFile(path.join(root, `${ids[index]}.json`), 'utf8'));
    assert.deepEqual(saved, records[index]);
  }
});

test('simultaneous stale-claim cleanup keeps unique live claims and never overlaps sync work', async (t) => {
  const root = await temp(t); const lockDirectory = path.join(root, '.sync-locks');
  await mkdir(lockDirectory, { mode: 0o700 });
  const stalePid = process.pid + 10_000_002;
  const staleNonce = '123e4567-e89b-42d3-a456-426614174012';
  const stalePath = path.join(lockDirectory, `claim-${stalePid}-${staleNonce}.json`);
  await writeFile(stalePath, `${JSON.stringify({ pid: stalePid, nonce: staleNonce })}\n`, { mode: 0o600 });
  let callCount = 0; let releaseFetch; let enteredFetch; const entered = new Promise((resolve) => { enteredFetch = resolve; });
  const blocker = new Promise((resolve) => { releaseFetch = resolve; });
  const client = { async getUpdates() { callCount += 1; enteredFetch(); await blocker; return page([],{snapshot_seq:0}); } };
  const runs = [
    syncFormalMessages({ client, member, stateDirectory: root }),
    syncFormalMessages({ client, member, stateDirectory: root }),
  ];
  const outcomesPromise = Promise.allSettled(runs);
  await Promise.race([entered, new Promise((resolve) => setTimeout(resolve, 100))]);
  if (callCount > 0) {
    assert.equal(callCount, 1);
    assert.equal(await lstat(stalePath).then(() => true, () => false), false);
    const claimFiles = (await (await import('node:fs/promises')).readdir(lockDirectory)).filter((name) => name.startsWith('claim-'));
    assert.equal(claimFiles.length, 1);
    const activeClaim = JSON.parse(await readFile(path.join(lockDirectory, claimFiles[0]), 'utf8'));
    assert.equal(activeClaim.pid, process.pid);
  }
  releaseFetch();
  const outcomes = await outcomesPromise;
  assert.ok(outcomes.filter((outcome) => outcome.status === 'fulfilled').length <= 1);
  assert.ok(callCount <= 1);
  assert.equal(await lstat(stalePath).then(() => true, () => false), false);
  assert.deepEqual((await (await import('node:fs/promises')).readdir(lockDirectory)).filter((name) => name.startsWith('claim-')), []);
});
