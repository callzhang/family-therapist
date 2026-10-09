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
