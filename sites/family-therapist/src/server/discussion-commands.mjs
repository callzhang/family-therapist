import { z } from 'zod';
import { applyDiscussion, initialDiscussion } from '../../../../packages/protocol/discussion.mjs';

export const MAX_DISCUSSION_PROJECTION_BYTES = 1024 * 1024;
export const MAX_DISCUSSION_COMMAND_BYTES = 64 * 1024;

const uuid = z.string().uuid();
const nonblank = z.string().refine((value) => value.trim().length > 0, 'empty_text');
const createAction = z.object({ type: z.literal('create'), id: uuid, title: nonblank }).strict();
const proposalAction = z.object({
  type: z.literal('propose'),
  id: uuid,
  kind: z.enum(['consensus', 'settle', 'reopen', 'switch', 'principle']),
  thread_id: uuid,
  target_id: uuid.nullable(),
  text: nonblank,
}).strict();
const approveAction = z.object({ type: z.literal('approve'), id: uuid, text: nonblank }).strict();
const actionSchema = z.discriminatedUnion('type', [createAction, proposalAction, approveAction]);
const commandSchema = z.object({ message_id: uuid, confirmed: z.literal(true), action: actionSchema }).strict();

const errorStatuses = Object.freeze({
  invalid_command: 400, invalid_scope: 400, member_pair_required: 409, membership_required: 403, membership_changed: 409,
  projection_uninitialized: 503, projection_corrupt: 503, projection_limit_exceeded: 413,
  unknown_thread: 404, duplicate_thread: 409, duplicate_proposal: 409, invalid_action: 400, invalid_proposal: 400,
  empty_text: 400, approval_text_mismatch: 409, unknown_proposal: 404, not_active: 409, not_settled: 409,
  target_not_pending: 409, wrong_active_thread: 409, wrong_target_thread: 409, stale_proposal: 409,
  command_conflict: 409, storage_conflict: 409, storage_failed: 503, persistence_incomplete: 503,
});

