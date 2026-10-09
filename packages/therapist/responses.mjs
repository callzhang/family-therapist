import { TOOL_DEFINITIONS, validateToolArguments } from './tools.mjs';

export class TherapistTurnError extends Error {
  constructor(message, checkpoint) { super(message); this.name = 'TherapistTurnError'; this.checkpoint = checkpoint; }
}

function outputs(response) { return Array.isArray(response?.output) ? response.output : []; }
function functionCalls(response) { return outputs(response).filter((item) => item.type === 'function_call'); }
function outputText(response) {
  return outputs(response).flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text').map((part) => part.text).join('');
}
function fail(message, checkpoint) { return { status: 'failed', error: new TherapistTurnError(message, structuredClone(checkpoint)), checkpoint: structuredClone(checkpoint) }; }
function parseArguments(call) {
  try { return JSON.parse(call.arguments); } catch { throw new Error(`Invalid arguments JSON for ${call.name}`); }
}

export async function runTherapistTurn({ model, instructions, input, scope, maxToolCalls, outputSchema, request, executeTool, saveCheckpoint, checkpoint }) {
  let state = checkpoint ? structuredClone(checkpoint) : {
    run_id: scope?.run_id, model, previous_response_id: null, status: 'ready', tool_call_count: 0,
    pending_calls: [], tool_results: [],
  };
  if (!model || !instructions || !Array.isArray(input) || !scope?.run_id || !Number.isInteger(maxToolCalls) || maxToolCalls < 0 || !outputSchema || typeof request !== 'function' || typeof executeTool !== 'function' || typeof saveCheckpoint !== 'function') {
    return fail('Invalid therapist turn configuration', state);
  }
  if (state.run_id !== scope.run_id || state.model !== model) return fail('Checkpoint does not match run scope or model', state);
  const persist = async () => { await saveCheckpoint(structuredClone(state)); };
  let nextInput = checkpoint ? [] : input;

  try {
    while (true) {
      if (state.pending_calls.length) {
        const outputsForCalls = [];
        for (const call of state.pending_calls) {
          let saved = state.tool_results.find((result) => result.call_id === call.call_id);
          if (!saved) {
            if (state.tool_call_count >= maxToolCalls) throw new Error(`Tool call budget exceeded (${maxToolCalls})`);
            const args = validateToolArguments(call.name, parseArguments(call));
            const value = await executeTool(call.name, args, structuredClone(scope), { run_id: scope.run_id, call_id: call.call_id, idempotency_key: `${scope.run_id}:${call.call_id}` });
            state.tool_call_count += 1;
            saved = { call_id: call.call_id, idempotency_key: `${scope.run_id}:${call.call_id}`, value };
            state.tool_results.push(saved);
            state.status = 'waiting_for_tools';
            await persist();
          }
          outputsForCalls.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(saved.value) });
        }
        nextInput = outputsForCalls;
      }

      const response = await request({ model, instructions, input: nextInput, previous_response_id: state.previous_response_id ?? undefined,
        tools: TOOL_DEFINITIONS, tool_choice: 'auto', text: { format: { type: 'json_schema', name: 'therapist_response', strict: true, schema: outputSchema } } });
      state.previous_response_id = response?.id ?? state.previous_response_id;
      state.last_response_status = response?.status ?? null;
      const calls = functionCalls(response);
      const callIds = calls.map((call) => call.call_id);
      if (callIds.some((id) => typeof id !== 'string' || !id) || new Set(callIds).size !== callIds.length) {
        throw new Error('Provider response contains missing or duplicate function call ids');
      }
      state.pending_calls = calls.map(({ type, call_id, name, arguments: args }) => ({ type, call_id, name, arguments: args }));
      state.status = calls.length ? 'waiting_for_tools' : response?.status === 'completed' ? 'completed' : 'failed';
      await persist();

      if (response?.status !== 'completed') throw new Error(`Provider response did not complete (status: ${response?.status ?? 'unknown'})`);
      if (calls.length) continue;
      if (!response.id) throw new Error('Completed provider response is missing an id');
      const raw = outputText(response);
      if (!raw) throw new Error('Completed provider response has no structured output text');
      let result;
      try { result = JSON.parse(raw); } catch { throw new Error('Completed provider response contains invalid JSON output'); }
      if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Structured output must be a JSON object');
      state.pending_calls = [];
      state.final_output = result;
      state.status = 'completed';
      await persist();
      return { status: 'completed', output: result, checkpoint: structuredClone(state) };
    }
  } catch (error) {
    state.status = 'failed';
    state.error = error instanceof Error ? error.message : String(error);
    try { await persist(); } catch (saveError) { return fail(`${state.error}; checkpoint save failed: ${saveError instanceof Error ? saveError.message : String(saveError)}`, state); }
    return fail(state.error, state);
  }
}
