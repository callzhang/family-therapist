import test from 'node:test';
import assert from 'node:assert/strict';
import { pageHistory } from '../../packages/protocol/history.mjs';

const ids = [
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
];
const records = ids.map((message_id, i) => ({
  message_id, seq: i + 1, body: `message ${i + 1}`,
  created_at: `2026-10-0${3 - i}T00:00:00Z`,
}));

test('first page records a stable upper UUID and excludes it only after consumed', () => {
  const first = pageHistory(records, { limit: 1 });
  assert.deepEqual(first.messages.map(x => x.message_id), [ids[0]]);
  assert.equal(first.through_message_id, ids[2]);
  assert.equal(first.next_after_message_id, ids[0]);
  assert.equal(first.has_more, true);
  const appended = [...records, { message_id: '00000000-0000-4000-8000-000000000004', seq: 4 }];
  const rest = pageHistory(appended, {
    after_message_id: first.next_after_message_id,
    through_message_id: first.through_message_id, limit: 10,
  });
  assert.deepEqual(rest.messages.map(x => x.message_id), ids.slice(1));
  assert.equal(rest.has_more, false);
  const live = pageHistory(appended, { after_message_id: rest.next_after_message_id });
  assert.equal(live.messages.length, 1);
  assert.equal(live.messages[0].seq, 4);
});

test('empty increment keeps the cursor, empty history has null cursor', () => {
  const end = pageHistory(records, { after_message_id: ids[2] });
  assert.deepEqual(end.messages, []);
  assert.equal(end.next_after_message_id, ids[2]);
  assert.equal(end.has_more, false);
  assert.equal(pageHistory([]).next_after_message_id, null);
});

test('unknown or reversed boundaries fail explicitly', () => {
  assert.throws(() => pageHistory(records, { after_message_id: 'outside' }), /invalid_cursor/);
  assert.throws(() => pageHistory(records, { through_message_id: 'outside' }), /invalid_snapshot/);
  assert.throws(() => pageHistory(records, {
    after_message_id: ids[2], through_message_id: ids[0],
  }), /reversed_snapshot/);
  assert.throws(() => pageHistory(records, { limit: 0 }), /invalid_limit/);
});

test('a cursor from another authorized scope is not silently accepted', () => {
  assert.throws(() => pageHistory(records.slice(1), { after_message_id: ids[0] }), /invalid_cursor/);
});

test('repository order and uniqueness must be valid', () => {
  assert.throws(() => pageHistory([records[1], records[0]]), /invalid_order/);
  assert.throws(() => pageHistory([records[0], { ...records[0], seq: 2 }]), /duplicate_uuid/);
});

test('returned records cannot mutate retained history', () => {
  const page = pageHistory(records);
  page.messages[0].body = 'changed';
  assert.equal(records[0].body, 'message 1');
});
