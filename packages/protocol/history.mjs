export function pageHistory(records, {
  after_message_id = null, through_message_id = null, limit = 100,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('invalid_limit');
  const seen = new Set();
  let previous = 0;
  for (const item of records) {
    if (!Number.isSafeInteger(item.seq) || item.seq <= previous) throw new Error('invalid_order');
    if (seen.has(item.message_id)) throw new Error('duplicate_uuid');
    previous = item.seq;
    seen.add(item.message_id);
  }
  const after = after_message_id === null ? -1 : records.findIndex(x => x.message_id === after_message_id);
  if (after_message_id !== null && after < 0) throw new Error('invalid_cursor');
  const end = through_message_id === null ? records.length - 1 : records.findIndex(x => x.message_id === through_message_id);
  if (through_message_id !== null && end < 0) throw new Error('invalid_snapshot');
  if (after > end) throw new Error('reversed_snapshot');
  const messages = structuredClone(records.slice(after + 1, Math.min(end + 1, after + 1 + limit)));
  return {
    messages,
    next_after_message_id: messages.at(-1)?.message_id ?? after_message_id,
    through_message_id: records[end]?.message_id ?? null,
    has_more: after + messages.length < end,
  };
}
