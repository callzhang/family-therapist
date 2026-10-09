import assert from 'node:assert/strict';
import test from 'node:test';
import { createResponsesRequest, ResponsesProviderError } from '../../sites/family-therapist/src/server/openai-responses.mjs';

test('Responses adapter uses a configured HTTPS endpoint, honest User-Agent, and never puts API key in payload', async () => {
  const secret = 'secret-test-key';
  let observed;
  const request = await createResponsesRequest({ apiKey: secret, baseUrl: 'https://provider.example/v1', fetchImpl: async (url, init) => {
    observed = { url, init };
    return new Response(JSON.stringify({ id: 'resp_test', status: 'completed', output: [] }), { status: 200 });
  } });
  const result = await request({ model: 'test-model', input: 'hello' });
  assert.equal(observed.url, 'https://provider.example/v1/responses');
  assert.equal(observed.init.redirect, 'error');
  assert.equal(observed.init.headers.authorization, `Bearer ${secret}`);
  assert.equal(observed.init.headers['user-agent'], 'FamilyTherapist/1.0');
  assert.equal(observed.init.body.includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('provider HTTP failures expose only status and a bounded safe code, never provider body text', async () => {
  const secretText = 'do not return this provider diagnostic';
  const request = await createResponsesRequest({ apiKey: 'test-key', baseUrl: 'https://example.test/v1', fetchImpl: async () => new Response(JSON.stringify({
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

test('Responses adapter rejects non-HTTPS and credential-bearing endpoints before sending', async () => {
  await assert.rejects(createResponsesRequest({ apiKey: 'test-key', baseUrl: 'http://example.test/v1' }), { code: 'provider_unconfigured' });
  await assert.rejects(createResponsesRequest({ apiKey: 'test-key', baseUrl: 'https://user:pass@example.test/v1' }), { code: 'provider_unconfigured' });
});
