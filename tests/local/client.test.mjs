import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentClient } from '../../packages/local-client/client.mjs';

const member = { actor_id: 'partner-husband', role: 'husband', space_id: '123e4567-e89b-42d3-a456-426614174000', member_token: 'x'.repeat(43) };
const connection = { base_url: 'https://private.example', site_access_token: 'outer-secret' };
const id = '123e4567-e89b-42d3-a456-426614174001';

test('client sends credentials only to configured origin and refuses redirects', async () => {
  let observed;
  const client = createAgentClient({ member, connection, fetchImpl: async (url, options) => {
    observed = { url, options };
    return new Response('', { status: 302, headers: { location: 'https://elsewhere.example/steal' } });
  } });
  await assert.rejects(client.getDiscussion(), /redirect/);
  assert.equal(observed.url.origin, 'https://private.example');
  assert.equal(observed.options.redirect, 'manual');
  assert.equal(observed.options.headers.authorization, `Bearer ${member.member_token}`);
  assert.equal(observed.options.headers['OAI-Sites-Authorization'], `Bearer ${connection.site_access_token}`);
  await assert.rejects(client.getDiscussion(), (error) => { assert.equal(error.message.includes(member.member_token), false); assert.equal(error.message.includes(connection.site_access_token), false); return true; });
});

test('commands require exact immutable text shape and strict read schemas', async () => {
  const calls = [];
  const client = createAgentClient({ member, connection, fetchImpl: async (url, options) => {
    calls.push({ url, options }); return Response.json({ ok: true });
  } });
  const expression = { message_id: id, thread_id: id, expected_thread_seq: 7, text: 'Exact words', confirmed: true };
  await client.submitExpression(expression);
  assert.deepEqual(JSON.parse(calls[0].options.body), expression);
  assert.throws(() => client.submitExpression({ ...expression, actor_id: member.actor_id }), /Invalid confirmed/);
  assert.throws(() => client.submitExpression({ ...expression, text: ' ' }), /nonblank/);
  assert.throws(() => client.query('run_sql', {}), /Unsupported/);
  assert.throws(() => client.query('get_thread', { thread_id: id, space_id: member.space_id }), /unsupported property/);
  assert.equal(calls.length, 1);
});

test('fetch failures do not expose request credentials', async () => {
  const client = createAgentClient({ member, connection, fetchImpl: async () => { throw new Error(member.member_token); } });
  await assert.rejects(client.getDiscussion(), (error) => {
    assert.equal(error.message, 'Configured private site request failed');
    assert.equal(error.message.includes(member.member_token), false);
    return true;
  });
});

test('all supported discussion command discriminators preserve the exact request', async () => {
  const commands = [
    { message_id: id, confirmed: true, action: { type: 'create', id, title: 'A topic' } },
    { message_id: id, confirmed: true, action: { type: 'propose', id, kind: 'consensus', thread_id: id, target_id: null, text: 'Exact agreement' } },
    { message_id: id, confirmed: true, action: { type: 'approve', id, text: 'Exact agreement' } },
  ];
  const bodies = [];
  const client = createAgentClient({ member, connection, fetchImpl: async (url, options) => {
    assert.equal(url.pathname, '/api/discussion'); bodies.push(JSON.parse(options.body)); return Response.json({ message_id: id });
  } });
  for (const command of commands) await client.executeDiscussion(command);
  assert.deepEqual(bodies, commands);
});

function streamResponse(chunks, { status = 200, contentType = 'application/x-ndjson; charset=utf-8', headers = {} } = {}) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); },
  }), { status, headers: { 'content-type': contentType, ...headers } });
}
const encoder = new TextEncoder();

