import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS, validateToolArguments } from '../../packages/therapist/tools.mjs';
import { runTherapistTurn } from '../../packages/therapist/responses.mjs';

const scope = { run_id: 'run-1', actor_id: 'actor-fixed', space_id: 'space-fixed', snapshot_seq: 42 };
const threadId = '11111111-1111-4111-8111-111111111111';
const outputSchema = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false };
const finalResponse = (id, reply = '{"reply":"Ready"}') => ({ id, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] }] });
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
    { id: 'resp-evidence-done', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Evidence retrieved.' }] }] },
    finalResponse('resp-3'),
  ], async (name, args, runScope) => ({ name, args, run: runScope.run_id }));
  const result = await h.run;
  assert.deepEqual(result.output, { reply: 'Ready' });
  assert.equal(h.requests.length, 4);
  assert.equal(h.requests[1].instructions, 'Follow the therapist policy.');
  assert.equal(h.requests[2].instructions, 'Follow the therapist policy.');
  assert.equal(h.requests[1].previous_response_id, 'resp-1');
  assert.deepEqual(h.requests[1].input, [{ type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ name: 'get_thread', args: { thread_id: threadId }, run: 'run-1' }) }]);
  assert.deepEqual(h.requests[2].input, [{ type: 'function_call_output', call_id: 'c2', output: JSON.stringify({ name: 'get_messages', args: { thread_id: threadId, after_message_id: null, limit: 20 }, run: 'run-1' }) }]);
  assert.equal(h.requests[3].previous_response_id, 'resp-evidence-done');
  assert.deepEqual(h.requests[3].tools, []);
  assert.equal(h.saved.at(-1).status, 'completed');
});

test('finishes evidence gathering before a separate no-tools structured generation and ignores reasoning text', async () => {
  const h = setup([
    { id: 'resp-1', status: 'completed', output: [{ type: 'reasoning', content: [{ type: 'output_text', text: 'thinking, not final JSON' }] }, call('c1', 'get_thread', { thread_id: threadId })] },
    { id: 'resp-2', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'evidence phase done' }] }] },
    { id: 'resp-3', status: 'completed', output: [{ type: 'reasoning', content: [{ type: 'output_text', text: 'This is not JSON and must not be parsed.' }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Intermediate prose is not the final assistant message.' }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"reply":"Ready"}' }] }] },
  ], async () => ({ title: 'Fixture' }));
  const result = await h.run;
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.output, { reply: 'Ready' });
  assert.equal(h.requests.length, 3);
  assert.deepEqual(h.requests[0].tools, TOOL_DEFINITIONS);
  assert.equal(h.requests[0].text, undefined);
  assert.equal(h.requests[1].previous_response_id, 'resp-1');
  assert.equal(h.requests[1].text, undefined);
  assert.deepEqual(h.requests[2].tools, []);
  assert.match(h.requests[2].input[0].content, /Please help\./);
  assert.match(h.requests[2].input[0].content, /retrieved_tool_results/);
  assert.match(h.requests[2].input[0].content, /\"title\":\"Fixture\"/);
  assert.equal(h.requests[2].tool_choice, 'none');
  assert.deepEqual(h.requests[2].text.format.schema, outputSchema);
  assert.equal(h.requests[2].previous_response_id, 'resp-2');
});

test('does not parse user-role message text as final assistant JSON', async () => {
  const h = setup([{ id: 'resp-1', status: 'completed', output: [] }, { id: 'resp-2', status: 'completed', output: [{ type: 'message', role: 'user', content: [{ type: 'output_text', text: '{"reply":"wrong speaker"}' }] }] }], async () => ({}));
  const result = await h.run;
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /no structured output text/i);
});

