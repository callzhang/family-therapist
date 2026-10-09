const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTPUT_FIELDS = ['reply', 'source_message_ids', 'common_points', 'differences', 'hypotheses', 'consensus_proposal'];
const MAX_REPLY_LENGTH = 5000;
const MAX_ITEM_TEXT_LENGTH = 2000;
const MAX_LIST_ITEMS = 30;
const MAX_CITATIONS = 20;

const citationListSchema = (minItems = 1) => ({
  type: 'array', minItems, maxItems: MAX_CITATIONS,
  items: { type: 'string', format: 'uuid' },
});
const textItemSchema = (minimumCitations = 1) => ({
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: MAX_ITEM_TEXT_LENGTH },
    source_message_ids: citationListSchema(minimumCitations),
  },
  required: ['text', 'source_message_ids'],
  additionalProperties: false,
});

/** Strict provider-facing response shape. Application validation remains a separate gate. */
export const THERAPIST_OUTPUT_SCHEMA = deepFreeze({
  type: 'object',
  properties: {
    reply: { type: 'string', minLength: 1, maxLength: MAX_REPLY_LENGTH },
    source_message_ids: citationListSchema(),
    common_points: { type: 'array', maxItems: MAX_LIST_ITEMS, items: textItemSchema(2) },
    differences: { type: 'array', maxItems: MAX_LIST_ITEMS, items: textItemSchema() },
    hypotheses: { type: 'array', maxItems: MAX_LIST_ITEMS, items: textItemSchema() },
    consensus_proposal: {
      anyOf: [textItemSchema(), { type: 'null' }],
    },
  },
  required: OUTPUT_FIELDS,
  additionalProperties: false,
});

export class TherapistOutputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TherapistOutputValidationError';
  }
}

function reject(message) {
  throw new TherapistOutputValidationError(message);
}

function assertExactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject(`${label} must be an object`);
  const keys = Object.keys(value);
  const extra = keys.find((key) => !fields.includes(key));
  if (extra !== undefined) reject(`${label} has unsupported property: ${extra}`);
  const missing = fields.find((field) => !Object.hasOwn(value, field));
  if (missing !== undefined) reject(`${label} is missing required property: ${missing}`);
}

function assertText(value, label, maximum) {
  if (typeof value !== 'string' || !value.trim()) reject(`${label} must be a nonblank string`);
  if (value.length > maximum) reject(`${label} exceeds maximum length ${maximum}`);
}

function assertUuid(value, label) {
  if (typeof value !== 'string' || !UUID.test(value)) reject(`${label} must be a UUID`);
}

function assertContext(context) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) reject('Invalid server evidence context');
  const { space_id: spaceId, thread_id: threadId, snapshot_seq: snapshotSeq, member_ids: memberIds, messages } = context;
  assertUuid(spaceId, 'Context space_id');
  assertUuid(threadId, 'Context thread_id');
  if (!Number.isSafeInteger(snapshotSeq) || snapshotSeq < 0) reject('Invalid server evidence context snapshot_seq');
  if (!Array.isArray(memberIds) || memberIds.length !== 2 || memberIds.some((id) => typeof id !== 'string' || !UUID.test(id)) || new Set(memberIds).size !== 2) {
    reject('Context must identify exactly two distinct members');
  }
  if (!Array.isArray(messages)) reject('Invalid server evidence context messages');

  const byId = new Map();
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) reject('Invalid server evidence message metadata');
    assertUuid(message.message_id, 'Evidence message_id');
    if (byId.has(message.message_id)) reject('Context contains duplicate evidence message ids');
    byId.set(message.message_id, message);
  }
  return { spaceId, threadId, snapshotSeq, memberIds: new Set(memberIds), byId };
}

function assertCitationList(ids, label, evidence, minimum = 1) {
  if (!Array.isArray(ids) || ids.length < minimum || ids.length > MAX_CITATIONS) {
    const requirement = minimum === 2 ? 'at least two citations from both distinct members' : `${minimum} to ${MAX_CITATIONS} citations`;
    reject(`${label} must contain ${requirement}`);
  }
  const seen = new Set();
  const cited = [];
  for (const id of ids) {
    assertUuid(id, `${label} citation`);
    if (seen.has(id)) reject(`${label} contains a duplicate citation`);
    seen.add(id);
    const message = evidence.byId.get(id);
    if (!message || message.space_id !== evidence.spaceId || message.thread_id !== evidence.threadId ||
      !Number.isSafeInteger(message.seq) || message.seq < 0 || message.seq > evidence.snapshotSeq ||
      message.kind !== 'member_expression' || !evidence.memberIds.has(message.actor_id)) {
      reject(`${label} citation is not a trusted member expression in this scope and snapshot`);
    }
    cited.push(message);
  }
  return cited;
}

function assertTextItems(items, label, evidence, { minimumCitations = 1, bothMembers = false } = {}) {
  if (!Array.isArray(items) || items.length > MAX_LIST_ITEMS) reject(`${label} must be an array of at most ${MAX_LIST_ITEMS} items`);
  for (const item of items) {
    assertExactObject(item, ['text', 'source_message_ids'], `${label} item`);
    assertText(item.text, `${label} item text`, MAX_ITEM_TEXT_LENGTH);
    const messages = assertCitationList(item.source_message_ids, `${label} item`, evidence, minimumCitations);
    if (bothMembers && new Set(messages.map(({ actor_id: actorId }) => actorId)).size !== 2) {
      reject('Each common point must cite expressions from both distinct members');
    }
  }
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Validates a provider result against server-owned evidence metadata and returns
 * a frozen independent copy. This establishes citation eligibility only; it
 * cannot establish that a cited expression semantically supports generated text.
 */
export function validateTherapistOutput(output, context) {
  assertExactObject(output, OUTPUT_FIELDS, 'Therapist output');
  assertText(output.reply, 'reply', MAX_REPLY_LENGTH);
  const evidence = assertContext(context);
  assertCitationList(output.source_message_ids, 'source_message_ids', evidence);
  assertTextItems(output.common_points, 'common_points', evidence, { minimumCitations: 2, bothMembers: true });
  assertTextItems(output.differences, 'differences', evidence);
  assertTextItems(output.hypotheses, 'hypotheses', evidence);
  if (output.consensus_proposal !== null) {
    assertExactObject(output.consensus_proposal, ['text', 'source_message_ids'], 'consensus_proposal');
    assertText(output.consensus_proposal.text, 'consensus_proposal text', MAX_ITEM_TEXT_LENGTH);
    assertCitationList(output.consensus_proposal.source_message_ids, 'consensus_proposal', evidence);
  }
  return deepFreeze(structuredClone(output));
}
