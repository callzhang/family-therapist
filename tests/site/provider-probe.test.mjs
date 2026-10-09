import test from 'node:test';
import assert from 'node:assert/strict';
import { runProviderProbe } from '../../sites/family-therapist/src/server/provider-probe.mjs';
import { ResponsesProviderError } from '../../sites/family-therapist/src/server/openai-responses.mjs';

test('provider probe uses fixed synthetic input and returns only safe response metadata', async () => {
  let received;
  const result = await runProviderProbe({
    model: 'provider-test',
    request: async (payload) => {
      received = payload;
      return {
        id: 'private-response-id',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'private model output' }] }],
        usage: { input_tokens: 12, output_tokens: 3 },
      };
    },
  });

  assert.deepEqual(received, {
    model: 'provider-test',
    input: 'Reply exactly OK.',
    reasoning: { effort: 'medium' },
    max_output_tokens: 128,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.output_tokens, 3);
  assert.deepEqual(result.output_types, ['message']);
  assert.equal(typeof result.elapsed_ms, 'number');
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('provider probe converts provider failures to safe code and HTTP status only', async () => {
  const result = await runProviderProbe({
    model: 'provider-test',
    request: async () => { throw new ResponsesProviderError('private details', { code: 'provider_http_error', status: 503, request_id: 'private-id' }); },
  });

  assert.deepEqual(Object.keys(result).sort(), ['elapsed_ms', 'error_code', 'http_status', 'output_tokens', 'output_types', 'status'].sort());
  assert.equal(result.status, null);
  assert.equal(result.error_code, 'provider_http_error');
  assert.equal(result.http_status, 503);
  assert.deepEqual(result.output_types, []);
  assert.equal(JSON.stringify(result).includes('private'), false);
});