test('executor receives authenticated scope separately and model identity overrides are rejected', async () => {
  const h = setup([{ id: 'r1', status: 'completed', output: [call('c1', 'get_thread', { thread_id: threadId, actor_id: 'attacker', space_id: 'other', snapshot_seq: 999 })] }], async () => ({ unexpected: true }));
  const result = await h.run;
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /unsupported property/i);
  assert.equal(result.checkpoint.tool_results.length, 0);
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
  const checkpoint = { run_id: scope.run_id, scope, model: 'gpt-6-luna', input: [], phase: 'tools_pending', previous_response_id: 'resp-1', status: 'waiting_for_tools', tool_call_count: 1, pending_calls: [call('c1', 'get_thread', { thread_id: threadId })], tool_results: [{ call_id: 'c1', idempotency_key: 'run-1:c1', value: { cached: true } }], provider_response: null };
  let executions = 0;
  const h = setup([{ id: 'resp-2', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }] }, finalResponse('resp-3')], async () => { executions += 1; return {}; }, { checkpoint, maxToolCalls: 1 });
  const result = await h.run;
  assert.equal(result.status, 'completed'); assert.equal(executions, 0);
  assert.deepEqual(h.requests[0].input, [{ type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ cached: true }) }]);
});


test('completed checkpoints return cached output without calling the provider', async () => {
  const checkpoint = { run_id: scope.run_id, scope, model: 'gpt-6-luna', status: 'completed', final_output: { reply: 'Cached' }, pending_calls: [], tool_results: [], tool_call_count: 0 };
  const h = setup([], async () => ({}), { checkpoint, request: async () => { throw new Error('provider must not be called'); } });
  const result = await h.run;
  assert.deepEqual(result, { status: 'completed', output: { reply: 'Cached' }, checkpoint });
});

test('a persisted provider response can be parsed after restart without another request', async () => {
  let persistedResponse;
  const interrupted = await runTherapistTurn({ model: 'gpt-6-luna', instructions: 'Follow the therapist policy.', input: [{ role: 'user', content: 'Finish this.' }], scope, maxToolCalls: 5, outputSchema, request: async (req) => req.tools.length ? { id: 'resp-evidence', status: 'completed', output: [] } : finalResponse('resp-final'), executeTool: async () => ({}), saveCheckpoint: async (value) => {
    if (value.phase === 'process_final_response') { persistedResponse = structuredClone(value); throw new Error('simulated crash after persistence'); }
    if (value.phase === 'process_response' || value.phase === 'final_request') return;
    throw new Error('simulated process is gone');
  } });
  assert.equal(interrupted.status, 'failed');
  assert.equal(persistedResponse.provider_response.id, 'resp-final');
  let requests = 0;
  const result = await runTherapistTurn({ model: 'gpt-6-luna', instructions: 'Follow the therapist policy.', input: [], scope, maxToolCalls: 5, outputSchema, checkpoint: persistedResponse, request: async () => { requests += 1; throw new Error('must resume saved response'); }, executeTool: async () => ({}), saveCheckpoint: async () => {} });
  assert.equal(requests, 0);
  assert.deepEqual(result.output, { reply: 'Ready' });
});

test('a saved final_request resumes without repeating evidence requests or tool executions', async () => {
  let interruptedCheckpoint;
  let failOnce = true;
  const first = await runTherapistTurn({ model: 'gpt-6-luna', instructions: 'Follow the therapist policy.', input: [{ role: 'user', content: 'Read the thread.' }], scope, maxToolCalls: 5, outputSchema,
    request: async () => ({ id: 'resp-evidence-final', status: 'completed', output: [] }), executeTool: async () => { throw new Error('no tool expected'); },
    saveCheckpoint: async (value) => { if (value.phase === 'final_request' && failOnce) { failOnce = false; interruptedCheckpoint = structuredClone(value); throw new Error('simulated outage before final request'); } } });
  assert.equal(first.status, 'failed');
  assert.equal(interruptedCheckpoint.previous_response_id, 'resp-evidence-final');
  assert.equal(interruptedCheckpoint.phase, 'final_request');
  let sent;
  const resumed = await runTherapistTurn({ model: 'gpt-6-luna', instructions: 'Follow the therapist policy.', input: [], scope, maxToolCalls: 5, outputSchema, checkpoint: interruptedCheckpoint,
    request: async (payload) => { sent = payload; return finalResponse('resp-final'); }, executeTool: async () => { throw new Error('no tool expected'); }, saveCheckpoint: async () => {} });
  assert.equal(resumed.status, 'completed');
  assert.equal(sent.previous_response_id, 'resp-evidence-final');
  assert.deepEqual(sent.tools, []);
  assert.match(sent.input[0].content, /Read the thread\./);
  assert.match(sent.input[0].content, /retrieved_tool_results/);
});

