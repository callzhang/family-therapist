import assert from 'node:assert/strict';
import test from 'node:test';
import { isRequestBodyEmpty } from '../../sites/family-therapist/src/server/request-body.mjs';

function streamedRequest(chunks, contentLength) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  return new Request('https://family.example/api/setup', {
    method: 'POST',
    headers: contentLength === undefined ? {} : { 'content-length': contentLength },
    body,
    duplex: 'half',
  });
}

test('empty-body check accepts absent bodies and zero-byte streams', async () => {
  assert.equal(await isRequestBodyEmpty(new Request('https://family.example/api/setup', { method: 'POST' })), true);
  assert.equal(await isRequestBodyEmpty(streamedRequest([], '0')), true);
  assert.equal(await isRequestBodyEmpty(streamedRequest(['', ''], undefined)), true);
});

test('empty-body check rejects real bytes regardless of a zero or absent length header', async () => {
  assert.equal(await isRequestBodyEmpty(streamedRequest(['x'], '0')), false);
  assert.equal(await isRequestBodyEmpty(streamedRequest([' '], undefined)), false);
  assert.equal(await isRequestBodyEmpty(streamedRequest(['{}'], '2')), false);
});

test('empty-body check rejects contradictory or malformed length headers even without a stream', async () => {
  assert.equal(await isRequestBodyEmpty(new Request('https://family.example/api/setup', { method: 'POST', headers: { 'content-length': '1' } })), false);
  assert.equal(await isRequestBodyEmpty(new Request('https://family.example/api/setup', { method: 'POST', headers: { 'content-length': 'nope' } })), false);
});

test('empty-body check cancels a stream immediately when its declared length is nonzero', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const request = new Request('https://family.example/api/setup', {
    method: 'POST',
    headers: { 'content-length': '1' },
    body,
    duplex: 'half',
  });
  assert.equal(await isRequestBodyEmpty(request), false);
  assert.equal(cancelled, true);
});
