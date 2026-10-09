import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { Miniflare } from '../../sites/family-therapist/node_modules/miniflare/dist/src/index.js';
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
  assert.equal(observed.init.redirect, 'manual');
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

test('provider 3xx responses are rejected safely without following or forwarding authorization', async () => {
  const secret = 'test-secret';
  let requests = 0;
  const request = await createResponsesRequest({ apiKey: secret, baseUrl: 'https://example.test/v1', fetchImpl: async (_url, init) => {
    requests += 1;
    assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.authorization, `Bearer ${secret}`);
    return new Response('', { status: 302, headers: { location: 'https://other.example/collect' } });
  } });
  await assert.rejects(request({ model: 'test-model', input: 'private prompt' }), (error) => {
    assert.ok(error instanceof ResponsesProviderError);
    assert.equal(error.code, 'provider_redirect_error');
    assert.equal(error.status, null);
    assert.doesNotMatch(error.message, /other\.example|private prompt|test-secret/);
    return true;
  });
  assert.equal(requests, 1);
});

test('an external abort interrupts an in-flight provider call and remains a safe transport failure', async () => {
  const controller = new AbortController();
  let observedSignal;
  const request = await createResponsesRequest({ apiKey: 'test-key', baseUrl: 'https://example.test/v1', timeoutMs: 10_000,
    fetchImpl: async (_url, init) => {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    } });
  const pending = request({ model: 'test-model', input: 'sensitive prompt' }, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  await assert.rejects(pending, (error) => error instanceof ResponsesProviderError && error.code === 'provider_transport_error' && !/sensitive prompt|test-key/.test(error.message));
  assert.equal(observedSignal.aborted, true);
});

test('the configured provider timeout also aborts an in-flight call', async () => {
  let observedSignal;
  const request = await createResponsesRequest({ apiKey: 'test-key', baseUrl: 'https://example.test/v1', timeoutMs: 1_000,
    fetchImpl: async (_url, init) => {
      observedSignal = init.signal;
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    } });
  await assert.rejects(request({ model: 'test-model', input: 'sensitive prompt' }), (error) => error instanceof ResponsesProviderError && error.code === 'provider_transport_error');
  assert.equal(observedSignal.aborted, true);
});

test('the adapter constructs requests in the deployed Workerd runtime without unsupported redirect modes', async () => {
  const adapterSource = await readFile(new URL('../../sites/family-therapist/src/server/openai-responses.mjs', import.meta.url), 'utf8');
  const workerSource = `
    import { createResponsesRequest } from './adapter.mjs';
    export default { async fetch() {
      let constructed;
      let fetchCount = 0;
      const request = await createResponsesRequest({ apiKey: 'runtime-secret', baseUrl: 'https://provider.example/v1', fetchImpl: async (url, init) => {
        fetchCount++;
        constructed = new Request(url, init);
        return new Response('', { status: 302, headers: { location: 'https://other.example/collect' } });
      }});
      try { await request({ model: 'test-model', input: 'private prompt' }); return Response.json({ accepted: true, fetchCount }); }
      catch (error) { return Response.json({ name: error.name, code: error.code, status: error.status, fetchCount, redirect: constructed?.redirect, authorization: constructed?.headers.get('authorization') }); }
    }};
  `;
  const mf = new Miniflare({
    workers: [{
      config: {
        name: 'responses-adapter-test', compatibilityDate: '2026-05-15', compatibilityFlags: ['nodejs_compat'],
        manifest: {
          mainModule: 'worker.mjs',
          modules: {
            'worker.mjs': { type: 'esm', contents: workerSource },
            'adapter.mjs': { type: 'esm', contents: adapterSource },
          },
        },
      },
    }],
  });
  try {
    const result = await mf.dispatchFetch('http://localhost/');
    const value = await result.json();
    assert.deepEqual(value, { name: 'ResponsesProviderError', code: 'provider_redirect_error', status: null, fetchCount: 1, redirect: 'manual', authorization: 'Bearer runtime-secret' });
  } finally { await mf.dispose(); }
});

test('Responses adapter rejects non-HTTPS and credential-bearing endpoints before sending', async () => {
  await assert.rejects(createResponsesRequest({ apiKey: 'test-key', baseUrl: 'http://example.test/v1' }), { code: 'provider_unconfigured' });
  await assert.rejects(createResponsesRequest({ apiKey: 'test-key', baseUrl: 'https://user:pass@example.test/v1' }), { code: 'provider_unconfigured' });
});
