import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgreementArchiveStream, filterAgreementPage, saveAgreementArchive } from '../../sites/family-therapist/src/server/agreement-archive.mjs';
import { measureReadableBytes, putKnownLengthStream } from '../../sites/family-therapist/src/server/archive.mjs';

async function read(stream) { return new Response(stream).text(); }
const agreement = (id, thread, text, seq, confirm) => ({ agreement_id: id, thread_id: thread, version: 1, text, message_seq: seq, confirmation_message_id: confirm, confirmation_actor_id: 'husband-id', confirmed_at: '2026-10-08T00:00:00Z' });
const event = (id, kind, body, seq) => ({ message_id: id, thread_id: 'thread-id', kind, actor_id: 'husband-id', body, created_at: '2026-10-08T00:00:00Z', seq, space_id: 'space-id' });

test('agreement archive keeps global principles, topic conclusions, and operation records distinct across pages', async () => {
  const agreementPages = {
    principle: [
      { items: [agreement('principle-1', null, '共同原则：先停下来', 2, 'confirm-2')], has_more: true, next_after_id: 'principle-1', snapshot_seq: 8 },
      { items: [agreement('principle-2', null, '共同原则：再表达', 3, 'confirm-3')], has_more: false, next_after_id: 'principle-2', snapshot_seq: 8 },
    ],
    topic: [{ items: [agreement('topic-1', 'thread-id', '这次的议题结论', 6, 'confirm-6')], has_more: false, next_after_id: 'topic-1', snapshot_seq: 8 }],
  };
  const updatePages = [
    { items: [event('proposal-4', 'discussion_command', { action: { type: 'propose', kind: 'consensus', text: '共同确认的建议' } }, 4), event('expression-5', 'member_expression', { text: '私密表达不应进入该档案' }, 5)], has_more: true, next_after_id: 'expression-5', snapshot_seq: 8 },
    { items: [event('approval-7', 'discussion_command', { action: { type: 'approve', id: 'consensus-1' }, confirmed: true }, 7)], has_more: false, next_after_id: 'approval-7', snapshot_seq: 8 },
  ];
  const agreementCursors = [];
  const updateCursors = [];
  const options = {
    format: 'md', scope: { space_id: 'space-id', actor_id: 'viewer' }, snapshot: 8, cutoff_message_id: 'cutoff-8',
    rolesByActor: { 'husband-id': 'husband' },
    async readAgreementsPage(cursor, _limit, _snapshot, category) { agreementCursors.push([category, cursor]); return agreementPages[category].shift(); },
    async readUpdatesPage(cursor) { updateCursors.push(cursor); return updatePages.shift(); },
  };
  const markdown = await read(createAgreementArchiveStream(options));
  assert.deepEqual(agreementCursors, [['principle', null], ['principle', 'principle-1'], ['topic', null]]);
  assert.deepEqual(updateCursors, [null, 'expression-5']);
  assert.match(markdown, /空间最后包含记录 UUID：cutoff-8/);
  assert.match(markdown, /共同原则：先停下来[\s\S]*已确认的议题结论[\s\S]*这次的议题结论/);
  assert.match(markdown, /最后确认记录提交者：丈夫/);
  assert.match(markdown, /丈夫/);
  assert.match(markdown, /proposal-4/);
  assert.match(markdown, /approval-7/);
  assert.doesNotMatch(markdown, /私密表达不应进入该档案/);
  assert.match(markdown, /历史操作记录（不等同于正式共识）/);
});

test('JSONL retains real confirmation and operation UUIDs and all source bodies while excluding non-operations as records', async () => {
  const body = { action: { type: 'propose', kind: 'consensus', text: '共同确认的文字' }, confirmed: false };
  const lines = (await read(createAgreementArchiveStream({
    format: 'jsonl', scope: { space_id: 'space-id', actor_id: 'viewer' }, snapshot: 10, cutoff_message_id: 'last-real-uuid',
    async readAgreementsPage(_cursor, _limit, snapshot, category) { return { items: category === 'principle' ? [agreement('real-agreement', null, '已确认', 6, 'real-confirmation-uuid')] : [], has_more: false, snapshot_seq: snapshot }; },
    async readUpdatesPage(_cursor, _limit, snapshot) { return { items: [event('real-operation-uuid', 'discussion_command', body, 8), event('private-expression', 'member_expression', { text: '表达' }, 9)], has_more: false, snapshot_seq: snapshot }; },
  }))).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines[0], { type: 'header', scope: '共同空间共识与操作记录', space_id: 'space-id', snapshot_seq: 10, cutoff_message_id: 'last-real-uuid' });
  assert.equal(lines[1].confirmation_message_id, 'real-confirmation-uuid');
  assert.equal(lines[2].message_id, 'real-operation-uuid');
  assert.deepEqual(lines[2].body, body);
  assert.equal(lines.some((line) => line.message_id === 'private-expression'), false);
});

