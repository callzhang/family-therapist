import assert from 'node:assert/strict';
import test from 'node:test';
import { createNdjsonWorkStream } from '../../sites/family-therapist/src/server/ndjson-work-stream.mjs';

async function nextFrame(reader) {
  const { value, done } = await reader.read();
  assert.equal(done, false);
  return JSON.parse(new TextDecoder().decode(value));
}

test('sends started before an unresolved worker and keepalives until its safe result resolves', async () => {
  let resolveWork;
  let started = false;
  const pending = new Promise((resolve) => { resolveWork = resolve; });
  const response = createNdjsonWorkStream(async () => { started = true; return pending; }, { intervalMs: 10 });
  assert.equal(response.headers.get('cache-control'), 'private, no-store, no-transform');
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  const reader = response.body.getReader();
  assert.deepEqual(await nextFrame(reader), { event: 'started' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, true);
  assert.deepEqual(await nextFrame(reader), { event: 'keepalive' });
  resolveWork({ status: 'failed', error_code: 'provider_transport_error' });
  assert.deepEqual(await nextFrame(reader), { event: 'result', result: { status: 'failed', error_code: 'provider_transport_error' } });
  assert.deepEqual(await reader.read(), { value: undefined, done: true });
});

test('worker errors send only a safe error frame and then close', async () => {
  const response = createNdjsonWorkStream(async () => { throw new Error('sensitive model and prompt'); }, { intervalMs: 10 });
  const reader = response.body.getReader();
  assert.deepEqual(await nextFrame(reader), { event: 'started' });
  assert.deepEqual(await nextFrame(reader), { event: 'error', code: 'worker_unavailable' });
  assert.deepEqual(await reader.read(), { value: undefined, done: true });
});

test('cancel stops further frames and aborts the in-flight worker signal', async () => {
  let signal;
  const response = createNdjsonWorkStream((value) => { signal = value; return new Promise(() => {}); }, { intervalMs: 10 });
  const reader = response.body.getReader();
  assert.deepEqual(await nextFrame(reader), { event: 'started' });
  await reader.cancel();
  assert.equal(signal.aborted, true);
  assert.deepEqual(await reader.read(), { value: undefined, done: true });
  await new Promise((resolve) => setTimeout(resolve, 25));
});
