import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveStream } from '../../sites/family-therapist/src/server/archive.mjs';

async function read(stream) { return new Response(stream).text(); }
const message = (id, body, kind = 'member_expression') => ({ message_id: id, thread_id: 'thread-1', kind, actor_id: `actor-${id}`, body, created_at: `2026-10-08T00:00:0${id}Z`, seq: Number(id) });

test('Markdown archive streams multiple pages with actual role attribution and per-message UUIDs', async () => {
  const pages = [
    { items: [message('1', { text: '第一段\n\n第二段' })], has_more: true, next_after_id: '1' },
    { items: [message('2', { reply: '咨询师回复' }, 'therapist_reply')], has_more: false, next_after_id: '2' },
  ];
  const cursors = [];
  const output = await read(createArchiveStream({
    format: 'md', thread: { thread_id: 'thread-1', title: '主题', status: 'settled', summary: '总结' }, snapshot: 22,
    async readPage(cursor) { cursors.push(cursor); return pages.shift(); },
    rolesByActor: { 'actor-1': 'husband', 'actor-2': 'wife' },
  }));
  assert.deepEqual(cursors, [null, '1']);
  assert.match(output, /丈夫 ·/);
  assert.match(output, /咨询师 ·/);
  assert.match(output, /记录 UUID：1/);
  assert.match(output, /记录 UUID：2/);
  assert.match(output, /第一段\n\n第二段/);
  assert.match(output, /读取快照序号：22/);
});

test('JSONL archive preserves unsupported structured message bodies', async () => {
  const body = { legacy_event: { source: ['a', 'b'], metadata: { keep: true } } };
  const output = await read(createArchiveStream({
    format: 'jsonl', thread: { thread_id: 'thread-1', title: '主题', status: 'active', summary: '总结' }, snapshot: 8,
    async readPage(cursor) { assert.equal(cursor, null); return { items: [message('3', body)], has_more: false, next_after_id: '3' }; },
  }));
  const lines = output.trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines[1].body, body);
});

import { measureReadableBytes, putKnownLengthStream } from '../../sites/family-therapist/src/server/archive.mjs';

function fixedLengthFactory(byteLength) {
  let controller;
  let written = 0;
  const readable = new ReadableStream({ start(value) { controller = value; } });
  const writable = new WritableStream({
    write(chunk) {
      written += chunk.byteLength;
      if (written > byteLength) {
        const error = new RangeError('too many bytes');
        controller.error(error);
        throw error;
      }
      controller.enqueue(chunk);
    },
    close() {
      if (written !== byteLength) {
        const error = new RangeError('too few bytes');
        controller.error(error);
        throw error;
      }
      controller.close();
    },
    abort(error) { controller.error(error); },
  });
  knownLengths.set(readable, byteLength);
  return { readable, writable };
}
const knownLengths = new WeakMap();
async function strictR2Put(readable) {
  const expected = knownLengths.get(readable);
  if (expected === undefined) throw new TypeError('Provided readable stream must have a known length');
  const reader = readable.getReader();
  const chunks = [];
  let actual = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    actual += value.byteLength;
  }
  assert.equal(actual, expected);
  return { body: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))), size: actual, etag: 'mock-etag' };
}
function byteStream(chunks) {
  return new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); controller.close(); } });
}

test('strict R2 storage rejects unknown length and accepts exact multilingual bytes across archive pages', async () => {
  await assert.rejects(strictR2Put(byteStream(['未知长度'])), /known length/);
  const pages = [
    { items: [message('4', { text: '你好，第一段' })], has_more: true, next_after_id: '4' },
    { items: [message('5', { reply: '相談の返答 🙂' }, 'therapist_reply')], has_more: false, next_after_id: '5' },
  ];
  const reads = [];
  const options = { format: 'jsonl', thread: { thread_id: 'thread-1', title: '主题', status: 'settled', summary: '已结束' }, snapshot: 99,
    async readPage(cursor) { reads.push(cursor); return pages[cursor === null ? 0 : 1]; } };
  const makeArchive = () => createArchiveStream(options);
  const byteLength = await measureReadableBytes(makeArchive());
  const receipt = await putKnownLengthStream({ stream: makeArchive(), byteLength, createFixedLengthStream: fixedLengthFactory, put: strictR2Put });
  assert.equal(receipt.size, byteLength);
  const decoded = receipt.body.toString('utf8');
  assert.match(decoded, /你好，第一段/);
  assert.match(decoded, /相談の返答 🙂/);
  assert.deepEqual(reads, [null, '4', null, '4']);
});

test('fixed-length upload rejects the wrong byte count and source failures never return a receipt', async () => {
  await assert.rejects(putKnownLengthStream({ stream: byteStream(['短']), byteLength: 4, createFixedLengthStream: fixedLengthFactory, put: strictR2Put }), /too few bytes/);
  await assert.rejects(putKnownLengthStream({ stream: byteStream(['短']), byteLength: 2, createFixedLengthStream: fixedLengthFactory, put: strictR2Put }), /too many bytes/);
  const broken = new ReadableStream({ pull(controller) { controller.error(new Error('read page failed')); } });
  await assert.rejects(measureReadableBytes(broken), /read page failed/);
  await assert.rejects(putKnownLengthStream({ stream: broken, byteLength: 1, createFixedLengthStream: fixedLengthFactory, put: strictR2Put }), /read page failed/);
});

test('R2 rejection aborts the producer and propagates the storage failure', async () => {
  let producerCancelled = false;
  const source = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('first')); }, cancel() { producerCancelled = true; } });
  await assert.rejects(putKnownLengthStream({ stream: source, byteLength: 5, createFixedLengthStream: fixedLengthFactory, async put(readable) { await readable.getReader().read(); throw new Error('R2 unavailable'); } }), /R2 unavailable/);
  assert.equal(producerCancelled, true);
});
