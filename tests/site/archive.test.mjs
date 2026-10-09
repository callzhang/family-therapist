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