test('processTherapist sends bodyless authenticated POST and returns only the terminal task result', async () => {
  let observed;
  const result = { status: 'completed', message_id: id };
  const client = createAgentClient({ member, connection, fetchImpl: async (url, options) => {
    observed = { url, options };
    return streamResponse([encoder.encode('{"event":"started"}\n{"event":"result","result":' + JSON.stringify(result) + '}\n')]);
  } });
  const progress = [];
  assert.deepEqual(await client.processTherapist({ onProgress: (frame) => progress.push(frame) }), result);
  assert.equal(observed.url.pathname, '/api/therapist/drain');
  assert.equal(observed.options.method, 'POST');
  assert.equal(observed.options.body, undefined);
  assert.equal(observed.options.headers.authorization, `Bearer ${member.member_token}`);
  assert.equal(observed.options.headers['OAI-Sites-Authorization'], `Bearer ${connection.site_access_token}`);
  assert.deepEqual(progress.map((frame) => frame.event), ['started', 'result']);
});

test('processTherapist incrementally decodes split UTF-8 and newline frames while work remains pending', async () => {
  let controller;
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const client = createAgentClient({ member, connection, fetchImpl: async () => new Response(new ReadableStream({
    start(value) { controller = value; value.enqueue(encoder.encode('{"event":"started"}\n')); },
  }), { headers: { 'content-type': 'application/x-ndjson' } }) });
  const progress = [];
  const promise = client.processTherapist({ onProgress: (frame) => progress.push(frame) });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(progress, [{ event: 'started' }]);
  const line = encoder.encode('{"event":"keepalive"}\n{"event":"result","result":{"status":"completed","reply":"你好"}}\n');
  const splitAt = line.indexOf(0xe4) + 1;
  controller.enqueue(line.slice(0, splitAt));
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.enqueue(line.slice(splitAt, splitAt + 3));
  controller.enqueue(line.slice(splitAt + 3));
  controller.close();
  finish();
  assert.deepEqual(await promise, { status: 'completed', reply: '你好' });
  assert.deepEqual(progress.map((frame) => frame.event), ['started', 'keepalive', 'result']);
  await pending;
});

test('retryTherapist preserves a failed task result and uses the original task UUID route', async () => {
  let observed;
  const failed = { status: 'failed', message_id: id, error_code: 'provider_quota' };
  const client = createAgentClient({ member, connection, fetchImpl: async (url, options) => {
    observed = { url, options };
    return streamResponse([encoder.encode(`{"event":"started"}\n{"event":"result","result":${JSON.stringify(failed)}}\n`)]);
  } });
  assert.deepEqual(await client.retryTherapist(id), failed);
  assert.equal(observed.url.pathname, `/api/therapist/retry/${id}`);
  assert.equal(observed.options.body, undefined);
});

test('worker error terminal frame remains a safe error and preflight JSON errors retain HTTP status and code', async () => {
  const worker = createAgentClient({ member, connection, fetchImpl: async () => streamResponse([encoder.encode('{"event":"started"}\n{"event":"error","code":"worker_unavailable"}\n')]) });
  await assert.rejects(worker.processTherapist(), /worker_unavailable/);
  const preflight = createAgentClient({ member, connection, fetchImpl: async () => Response.json({ code: 'provider_unconfigured', error: 'Unavailable' }, { status: 503 }) });
  await assert.rejects(preflight.processTherapist(), (error) => error.status === 503 && error.code === 'provider_unconfigured');
});

test('processTherapist rejects missing terminal frames, malformed frames, and redirects without forwarding secrets', async () => {
  const missing = createAgentClient({ member, connection, fetchImpl: async () => streamResponse([encoder.encode('{"event":"started"}\n')]) });
  await assert.rejects(missing.processTherapist(), /outcome is uncertain.*original expression receipt/i);
  const malformed = createAgentClient({ member, connection, fetchImpl: async () => streamResponse([encoder.encode('{"event":"started"}\nnot-json\n')]) });
  await assert.rejects(malformed.processTherapist(), /invalid Therapist progress frame/i);
  const oversized = createAgentClient({ member, connection, fetchImpl: async () => streamResponse([new Uint8Array(1024 * 1024 + 1)]) });
  await assert.rejects(oversized.processTherapist(), /progress stream exceeds the size limit/i);
  let observed;
  const redirected = createAgentClient({ member, connection, fetchImpl: async (url, options) => {
    observed = { url, options };
    return new Response('', { status: 302, headers: { location: 'https://elsewhere.example/steal' } });
  } });
  await assert.rejects(redirected.processTherapist(), /redirect/);
  assert.equal(observed.options.redirect, 'manual');
  assert.equal(observed.url.origin, 'https://private.example');
  assert.equal(JSON.stringify(observed).includes(member.member_token), true);
  await assert.rejects(redirected.processTherapist(), (error) => !error.message.includes(member.member_token) && !error.message.includes(connection.site_access_token));
});