export class DiscussionCommandError extends Error {
  constructor(code, message = code, options) {
    super(message, options);
    this.name = 'DiscussionCommandError';
    this.code = code;
    this.status = errorStatuses[code] ?? 500;
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeAction(action) {
  if (action.type === 'create') return { type: 'create', id: action.id, title: action.title };
  if (action.type === 'propose') return {
    type: 'propose', id: action.id, kind: action.kind, thread_id: action.thread_id, target_id: action.target_id, text: action.text,
  };
  return { type: 'approve', id: action.id, text: action.text };
}

export function validateDiscussionCommand(value) {
  if (!plainObject(value) || !plainObject(value.action)) throw new DiscussionCommandError('invalid_command', 'A plain discussion command object is required.');
  const parsed = commandSchema.safeParse(value);
  if (!parsed.success) throw new DiscussionCommandError('invalid_command', 'The discussion command is invalid.');
  if (parsed.data.action.type === 'propose'
    && ((parsed.data.action.kind === 'switch' && parsed.data.action.target_id === null)
      || (parsed.data.action.kind !== 'switch' && parsed.data.action.target_id !== null))) {
    throw new DiscussionCommandError('invalid_command', 'The target does not match the proposal kind.');
  }
  const action = normalizeAction(parsed.data.action);
  const normalized = { message_id: parsed.data.message_id, confirmed: true, action };
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > MAX_DISCUSSION_COMMAND_BYTES) {
    throw new DiscussionCommandError('invalid_command', 'The discussion command is too large.');
  }
  return normalized;
}

function assertScope(scope) {
  if (!scope || typeof scope.actor_id !== 'string' || !scope.actor_id || typeof scope.space_id !== 'string' || !scope.space_id) {
    throw new DiscussionCommandError('invalid_scope', 'Authenticated member scope is required.');
  }
}

async function all(db, sql, ...values) {
  const result = await db.prepare(sql).bind(...values).all();
  if (!result || !Array.isArray(result.results)) throw new DiscussionCommandError('storage_failed', 'Database returned an invalid member list.');
  return result.results;
}

async function first(db, sql, ...values) {
  return db.prepare(sql).bind(...values).first();
}

function memberList(rows, actorId) {
  if (rows.length !== 2) throw new DiscussionCommandError('member_pair_required', 'Exactly two current members are required.');
  const members = rows.map((row) => row.user_id).sort();
  if (new Set(members).size !== 2 || !members.includes(actorId)) throw new DiscussionCommandError('membership_required', 'Current membership in the shared space is required.');
  return members;
}

async function currentMembers(db, scope) {
  const rows = await all(db, 'SELECT user_id FROM members WHERE space_id = ? ORDER BY user_id', scope.space_id);
  return memberList(rows, scope.actor_id);
}

function ownKeysExactly(value, keys) {
  return plainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validateState(state, expectedMembers) {
  if (!ownKeysExactly(state, ['members', 'threads', 'proposals', 'agreements', 'revision', 'principle_revision'])
    || !Array.isArray(state.members) || state.members.length !== 2 || state.members.some((member, index) => member !== expectedMembers[index])
    || !plainObject(state.threads) || !plainObject(state.proposals) || !Array.isArray(state.agreements)
    || !Number.isSafeInteger(state.revision) || state.revision < 0
    || !Number.isSafeInteger(state.principle_revision) || state.principle_revision < 0) {
    throw new DiscussionCommandError('projection_corrupt', 'Stored discussion projection has an invalid shape.');
  }

  for (const [threadId, thread] of Object.entries(state.threads)) {
    if (!ownKeysExactly(thread, ['id', 'title', 'summary', 'status', 'semantic_revision']) || thread.id !== threadId
      || typeof thread.title !== 'string' || thread.title.trim().length === 0 || typeof thread.summary !== 'string'
      || !['pending', 'active', 'settled'].includes(thread.status)
      || !Number.isSafeInteger(thread.semantic_revision) || thread.semantic_revision < 1) {
      throw new DiscussionCommandError('projection_corrupt', 'Stored thread projection has an invalid shape.');
    }
  }
  if (Object.values(state.threads).filter((thread) => thread.status === 'active').length > 1) {
    throw new DiscussionCommandError('projection_corrupt', 'Stored discussion projection has multiple active topics.');
  }

  const approvalsSeen = new Set();
  for (const [proposalId, proposal] of Object.entries(state.proposals)) {
    if (!ownKeysExactly(proposal, ['id', 'kind', 'thread_id', 'target_id', 'text', 'thread_revision', 'target_revision', 'principle_revision', 'approvals', 'applied'])
      || proposal.id !== proposalId || !['consensus', 'settle', 'reopen', 'switch', 'principle'].includes(proposal.kind)
      || !Object.hasOwn(state.threads, proposal.thread_id) || typeof proposal.text !== 'string' || proposal.text.trim().length === 0
      || !Number.isSafeInteger(proposal.thread_revision) || proposal.thread_revision < 1
      || !Number.isSafeInteger(proposal.principle_revision) || proposal.principle_revision < 0
      || (proposal.kind === 'switch' ? (!Object.hasOwn(state.threads, proposal.target_id) || !Number.isSafeInteger(proposal.target_revision) || proposal.target_revision < 1)
        : (proposal.target_id !== null || proposal.target_revision !== null))
      || !Array.isArray(proposal.approvals) || proposal.approvals.some((member) => !state.members.includes(member))
      || new Set(proposal.approvals).size !== proposal.approvals.length || typeof proposal.applied !== 'boolean') {
      throw new DiscussionCommandError('projection_corrupt', 'Stored proposal projection has an invalid shape.');
    }
    if (proposal.applied && (proposal.approvals.length !== 2 || !state.members.every((member) => proposal.approvals.includes(member)))) {
      throw new DiscussionCommandError('projection_corrupt', 'An applied proposal does not have both member approvals.');
    }
    for (const member of proposal.approvals) {
      const key = `${proposalId}:${member}`;
      if (approvalsSeen.has(key)) throw new DiscussionCommandError('projection_corrupt', 'Stored proposal approvals are duplicated.');
      approvalsSeen.add(key);
    }
  }

  const agreements = new Set();
  for (const agreement of state.agreements) {
    if (!ownKeysExactly(agreement, ['proposal_id', 'thread_id', 'text'])) {
      throw new DiscussionCommandError('projection_corrupt', 'Stored confirmed agreements have an invalid shape.');
    }
    const proposal = state.proposals[agreement.proposal_id];
    const globalPrinciple = proposal?.kind === 'principle';
    if (!proposal || !proposal.applied
      || !['consensus', 'settle', 'principle'].includes(proposal.kind)
      || (globalPrinciple ? agreement.thread_id !== null : agreement.thread_id !== proposal.thread_id)
      || typeof agreement.text !== 'string'
      || agreement.text !== state.proposals[agreement.proposal_id].text || agreements.has(agreement.proposal_id)) {
      throw new DiscussionCommandError('projection_corrupt', 'Stored confirmed agreements have an invalid shape.');
    }
    agreements.add(agreement.proposal_id);
  }
}

async function hasThreadHistory(db, spaceId) {
  return Boolean(await first(db, 'SELECT 1 AS present FROM thread_versions WHERE space_id = ? LIMIT 1', spaceId));
}

function decodeState(row, expectedMembers) {
  let state;
  try { state = JSON.parse(row.state_json); }
  catch (error) { throw new DiscussionCommandError('projection_corrupt', 'Stored discussion projection is not valid JSON.', { cause: error }); }
  validateState(state, expectedMembers);
  const byteLength = new TextEncoder().encode(row.state_json).byteLength;
  if (byteLength > MAX_DISCUSSION_PROJECTION_BYTES) throw new DiscussionCommandError('projection_limit_exceeded', 'Stored discussion projection exceeds the configured row size.');
  if (!Number.isSafeInteger(row.storage_revision) || row.storage_revision < 1 || typeof row.last_command_id !== 'string') {
    throw new DiscussionCommandError('projection_corrupt', 'Stored discussion projection metadata is invalid.');
  }
  return state;
}

async function loadProjection(db, scope, members) {
  const row = await first(db, 'SELECT storage_revision, state_json, last_command_id FROM discussion_projection WHERE space_id = ?', scope.space_id);
  if (!row) {
    if (await hasThreadHistory(db, scope.space_id)) throw new DiscussionCommandError('projection_uninitialized', 'Existing thread history has no discussion projection and needs explicit initialization.');
    return { state: initialDiscussion(members), state_json: null, storage_revision: 0, last_command_id: null, initialized: false };
  }
  const state = decodeState(row, members);
  const event = await first(db, 'SELECT kind, space_id, actor_id, body_json FROM messages WHERE message_id = ?', row.last_command_id);
  if (!event || event.kind !== 'discussion_command' || event.space_id !== scope.space_id || !members.includes(event.actor_id)) {
    throw new DiscussionCommandError('projection_corrupt', 'The projection marker has no matching member command event.');
  }
  const body = parseEventBody(event.body_json);
  if (body.storage_revision !== row.storage_revision) throw new DiscussionCommandError('projection_corrupt', 'The projection marker revision does not match its event.');
  return { state, state_json: row.state_json, storage_revision: row.storage_revision, last_command_id: row.last_command_id, initialized: true };
}

function parseEventBody(bodyJson) {
  let body;
  try { body = JSON.parse(bodyJson); }
  catch (error) { throw new DiscussionCommandError('projection_corrupt', 'A discussion command event contains invalid JSON.', { cause: error }); }
  if (!ownKeysExactly(body, ['confirmed', 'action', 'storage_revision']) || body.confirmed !== true || !Number.isSafeInteger(body.storage_revision) || body.storage_revision < 1) {
    throw new DiscussionCommandError('projection_corrupt', 'A discussion command event has an invalid shape.');
  }
  const parsedAction = actionSchema.safeParse(body.action);
  if (!parsedAction.success || JSON.stringify(normalizeAction(parsedAction.data)) !== JSON.stringify(body.action)) {
    throw new DiscussionCommandError('projection_corrupt', 'A discussion command event has an invalid action.');
  }
  return body;
}

function eventBody(command, storageRevision) {
  return JSON.stringify({ confirmed: true, action: command.action, storage_revision: storageRevision });
}

function sameMemberCommand(row, scope) {
  return row && row.kind === 'discussion_command' && row.space_id === scope.space_id && row.actor_id === scope.actor_id;
}

function receipt(row, duplicate) {
  const body = parseEventBody(row.body_json);
  return { message_id: row.message_id, seq: row.seq, created_at: row.created_at, action: body.action, storage_revision: body.storage_revision, duplicate };
}

async function existingCommand(db, scope, command) {
  const row = await first(db, 'SELECT message_id, seq, space_id, thread_id, kind, actor_id, body_json, created_at FROM messages WHERE message_id = ?', command.message_id);
  if (!row) return null;
  let body;
  try { body = parseEventBody(row.body_json); }
  catch {
    throw new DiscussionCommandError('command_conflict', 'This message UUID is already in use.');
  }
  if (!sameMemberCommand(row, scope) || JSON.stringify(body.action) !== JSON.stringify(command.action)) {
    throw new DiscussionCommandError('command_conflict', 'This message UUID is already in use.');
  }
  return receipt(row, true);
}

function actionThread(state, action) {
  if (action.type === 'create') return action.id;
  if (action.type === 'propose') return action.thread_id;
  return state.proposals[action.id]?.thread_id ?? null;
}

function changedThreadVersions(previous, next) {
  return Object.values(next.threads).filter((thread) => {
    const old = previous.threads[thread.id];
    return !old || old.title !== thread.title || old.status !== thread.status || old.summary !== thread.summary
      || old.semantic_revision !== thread.semantic_revision;
  });
}

function addedAgreements(previous, next) {
  const known = new Set(previous.agreements.map((agreement) => agreement.proposal_id));
  return next.agreements.filter((agreement) => !known.has(agreement.proposal_id));
}

function projectionWrite(db, scope, prior, nextJson, command) {
  const revision = prior.storage_revision + 1;
  if (!Number.isSafeInteger(revision)) throw new DiscussionCommandError('projection_limit_exceeded', 'The discussion storage revision is exhausted.');
  if (!prior.initialized) {
    return {
      revision,
      statement: db.prepare(`INSERT INTO discussion_projection(space_id, storage_revision, state_json, last_command_id)
        SELECT ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM discussion_projection WHERE space_id = ?)
          AND NOT EXISTS (SELECT 1 FROM messages WHERE message_id = ?)
          AND (SELECT COUNT(*) FROM members WHERE space_id = ?) = 2
          AND EXISTS (SELECT 1 FROM members WHERE space_id = ? AND user_id = ?)
          AND EXISTS (SELECT 1 FROM members WHERE space_id = ? AND user_id = ?)
          AND NOT EXISTS (SELECT 1 FROM thread_versions WHERE space_id = ?)
        ON CONFLICT(space_id) DO NOTHING`)
        .bind(scope.space_id, revision, nextJson, command.message_id, scope.space_id, command.message_id, scope.space_id,
          scope.space_id, prior.members[0], scope.space_id, prior.members[1], scope.space_id),
    };
  }
  return {
    revision,
    statement: db.prepare(`UPDATE discussion_projection SET storage_revision = ?, state_json = ?, last_command_id = ?
      WHERE space_id = ? AND storage_revision = ? AND state_json = ? AND last_command_id = ?
        AND NOT EXISTS (SELECT 1 FROM messages WHERE message_id = ?)
        AND (SELECT COUNT(*) FROM members WHERE space_id = ?) = 2
        AND EXISTS (SELECT 1 FROM members WHERE space_id = ? AND user_id = ?)
        AND EXISTS (SELECT 1 FROM members WHERE space_id = ? AND user_id = ?)`)
      .bind(revision, nextJson, command.message_id, scope.space_id, prior.storage_revision, prior.state_json, prior.last_command_id, command.message_id,
        scope.space_id, scope.space_id, prior.members[0], scope.space_id, prior.members[1]),
  };
}

function commandEventInsert(db, scope, command, threadId, bodyJson, createdAt, revision, stateJson) {
  return db.prepare(`INSERT INTO messages(message_id, space_id, thread_id, kind, actor_id, body_json, created_at)
    SELECT ?, ?, ?, 'discussion_command', ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM discussion_projection WHERE space_id = ? AND storage_revision = ? AND last_command_id = ? AND state_json = ?)
      AND EXISTS (SELECT 1 FROM members WHERE space_id = ? AND user_id = ?)
    ON CONFLICT(message_id) DO NOTHING`)
    .bind(command.message_id, scope.space_id, threadId, scope.actor_id, bodyJson, createdAt,
      scope.space_id, revision, command.message_id, stateJson, scope.space_id, scope.actor_id);
}

function threadVersionInsert(db, scope, messageId, revision, stateJson, thread) {
  return db.prepare(`INSERT INTO thread_versions(space_id, thread_id, message_seq, title, status, summary)
    SELECT m.space_id, ?, m.seq, ?, ?, ? FROM messages m
    WHERE m.message_id = ? AND m.kind = 'discussion_command' AND m.space_id = ?
      AND EXISTS (SELECT 1 FROM discussion_projection WHERE space_id = ? AND storage_revision = ? AND last_command_id = ? AND state_json = ?)
    ON CONFLICT(space_id, thread_id, message_seq) DO NOTHING`)
    .bind(thread.id, thread.title, thread.status, thread.summary, messageId, scope.space_id,
      scope.space_id, revision, messageId, stateJson);
}

function agreementInsert(db, scope, messageId, revision, stateJson, agreement) {
  return db.prepare(`INSERT INTO agreement_versions(space_id, agreement_id, thread_id, message_seq, version, text, confirmed)
    SELECT m.space_id, ?, ?, m.seq, 1, ?, 1 FROM messages m
    WHERE m.message_id = ? AND m.kind = 'discussion_command' AND m.space_id = ?
      AND EXISTS (SELECT 1 FROM discussion_projection WHERE space_id = ? AND storage_revision = ? AND last_command_id = ? AND state_json = ?)
    ON CONFLICT(space_id, agreement_id, message_seq) DO NOTHING`)
    .bind(agreement.proposal_id, agreement.thread_id, agreement.text, messageId, scope.space_id,
      scope.space_id, revision, messageId, stateJson);
}

function mapPureError(error) {
  const code = typeof error?.message === 'string' && Object.hasOwn(errorStatuses, error.message) ? error.message : 'invalid_action';
  return new DiscussionCommandError(code, code, { cause: error });
}

export async function getCurrentDiscussion({ db, scope }) {
  assertScope(scope);
  const members = await currentMembers(db, scope);
  const projection = await loadProjection(db, scope, members);
  return { storage_revision: projection.storage_revision, state: projection.state };
}

export async function getDiscussionReceipt({ db, scope, messageId }) {
  assertScope(scope);
  const members = await currentMembers(db, scope);
  if (typeof messageId !== 'string' || !uuid.safeParse(messageId).success) {
    throw new DiscussionCommandError('invalid_command', 'A valid command UUID is required.');
  }
  const row = await first(db, `SELECT message_id, seq, space_id, thread_id, kind, actor_id, body_json, created_at
    FROM messages WHERE message_id = ? AND space_id = ? AND actor_id = ? AND kind = 'discussion_command'`, messageId, scope.space_id, scope.actor_id);
  if (!row) return null;
  parseEventBody(row.body_json);
  if (!members.includes(row.actor_id)) throw new DiscussionCommandError('membership_required');
  return receipt(row, false);
}

export async function executeDiscussionCommand({ db, scope, command: rawCommand, now = () => new Date().toISOString() }) {
  const command = validateDiscussionCommand(rawCommand);
  assertScope(scope);
  const members = await currentMembers(db, scope);
  const priorCommand = await existingCommand(db, scope, command);
  if (priorCommand) return priorCommand;

  const prior = await loadProjection(db, scope, members);
  if (command.action.type === 'approve') {
    const proposal = prior.state.proposals[command.action.id];
    if (proposal && command.action.text !== proposal.text) throw new DiscussionCommandError('approval_text_mismatch', 'Approval must exactly match the proposal text.');
  }
  let next;
  try { next = applyDiscussion(prior.state, scope.actor_id, command.action); }
  catch (error) { throw mapPureError(error); }

  const nextJson = JSON.stringify(next);
  if (new TextEncoder().encode(nextJson).byteLength > MAX_DISCUSSION_PROJECTION_BYTES) {
    throw new DiscussionCommandError('projection_limit_exceeded', 'The discussion projection reached its configured size limit. No history was removed.');
  }
  const createdAt = now();
  const eventRevision = prior.storage_revision + 1;
  const bodyJson = eventBody(command, eventRevision);
  const actionThreadId = actionThread(prior.state, command.action);
  const projection = projectionWrite(db, scope, { ...prior, members }, nextJson, command);
  const statements = [projection.statement,
    commandEventInsert(db, scope, command, actionThreadId, bodyJson, createdAt, projection.revision, nextJson),
    ...changedThreadVersions(prior.state, next).map((thread) => threadVersionInsert(db, scope, command.message_id, projection.revision, nextJson, thread)),
    ...addedAgreements(prior.state, next).map((agreement) => agreementInsert(db, scope, command.message_id, projection.revision, nextJson, agreement)),
  ];

  let batchResults;
  try { batchResults = await db.batch(statements); }
  catch (error) { throw new DiscussionCommandError('storage_failed', 'The discussion command did not commit atomically.', { cause: error }); }
  if (!Array.isArray(batchResults) || batchResults.length !== statements.length) {
    throw new DiscussionCommandError('storage_failed', 'Database returned an incomplete atomic batch receipt.');
  }
  const revisionChanges = Number(batchResults[0]?.meta?.changes);
  if (!Number.isSafeInteger(revisionChanges) || revisionChanges < 0 || revisionChanges > 1) {
    throw new DiscussionCommandError('storage_failed', 'Database returned an invalid projection CAS result.');
  }
  if (revisionChanges === 1 && batchResults.slice(1).some((result) => Number(result?.meta?.changes) !== 1)) {
    throw new DiscussionCommandError('persistence_incomplete', 'The command projection committed without every expected immutable record.');
  }

  const saved = await first(db, 'SELECT message_id, seq, space_id, thread_id, kind, actor_id, body_json, created_at FROM messages WHERE message_id = ?', command.message_id);
  if (saved) {
    if (saved.kind !== 'discussion_command' || saved.space_id !== scope.space_id || saved.actor_id !== scope.actor_id) {
      throw new DiscussionCommandError('command_conflict', 'This message UUID is already in use.');
    }
    const savedBody = parseEventBody(saved.body_json);
    if (JSON.stringify(savedBody.action) !== JSON.stringify(command.action)) throw new DiscussionCommandError('command_conflict', 'This message UUID is already in use.');
    const savedProjection = await first(db, 'SELECT storage_revision, state_json, last_command_id FROM discussion_projection WHERE space_id = ?', scope.space_id);
    if (!savedProjection || savedProjection.storage_revision < savedBody.storage_revision
      || (savedProjection.storage_revision === savedBody.storage_revision
        && (savedProjection.last_command_id !== command.message_id || savedProjection.state_json !== nextJson))) {
      throw new DiscussionCommandError('persistence_incomplete', 'The command event does not match the saved discussion projection.');
    }
    return receipt(saved, revisionChanges === 0);
  }

  const currentRows = await all(db, 'SELECT user_id FROM members WHERE space_id = ? ORDER BY user_id', scope.space_id);
  if (currentRows.length !== 2 || currentRows.some((row, index) => row.user_id !== members[index])) {
    throw new DiscussionCommandError('membership_changed', 'The two-member set changed before the discussion command was saved.');
  }
  const currentProjection = await first(db, 'SELECT 1 AS present FROM discussion_projection WHERE space_id = ?', scope.space_id);
  if (!currentProjection && await hasThreadHistory(db, scope.space_id)) {
    throw new DiscussionCommandError('projection_uninitialized', 'Thread history appeared before the first projection could be saved.');
  }
  throw new DiscussionCommandError('storage_conflict', 'The shared discussion changed during this command; retry with the same UUID.');
}
