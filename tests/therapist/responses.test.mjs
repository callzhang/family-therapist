import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS } from '../../packages/therapist/tools.mjs';
import { runTherapistTurn } from '../../packages/therapist/responses.mjs';

const scope = { run_id: 'run-1', actor_id: 'actor-fixed', space_id: 'space-fixed', snapshot_seq: 42 };
const threadId = '11111111-1111-4111-8111-111111111111';
const outputSchema = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false };
const finalResponse = (id, reply = '{"reply":"Ready"}') => ({ id, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: reply }] }] });
const call = (id, name, args) => ({ type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) });
const setup = (responses, executeTool, extras = {}) => {
  const requests = []; const saved = [];
  return {
    requests, saved,
    run: runTherapistTurn({ model: 'gpt-6-luna', instructions: 'Follow the therapist policy.', input: [{ role: 'user', content: 'Please help.' }], scope, maxToolCalls: extras.maxToolCalls ?? 5, outputSchema, request: async (req) => { requests.push(req); return responses.shift(); }, executeTool, saveCheckpoint: async (cp) => saved.push(structuredClone(cp)), ...extras }),
  };
};

test('tools expose only strict read functions and make optional fields nullable and required', () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.name), ['list_threads', 'get_thread', 'get_messages', 'get_message', 'get_agreements']);
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, 'function'); assert.equal(tool.strict, true);
    assert.ok(Array.isArray(tool.parameters.required));
    assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), [...tool.parameters.required].sort());
  }
  assert.deepEqual(TOOL_DEFINITIONS.find((t) => t.name === 'get_messages').parameters.properties.after_message_id, { type: ['string', 'null'], format: 'uuid' });
});

test('continues get_thread then get_messages and parses completed structured output', async () => {
  const h = setup([
    { id: 'resp-1', status: 'completed', output: [call('c1', 'get_thread', { thread_id: threadId })] },
    { id: 'resp-2', status: 'completed', output: [call('c2', 'get_messages', { thread_id: threadId, after_message_id: null, limit: 20 })] },
    finalResponse('resp-3'),
  ], async (name, args, runScope) => ({ name, args, run: runScope.run_id }));
  const result = await h.run;
  assert.deepEqual(result.output, { reply: 'Ready' });
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[1].instructions, 'Follow the therapist policy.');
  assert.equal(h.requests[2].instructions, 'Follow the therapist policy.');
  assert.equal(h.requests[1].previous_response_id, 'resp-1');
  assert.deepEqual(h.requests[1].input, [{ type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ name: 'get_thread', args: { thread_id: threadId }, run: 'run-1' }) }]);
  assert.deepEqual(h.requests[2].input, [{ type: 'function_call_output', call_id: 'c2', output: JSON.stringify({ name: 'get_messages', args: { thread_id: threadId, after_message_id: null, limit: 20 }, run: 'run-1' }) }]);
  assert.equal(h.saved.length, 6); // each response, each tool result, and completed output checkpoint
  assert.equal(h.saved.at(-1).status, 'completed');
});

test('executor receives authenticated fixed scope separately; model cannot provide identity or snapshot', async () => {
  const h = setup([{ id: 'r1', status: 'completed', output: [call('c1', 'get_thread', { thread_id: threadId, actor_id: 'attacker', space_id: 'other', snapshot_seq: 999 })] }, finalResponse('r2')], async (name, args, runScope) => ({ args, runScope }));
  const result = await h.run;
  assert.deepEqual(result.checkpoint.tool_results[0].value.runScope, scope);
  assert.deepEqual(result.checkpoint.tool_results[0].value.args, { thread_id: threadId });
});

test('rejects unsupported write tools, malformed args, and executor failures as explicit failures', async (t) => {
  await t.test('write tool', async () => { const h = setup([{ id: 'r1', status: 'completed', output: [call('c', 'approve_agreement', {})] }], async () => ({})); const result = await h.run; assert.equal(result.status, 'failed'); assert.match(result.error.message, /unsupported tool/i); });
  await t.test('malformed args', async () => { const h = setup([{ id: 'r1', status: 'completed', output: [{ type: 'function_call', call_id: 'c', name: 'get_thread', arguments: '{' }] }], async () => ({})); const result = await h.run; assert.equal(result.status, 'failed'); assert.match(result.error.message, /arguments/i); });
  await t.test('invalid shape', async () => { const h = setup([{ id: 'r1', status: 'completed', output: [call('c', 'get_thread', { thread_id: 3 })] }], async () => ({})); const result = await h.run; assert.equal(result.status, 'failed'); assert.match(result.error.message, /thread_id/i); });
  await t.test('executor', async () => { const h = setup([{ id: 'r1', status: 'completed', output: [call('c', 'get_thread', { thread_id: threadId })] }], async () => { throw new Error('db down'); }); const result = await h.run; assert.equal(result.status, 'failed'); assert.match(result.error.message, /db down/); assert.equal(result.checkpoint.pending_calls[0].call_id, 'c'); });
});

test('incomplete and failed provider responses never yield success', async (t) => {
  for (const status of ['incomplete', 'failed']) await t.test(status, async () => { const h = setup([{ id: 'r', status, output: [] }], async () => ({})); const result = await h.run; assert.equal(result.status, 'failed'); assert.equal(result.output, undefined); assert.ok(result.checkpoint); });
});

test('tool budget stops loops and retains the latest response checkpoint', async () => {
  const h = setup([{ id: 'r1', status: 'completed', output: [call('c1', 'get_thread', { thread_id: threadId })] }, { id: 'r2', status: 'completed', output: [call('c2', 'get_thread', { thread_id: threadId })] }], async () => ({}), { maxToolCalls: 1 });
  const result = await h.run;
  assert.equal(result.status, 'failed'); assert.match(result.error.message, /budget/i); assert.equal(h.requests.length, 2); assert.equal(result.checkpoint.tool_call_count, 1);
});

test('restores a checkpoint and reuses persisted tool results without duplicate execution', async () => {
  const checkpoint = { run_id: scope.run_id, model: 'gpt-6-luna', previous_response_id: 'resp-1', status: 'waiting_for_tools', tool_call_count: 1, pending_calls: [call('c1', 'get_thread', { thread_id: threadId })], tool_results: [{ call_id: 'c1', idempotency_key: 'run-1:c1', value: { cached: true } }] };
  let executions = 0;
  const h = setup([finalResponse('resp-2')], async () => { executions += 1; return {}; }, { checkpoint, maxToolCalls: 1 });
  const result = await h.run;
  assert.equal(result.status, 'completed'); assert.equal(executions, 0);
  assert.deepEqual(h.requests[0].input, [{ type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ cached: true }) }]);
});
