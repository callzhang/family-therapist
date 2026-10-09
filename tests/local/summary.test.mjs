import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeResult } from '../../packages/local-client/summary.mjs';

const id = '123e4567-e89b-42d3-a456-426614174001';

test('read summaries include counts and state identifiers without consultation text', () => {
  const output = summarizeResult({ thread_id: id, title: 'Private title', summary: 'Sensitive consultation summary', status: 'active', message_seq: 11 });
  assert.deepEqual(output, { thread_id: id, message_seq: 11, status: 'active' });
  assert.equal(JSON.stringify(output).includes('Sensitive'), false);
  const discussion = summarizeResult({ storage_revision: 4, state: {
    revision: 3, principle_revision: 1,
    threads: { a: { status: 'active', title: 'private' }, b: { status: 'pending' } },
    proposals: { a: { text: 'secret' } }, agreements: [{ text: 'secret' }],
  } });
  assert.deepEqual(discussion, {
    storage_revision: 4, revision: 3, principle_revision: 1,
    thread_counts: { pending: 1, active: 1, settled: 0 }, proposal_count: 1, agreement_count: 1,
  });
  assert.equal(JSON.stringify(discussion).includes('secret'), false);
});
