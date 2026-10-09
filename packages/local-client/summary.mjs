const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set(['pending', 'active', 'settled']);

export function summarizeResult(value) {
  if (Array.isArray(value)) return { count: value.length };
  if (!value || typeof value !== 'object') return { status: 'ok' };
  const result = {};
  for (const field of ['message_id', 'thread_id', 'next_after_id']) {
    if (value[field] === null && field === 'next_after_id') result[field] = null;
    else if (typeof value[field] === 'string' && UUID.test(value[field])) result[field] = value[field];
  }
  for (const field of ['seq', 'message_seq', 'storage_revision', 'snapshot_seq', 'revision', 'principle_revision']) {
    if (Number.isSafeInteger(value[field])) result[field] = value[field];
  }
  if (statuses.has(value.status)) result.status = value.status;
  if (typeof value.has_more === 'boolean') result.has_more = value.has_more;
  if (Array.isArray(value.items)) result.item_count = value.items.length;
  if (value.state && typeof value.state === 'object' && !Array.isArray(value.state)) {
    const state = value.state;
    for (const field of ['revision', 'principle_revision']) if (Number.isSafeInteger(state[field])) result[field] = state[field];
    if (state.threads && typeof state.threads === 'object' && !Array.isArray(state.threads)) {
      const threads = Object.values(state.threads);
      result.thread_counts = Object.fromEntries([...statuses].map((status) => [status, threads.filter((thread) => thread?.status === status).length]));
    }
    if (state.proposals && typeof state.proposals === 'object' && !Array.isArray(state.proposals)) result.proposal_count = Object.keys(state.proposals).length;
    if (Array.isArray(state.agreements)) result.agreement_count = state.agreements.length;
  }
  return Object.keys(result).length ? result : { status: 'ok' };
}