test('final response rejects unexpected tool calls without executing them', async () => {
  let executions = 0;
  const h = setup([{ id: 'resp-evidence', status: 'completed', output: [] }, { id: 'resp-final', status: 'completed', output: [call('c-final', 'get_thread', { thread_id: threadId })] }], async () => { executions += 1; return {}; });
  const result = await h.run;
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /final provider response unexpectedly contains a function call/i);
  assert.equal(executions, 0);
});

test('failed first provider request retains input for retry', async () => {
  const originalInput = [{ role: 'user', content: 'Original request' }];
  const failed = await runTherapistTurn({ model: 'gpt-6-luna', instructions: 'Follow the therapist policy.', input: originalInput, scope, maxToolCalls: 5, outputSchema, request: async () => { throw new Error('provider unavailable'); }, executeTool: async () => ({}), saveCheckpoint: async () => {} });
  assert.deepEqual(failed.checkpoint.input, originalInput);
  let received;
  const resumed = await runTherapistTurn({ model: 'gpt-6-luna', instructions: 'Follow the therapist policy.', input: [], scope, maxToolCalls: 5, outputSchema, checkpoint: failed.checkpoint, request: async (req) => { received ??= req.input; return req.tools.length ? { id: 'resp-retry-evidence', status: 'completed', output: [] } : finalResponse('resp-retry'); }, executeTool: async () => ({}), saveCheckpoint: async () => {} });
  assert.deepEqual(received, originalInput);
  assert.equal(resumed.status, 'completed');
});

test('checkpoint is bound to all authenticated scope fields and model', async (t) => {
  const checkpoint = { run_id: scope.run_id, scope, model: 'gpt-6-luna', status: 'waiting_for_tools', pending_calls: [], tool_results: [], tool_call_count: 0 };
  for (const [key, value] of [['actor_id', 'other-actor'], ['space_id', 'other-space'], ['snapshot_seq', 43], ['run_id', 'other-run']]) {
    await t.test(key, async () => {
      const changedScope = { ...scope, [key]: value };
      const result = await runTherapistTurn({ model: 'gpt-6-luna', instructions: 'I', input: [], scope: changedScope, maxToolCalls: 1, outputSchema, checkpoint, request: async () => { throw new Error('must reject'); }, executeTool: async () => ({}), saveCheckpoint: async () => {} });
      assert.equal(result.status, 'failed'); assert.match(result.error.message, /scope/i);
    });
  }
  const wrongModel = await runTherapistTurn({ model: 'another-model', instructions: 'I', input: [], scope, maxToolCalls: 1, outputSchema, checkpoint, request: async () => { throw new Error('must reject'); }, executeTool: async () => ({}), saveCheckpoint: async () => {} });
  assert.equal(wrongModel.status, 'failed'); assert.match(wrongModel.error.message, /scope or model/i);
});

test('requires provider response id before executing a returned tool call', async () => {
  let executions = 0;
  const h = setup([{ status: 'completed', output: [call('c-no-response', 'get_thread', { thread_id: threadId })] }], async () => { executions += 1; return {}; });
  const result = await h.run;
  assert.equal(result.status, 'failed'); assert.equal(executions, 0);
});

test('rejects all additional properties including identity and prototype keys', () => {
  for (const raw of [
    JSON.stringify({ thread_id: threadId, actor_id: 'attacker' }),
    JSON.stringify({ thread_id: threadId, space_id: 'other' }),
    JSON.stringify({ thread_id: threadId, snapshot_seq: 5 }),
    '{"thread_id":"' + threadId + '","__proto__":{"injected":true}}',
  ]) {
    assert.throws(() => validateToolArguments('get_thread', JSON.parse(raw)), /unsupported property/i);
  }
});