test('a malformed archive cursor fails instead of truncating or looping', async () => {
  const stream = createAgreementArchiveStream({
    format: 'jsonl', scope: { space_id: 'space-id', actor_id: 'viewer' }, snapshot: 1,
    async readAgreementsPage() { return { items: [], has_more: true, next_after_id: null, snapshot_seq: 1 }; },
    async readUpdatesPage() { throw new Error('unused'); },
  });
  await assert.rejects(read(stream), /cursor did not advance/);
});

test('category filtering preserves query sequence order and consumed cursor across empty pages', () => {
  const earlier = { items: [agreement('f0000000-0000-4000-8000-000000000001', 'topic', 'earlier topic', 3, 'c1')], has_more: true, next_after_id: 'f0000000-0000-4000-8000-000000000001', snapshot_seq: 9 };
  const later = { items: [agreement('a0000000-0000-4000-8000-000000000001', null, 'later principle', 5, 'c2')], has_more: true, next_after_id: 'a0000000-0000-4000-8000-000000000001', snapshot_seq: 9 };
  const filteredEmpty = filterAgreementPage(earlier, 'principle');
  assert.deepEqual(filteredEmpty.items, []);
  assert.equal(filteredEmpty.next_after_id, earlier.next_after_id);
  assert.equal(filteredEmpty.has_more, true);
  assert.equal(filterAgreementPage(later, 'principle').items[0].agreement_id, later.items[0].agreement_id);
  assert.ok(earlier.items[0].message_seq < later.items[0].message_seq);
  assert.ok(earlier.items[0].agreement_id > later.items[0].agreement_id, 'fixture UUID order intentionally differs from query message-sequence order');
});

test('agreement export persists exact paginated UTF-8 bytes and rejects a mismatched R2 receipt', async () => {
  const lengths = new WeakMap();
  function fixedLength(byteLength) {
    let written = 0;
    let controller;
    const readable = new ReadableStream({ start(value) { controller = value; } });
    const writable = new WritableStream({
      write(chunk) { written += chunk.byteLength; if (written > byteLength) throw new RangeError('too many bytes'); controller.enqueue(chunk); },
      close() { if (written !== byteLength) throw new RangeError('too few bytes'); controller.close(); },
      abort(error) { controller.error(error); },
    });
    lengths.set(readable, byteLength);
    return { readable, writable };
  }
  let object = null;
  let expectedLength = null;
  const bucket = {
    async put(key, body) {
      const expected = lengths.get(body);
      assert.equal(expected, expectedLength); // R2 rejects streams without a declared exact length.
      const chunks = [];
      const reader = body.getReader();
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      object = { key, bytes, etag: 'real-put-etag', size: bytes.length };
      return { etag: object.etag, size: object.size };
    },
    async get(key) { return object?.key === key ? { body: new Response(object.bytes).body, etag: object.etag, size: object.size } : null; },
  };
  const streamOptions = {
    format: 'jsonl', scope: { space_id: 'space', actor_id: 'actor' }, snapshot: 5, cutoff_message_id: 'cutoff',
    async readAgreementsPage(cursor, _limit, snapshot, category) {
      const item = category === 'principle' ? agreement('principle', null, '你好，世界 🌿', 2, 'confirmation') : null;
      return { items: cursor === null && item ? [item] : [], has_more: false, next_after_id: item?.agreement_id ?? cursor, snapshot_seq: snapshot };
    },
    async readUpdatesPage(_cursor, _limit, snapshot) { return { items: [], has_more: false, next_after_id: null, snapshot_seq: snapshot }; },
  };
  const options = { streamOptions, key: 'private/space/actor/5.jsonl', bucket, createFixedLengthStream: fixedLength, measureReadableBytes, putKnownLengthStream };
  const measured = await measureReadableBytes(createAgreementArchiveStream(streamOptions));
  expectedLength = measured;
  const result = await saveAgreementArchive(options);
  assert.equal(measured, result.byteLength);
  assert.equal(result.saved.size, result.byteLength);
  assert.equal((await new Response(result.saved.body).text()).includes('你好，世界 🌿'), true);
  assert.equal(object.bytes.byteLength, result.byteLength);
  const mismatchBucket = { ...bucket, async put() { return { etag: 'put-etag', size: result.byteLength }; }, async get() { return { body: new Response('wrong').body, etag: 'read-etag', size: result.byteLength }; } };
  await assert.rejects(saveAgreementArchive({ ...options, bucket: mismatchBucket, key: 'private/other' }), /verification failed/);
});
