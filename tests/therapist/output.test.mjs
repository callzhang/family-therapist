import test from 'node:test';
import assert from 'node:assert/strict';
import { THERAPIST_OUTPUT_SCHEMA, validateTherapistOutput, TherapistOutputValidationError } from '../../packages/therapist/output.mjs';

const space = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const thread = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const memberA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const memberB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const msgA = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const msgB = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const at = (message_id, actor_id, extra = {}) => ({ message_id, space_id: space, thread_id: thread, seq: 10, actor_id, kind: 'member_expression', ...extra });
const context = (messages = [at(msgA, memberA), at(msgB, memberB)]) => ({ space_id: space, thread_id: thread, snapshot_seq: 10, member_ids: [memberA, memberB], messages });
const output = (changes = {}) => ({ reply: 'I hear both of you describing a difficult moment.', source_message_ids: [msgA, msgB], common_points: [{ text: 'You both want to feel heard.', source_message_ids: [msgA, msgB] }], differences: [], hypotheses: [], consensus_proposal: null, ...changes });

test('strict schema requires all output fields and forbids additional fields at every object level', () => {
  assert.deepEqual(THERAPIST_OUTPUT_SCHEMA.required, ['reply', 'source_message_ids', 'common_points', 'differences', 'hypotheses', 'consensus_proposal']);
  assert.equal(THERAPIST_OUTPUT_SCHEMA.additionalProperties, false);
  assert.deepEqual(THERAPIST_OUTPUT_SCHEMA.properties.consensus_proposal.anyOf[1], { type: 'null' });
  for (const key of ['common_points', 'differences', 'hypotheses']) assert.equal(THERAPIST_OUTPUT_SCHEMA.properties[key].items.additionalProperties, false);
  assert.equal(THERAPIST_OUTPUT_SCHEMA.properties.consensus_proposal.anyOf[0].additionalProperties, false);
});

test('accepts a common point supported by both distinct members and returns a frozen independent copy', () => {
  const original = output();
  const result = validateTherapistOutput(original, context());
  assert.deepEqual(result, original);
  assert.notEqual(result, original);
  assert.notEqual(result.common_points, original.common_points);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.common_points[0].source_message_ids));
  assert.throws(() => { result.reply = 'changed'; }, TypeError);
  assert.equal(original.reply, 'I hear both of you describing a difficult moment.');
});

test('accepts a one-sided reply with no automatic common points', () => {
  const value = output({ source_message_ids: [msgA], common_points: [], differences: [{ text: 'One person describes feeling rushed.', source_message_ids: [msgA] }] });
  assert.deepEqual(validateTherapistOutput(value, context([at(msgA, memberA)])), value);
});

test('rejects a common point when all cited evidence comes from only one member', () => {
  assert.throws(() => validateTherapistOutput(output({ common_points: [{ text: 'A shared preference.', source_message_ids: [msgA] }] }), context()), /both distinct members/i);
  const repeatedMessage = '11111111-1111-4111-8111-111111111111';
  assert.throws(() => validateTherapistOutput(output({ source_message_ids: [msgA, repeatedMessage], common_points: [{ text: 'A repeated view.', source_message_ids: [msgA, repeatedMessage] }] }), context([at(msgA, memberA), at(repeatedMessage, memberA)])), /both distinct members/i);
});

test('rejects cited messages outside space, thread, or frozen snapshot', () => {
  for (const message of [at(msgA, memberA, { space_id: '11111111-1111-4111-8111-111111111111' }), at(msgA, memberA, { thread_id: '11111111-1111-4111-8111-111111111111' }), at(msgA, memberA, { seq: 11 })]) {
    assert.throws(() => validateTherapistOutput(output({ source_message_ids: [msgA], common_points: [] }), context([message])), /trusted member expression/i);
  }
});

test('rejects unknown and duplicate citations and ambiguous duplicate evidence ids', () => {
  assert.throws(() => validateTherapistOutput(output({ source_message_ids: ['11111111-1111-4111-8111-111111111111'], common_points: [] }), context()), /trusted member expression/i);
  assert.throws(() => validateTherapistOutput(output({ source_message_ids: [msgA, msgA], common_points: [] }), context()), /duplicate citation/i);
  assert.throws(() => validateTherapistOutput(output(), context([at(msgA, memberA), at(msgA, memberB)])), /duplicate evidence/i);
});

test('therapist replies, operations, and other actors cannot be used as member expression evidence', () => {
  for (const message of [at(msgA, memberA, { kind: 'therapist_reply' }), at(msgA, memberA, { kind: 'operation' }), at(msgA, '11111111-1111-4111-8111-111111111111')]) {
    assert.throws(() => validateTherapistOutput(output({ source_message_ids: [msgA], common_points: [] }), context([message])), /trusted member expression/i);
  }
});

test('rejects extra fields and malformed, blank, oversized, or structurally incomplete outputs', () => {
  assert.throws(() => validateTherapistOutput({ ...output(), settle: true }, context()), TherapistOutputValidationError);
  assert.throws(() => validateTherapistOutput(output({ reply: '   ' }), context()), /nonblank/i);
  assert.throws(() => validateTherapistOutput(output({ reply: 'x'.repeat(5001) }), context()), /length/i);
  assert.throws(() => validateTherapistOutput(output({ differences: [{ text: ' ', source_message_ids: [msgA] }] }), context()), /nonblank/i);
  assert.throws(() => validateTherapistOutput(output({ consensus_proposal: { text: 'Confirmed.', source_message_ids: [msgA], confirmed: true } }), context()), /unsupported property/i);
  assert.throws(() => validateTherapistOutput({ reply: 'Missing fields' }, context()), /required/i);
});

test('consensus proposal remains an unconfirmed proposal and is never promoted to agreement', () => {
  const value = output({ consensus_proposal: { text: 'Could you try checking in before changing the plan?', source_message_ids: [msgA] } });
  const result = validateTherapistOutput(value, context());
  assert.deepEqual(result.consensus_proposal, value.consensus_proposal);
  assert.equal(Object.hasOwn(result, 'agreement'), false);
  assert.equal(Object.hasOwn(result, 'settled'), false);
});

test('requires trusted server context with exactly two distinct member identities', () => {
  assert.throws(() => validateTherapistOutput(output(), { ...context(), member_ids: [memberA, memberA] }), /two distinct members/i);
  assert.throws(() => validateTherapistOutput(output(), { ...context(), snapshot_seq: -1 }), /context/i);
});
