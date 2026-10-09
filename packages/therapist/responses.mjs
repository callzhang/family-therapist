import { TOOL_DEFINITIONS, validateToolArguments } from './tools.mjs';

export class TherapistTurnError extends Error {
  constructor(message, checkpoint, metadata = {}) {
    super(message);
    this.name = 'TherapistTurnError';
    this.checkpoint = checkpoint;
    this.code = metadata.code ?? 'orchestration_failed';
    this.status = metadata.status ?? null;
    this.request_id = metadata.request_id ?? null;
  }
}

function outputs(response) { return Array.isArray(response?.output) ? response.output : []; }
function functionCalls(response) { return outputs(response).filter((item) => item.type === 'function_call'); }
function outputText(response) {
  return outputs(response).flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text').map((part) => part.text).join('');
}
function fail(message, checkpoint, metadata) { return { status: 'failed', error: new TherapistTurnError(message, structuredClone(checkpoint), metadata), checkpoint: structuredClone(checkpoint) }; }
function parseArguments(call) {
  try { return JSON.parse(call.arguments); } catch { throw new Error(`Invalid arguments JSON for ${call.name}`); }
}
function sameScope(a, b) {
  return ['run_id', 'actor_id', 'space_id', 'snapshot_seq'].every((key) => Object.hasOwn(a ?? {}, key) && Object.hasOwn(b ?? {}, key) && a[key] === b[key]);
}

export async function runTherapistTurn({ model, instructions, input, scope, maxToolCalls, outputSchema, request, executeTool, saveCheckpoint, checkpoint }) {
  let state = checkpoint ? structuredClone(checkpoint) : {
    run_id: scope?.run_id, scope: structuredClone(scope ?? {}), model, input: structuredClone(input ?? []),
    previous_response_id: null, status: 'ready', phase: 'request', tool_call_count: 0,
    pending_calls: [], tool_results: [], provider_response: null,
  };
  if (!model || !instructions || !Array.isArray(input) || !scope?.run_id || !Object.hasOwn(scope, 'actor_id') || !Object.hasOwn(scope, 'space_id') || !Object.hasOwn(scope, 'snapshot_seq') || !Number.isInteger(maxToolCalls) || maxToolCalls < 0 || !outputSchema || typeof request !== 'function' || typeof executeTool !== 'function' || typeof saveCheckpoint !== 'function') {
    return fail('Invalid therapist turn configuration', state);
  }
  if (state.run_id !== scope.run_id || !sameScope(state.scope, scope) || state.model !== model) return fail('Checkpoint does not match authenticated scope or model', state);
  const persist = async () => { await saveCheckpoint(structuredClone(state)); };
  if (state.status === 'completed' && state.final_output && typeof state.final_output === 'object' && !Array.isArray(state.final_output)) {
    return { status: 'completed', output: structuredClone(state.final_output), checkpoint: structuredClone(state) };
  }

  try {
    while (true) {
      if (state.phase === 'process_response' || state.phase === 'parse_response') {
        const response = state.provider_response;
        if (!response?.id) throw new Error('Provider response is missing an id');
        if (response.status !== 'completed') throw new Error(`Provider response did not complete (status: ${response.status ?? 'unknown'})`);
        const calls = functionCalls(response);
        const callIds = calls.map((call) => call.call_id);
        if (callIds.some((id) => typeof id !== 'string' || !id) || new Set(callIds).size !== callIds.length) {
          throw new Error('Provider response contains missing or duplicate function call ids');
        }
        if (calls.length) {
          state.pending_calls = calls.map(({ type, call_id, name, arguments: args }) => ({ type, call_id, name, arguments: args }));
          state.phase = 'tools_pending';
          state.status = 'waiting_for_tools';
          await persist();
          continue;
        }
        const raw = outputText(response);
        if (!raw) throw new Error('Completed provider response has no structured output text');
        let result;
        try { result = JSON.parse(raw); } catch { throw new Error('Completed provider response contains invalid JSON output'); }
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Structured output must be a JSON object');
        state.pending_calls = [];
        state.final_output = result;
        state.phase = 'completed';
        state.status = 'completed';
        await persist();
        return { status: 'completed', output: result, checkpoint: structuredClone(state) };
      }

      let nextInput = state.phase === 'request' ? structuredClone(state.input) : [];
      if (state.phase === 'tools_pending') {
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
      state.provider_response = structuredClone(response ?? null);
      state.previous_response_id = response?.id ?? state.previous_response_id;
      state.last_response_status = response?.status ?? null;
      state.phase = 'process_response';
      state.status = 'processing_response';
      await persist();
    }
  } catch (error) {
    state.status = 'failed';
    state.error = error instanceof Error ? error.message : String(error);
    const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/i.test(error.code) ? error.code : 'orchestration_failed';
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : null;
    const requestId = typeof error?.request_id === 'string' && /^[\w.-]{1,128}$/.test(error.request_id) ? error.request_id : null;
    state.error_metadata = { code, status, request_id: requestId };
    try { await persist(); } catch (saveError) {
      const metadata = {
        code: typeof saveError?.code === 'string' && /^[a-z0-9_]{1,80}$/i.test(saveError.code) ? saveError.code : 'checkpoint_save_failed',
        status: Number.isInteger(saveError?.status) && saveError.status >= 400 && saveError.status <= 599 ? saveError.status : null,
        request_id: typeof saveError?.request_id === 'string' && /^[\w.-]{1,128}$/.test(saveError.request_id) ? saveError.request_id : null,
      };
      return fail(state.error, state, metadata);
    }
    return fail(state.error, state, state.error_metadata);
  }
}
