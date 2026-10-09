import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAIResponsesRequest, ResponsesProviderError } from '../../sites/family-therapist/src/server/openai-responses.mjs';

test('Responses adapter sends only to the fixed endpoint and never places API key in payload', async () => {
  const secret = 'secret-test-key';
  let observed;
  const request = await createOpenAIResponsesRequest({ apiKey: secret, fetchImpl: async (url, init) => {
    observed = { url, init };
    return new Response(JSON.stringify({ id: 'resp_test', status: 'completed', output: [] }), { status: 200 });
  } });
  const result = await request({ model: 'test-model', input: 'hello' });
  assert.equal(observed.url, 'https://api.openai.com/v1/responses');
  assert.equal(observed.init.redirect, 'error');
  assert.equal(observed.init.headers.authorization, `Bearer ${secret}`);
  assert.equal(observed.init.body.includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('provider HTTP failures expose only status and a bounded safe code, never provider body text', async () => {
  const secretText = 'do not return this provider diagnostic';
  const request = await createOpenAIResponsesRequest({ apiKey: 'test-key', fetchImpl: async () => new Response(JSON.stringify({
    error: { code: 'credit_balance_exhausted', message: secretText },
  }), { status: 429, headers: { 'x-request-id': 'req_123' } }) });
  await assert.rejects(request({ model: 'test-model', input: 'sensitive prompt' }), (error) => {
    assert.ok(error instanceof ResponsesProviderError);
    assert.equal(error.code, 'credit_balance_exhausted');
    assert.equal(error.status, 429);
    assert.equal(error.request_id, 'req_123');
    assert.doesNotMatch(error.message, /do not return|sensitive prompt|test-key/);
    return true;
  });
});