test('Therapist total timeout is independent and bounded to five minutes', async () => {
  let aborted = false;
  const client = createAgentClient({ member, connection, fetchImpl: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true })) });
  assert.throws(() => client.processTherapist({ timeoutMs: 300_001 }), /timeoutMs/);
  await assert.rejects(client.processTherapist({ timeoutMs: 1 }), /outcome is uncertain.*original expression receipt/i);
  assert.equal(aborted, true);
});

test('native Therapist processing refuses redirects without sending credentials to the target', async (t) => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const externalRequests = [];
  let receivedAtConfiguredOrigin;
  const external = createServer((request, response) => { externalRequests.push(request.headers); response.end('{}'); });
  const configured = createServer((request, response) => {
    receivedAtConfiguredOrigin = request.headers;
    response.writeHead(302, { location: `http://127.0.0.1:${external.address().port}/capture` }); response.end();
  });
  external.listen(0, '127.0.0.1'); await once(external, 'listening');
  configured.listen(0, '127.0.0.1'); await once(configured, 'listening');
  t.after(async () => {
    await Promise.all([new Promise((resolve, reject) => external.close((error) => error ? reject(error) : resolve())), new Promise((resolve, reject) => configured.close((error) => error ? reject(error) : resolve()))]);
  });
  const local = { ...connection, base_url: `http://127.0.0.1:${configured.address().port}` };
  const client = createAgentClient({ member, connection: local });
  await assert.rejects(client.processTherapist(), /redirect/);
  assert.equal(receivedAtConfiguredOrigin.authorization, `Bearer ${member.member_token}`);
  assert.equal(receivedAtConfiguredOrigin['oai-sites-authorization'], `Bearer ${connection.site_access_token}`);
  assert.deepEqual(externalRequests, []);
});

test('native fetch refuses an external redirect without forwarding either credential', async (t) => {
  const { createServer } = await import('node:http');
  const { once } = await import('node:events');
  const externalRequests = [];
  let receivedAtConfiguredOrigin;
  const external = createServer((request, response) => { externalRequests.push(request.headers); response.end('{}'); });
  const configured = createServer((request, response) => {
    receivedAtConfiguredOrigin = request.headers;
    response.writeHead(302, { location: `http://127.0.0.1:${external.address().port}/capture` }); response.end();
  });
  external.listen(0, '127.0.0.1'); await once(external, 'listening');
  configured.listen(0, '127.0.0.1'); await once(configured, 'listening');
  t.after(async () => {
    await Promise.all([new Promise((resolve, reject) => external.close((error) => error ? reject(error) : resolve())), new Promise((resolve, reject) => configured.close((error) => error ? reject(error) : resolve()))]);
  });
  const local = { ...connection, base_url: `http://127.0.0.1:${configured.address().port}` };
  const client = createAgentClient({ member, connection: local });
  await assert.rejects(client.getDiscussion(), /redirect/);
  assert.equal(receivedAtConfiguredOrigin.authorization, `Bearer ${member.member_token}`);
  assert.equal(receivedAtConfiguredOrigin['oai-sites-authorization'], `Bearer ${connection.site_access_token}`);
  assert.deepEqual(externalRequests, []);
});
