import assert from 'node:assert/strict';
import test from 'node:test';
import { IntakeError, MAX_INTAKE_BODY_BYTES, validateExpressionCommand } from '../../sites/family-therapist/src/server/intake.mjs';
import { intakeErrorResponse, readBoundedJson, receiptNotFoundResponse } from '../../sites/family-therapist/src/server/intake-http.mjs';

const messageId = '00000000-0000-4000-8000-000000000101';
const threadId = '00000000-0000-4000-8000-000000000010';
function jsonBody(overrides = {}) {
  return { message_id: messageId, thread_id: threadId, expected_thread_seq: 1, text: '  first\n\nsecond  ', confirmed: true, ...overrides };
}
function streamRequest(bytes, contentLength) {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  return {
    headers,
    body: new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += 4096) controller.enqueue(bytes.slice(offset, offset + 4096));
        controller.close();
      },
    }),
  };
}

test('bounded JSON parser accepts the exact full request byte limit and preserves every text byte', async () => {
  const emptyTextJson = JSON.stringify(jsonBody({ text: '' }));
  const exactText = 'x'.repeat(MAX_INTAKE_BODY_BYTES - new TextEncoder().encode(emptyTextJson).byteLength);
  const serialized = JSON.stringify(jsonBody({ text: exactText }));
  assert.equal(new TextEncoder().encode(serialized).byteLength, MAX_INTAKE_BODY_BYTES);
  const parsed = await readBoundedJson(streamRequest(new TextEncoder().encode(serialized)));
  assert.deepEqual(validateExpressionCommand(parsed), jsonBody({ text: exactText }));
});

test('bounded parser rejects over-limit streams with absent or false Content-Length', async () => {
  const exactText = 'x'.repeat(MAX_INTAKE_BODY_BYTES - new TextEncoder().encode(JSON.stringify(jsonBody({ text: '' }))).byteLength + 1);
  const bytes = new TextEncoder().encode(JSON.stringify(jsonBody({ text: exactText })));
  assert.equal(bytes.byteLength, MAX_INTAKE_BODY_BYTES + 1);
  await assert.rejects(readBoundedJson(streamRequest(bytes)), { code: 'body_too_large', status: 413 });
  await assert.rejects(readBoundedJson(streamRequest(bytes, 1)), { code: 'body_too_large', status: 413 });
});

test('JSON parsing rejects malformed or invalid UTF-8 bodies and strict validation rejects unconfirmed and forged fields', async () => {
  await assert.rejects(readBoundedJson(streamRequest(new TextEncoder().encode('{broken'))), { code: 'invalid_body', status: 400 });
  await assert.rejects(readBoundedJson(streamRequest(new Uint8Array([0xc3, 0x28]))), { code: 'invalid_body', status: 400 });
  const unconfirmed = await readBoundedJson(streamRequest(new TextEncoder().encode(JSON.stringify(jsonBody({ confirmed: false })))));
  assert.throws(() => validateExpressionCommand(unconfirmed), { code: 'invalid_command' });
  const forged = await readBoundedJson(streamRequest(new TextEncoder().encode(JSON.stringify(jsonBody({ actor_id: 'member' })))));
  assert.throws(() => validateExpressionCommand(forged), { code: 'invalid_command' });
  const forgedSpace = await readBoundedJson(streamRequest(new TextEncoder().encode(JSON.stringify(jsonBody({ space_id: 'space' })))));
  assert.throws(() => validateExpressionCommand(forgedSpace), { code: 'invalid_command' });
});

test('HTTP errors expose stable codes with localized messages, including non-disclosing receipt not found', async () => {
  const stale = intakeErrorResponse(new IntakeError('stale_thread', 409, 'internal text'));
  assert.equal(stale.status, 409);
  assert.equal(stale.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(await stale.json(), { code: 'stale_thread', error: '议题版本已变化，请刷新并重新确认表达后再提交。' });
  const missing = receiptNotFoundResponse();
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { code: 'receipt_not_found', error: '没有找到当前成员提交的表达回执。' });
});
