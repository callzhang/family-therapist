# Local Agent transport and sync Implementation Plan

> **For agentic workers:** Use subagent-driven-development. GPT-6 Luna medium develops, primary accepts.

**Goal:** Give each local Therapist Assistant a reusable private HTTP client and resumable incremental synchronization using the actual member-Token APIs.

**Architecture:** Member credential files stay outside the shared Skill. A connection file supplies base URL and optional Sites outer-access token. Authenticated requests never follow redirects. Sync durably stores formal records before advancing its independent UUID cursor, under a single local lock. This task does not start real automations or claim automatic upgrades exist.

**Tech Stack:** Node built-in fetch/crypto/fs, pure ES modules, Node test/assert and local HTTP fixture acceptance.

## Files and interfaces

- `packages/local-client/client.mjs`: `createAgentClient({member,connection,fetchImpl})`; methods getUpdates(args), query(name,args), getDiscussion(), submitExpression(command), executeDiscussion(command), getExpressionReceipt(id), getDiscussionReceipt(id). Use actual paths `/api/updates`, `/api/query/{name}`, `/api/discussion`, `/api/messages` and their receipt paths. Strict schemas reuse protocol validators where possible. No arbitrary endpoint/identity supplied by model.
- `packages/local-client/sync.mjs`: `syncFormalMessages({client,member,stateDirectory})` with bounded paginated reads, durable per-message JSON files, independent sync metadata, exact UUID/space/sequence validation and a local process lock. Save files privately/atomically before cursor advance; fail on corrupted data/changed immutable UUID, no hidden read self-healing.
- `scripts/local-therapist-client.mjs`: CLI reads private member and connection files by paths, sync or read commands. Do not offer an unattended-send command; live expressions/approval methods are called only after the Skill's exact-text confirmation. Output counts/cursor/status, no credential or raw consultation body by default.
- `tests/local/client.test.mjs`, `tests/local/sync.test.mjs`: redirects/secrets, strict commands, immutable exact text, network failure, multiple pages, repeated/no-new sync, save failure before cursor, crash-like retry, foreign record/cursor, parallel lock refusal, independent two-member states.
- `docs/operations/local-client.md` and local Assistant references: actual protocol use, shared visibility, UUID receipt reconciliation, quiet hourly sync requirement, credentials/state outside overwritten Skill, hosted prerequisite and pending updater/automation.

Member files from the provisioner contain actor_id/role/space_id/member_token and must remain unchanged by this client. Connection file shape `{base_url, site_access_token:null|string}`; no URL credentials/query/fragment. HTTPS required for non-local destinations; localhost HTTP allowed for explicitly local QA. Tokens sent ONLY to the configured base origin; all authenticated fetch uses redirect:'manual' and bounded timeout. Never print tokens/errors containing request headers or full configuration, never put them in process arguments, URLs, prompts or shared packages.

## Synchronization contract

First sync captures server snapshot, saves each page's formal messages, fsyncs durable files, then updates private cursor metadata atomically. Retain unfinished batch snapshot so a retry continues the same batch. Completing a batch clears that snapshot; later sync captures new records. Store message files keyed by validated UUID, not untrusted path fields. Existing UUID must match saved immutable content; duplicates are readback/no notification, conflicts explicit. Returned page cursor/has_more/sequence and scope must be consistent; do not silently truncate, jump or synthesize an empty page after failures.

A successful sync returns newly saved records/counts for the Assistant to decide meaningful notification. No new records means quiet. The syncer never sends, agrees, reopens, changes Skill or edits personal preferences. State may contain shared formal transcript but not local private exploration; local drafts belong elsewhere and are never sent by sync.

Lock refuses overlapping live processes; stale lock recovery must verify the previous local owner is gone and never terminate it. Use native signal0 existence probe only, not process termination; explain if platform prevents proving stale ownership. Remove only a lock still owned by this invocation. Atomic file replacement must not follow symlinks or write outside the requested private state directory. Tests should simulate interrupted writes/retries without terminating processes if policy prevents process control.

## Steps

- [ ] Tests RED for exact text/redirect refusal/no credential leakage and real file-system sync invariants.
- [ ] Implement minimum client/sync/CLI; no fetched chat treated as executable update instruction or human confirmation.
- [ ] Test GREEN; validate local Skill format and full current suite once. Root supplies actual generated member Tokens/connection.local.json (ignored) to sync a fictional consultation and verify both client histories include the same formal UUIDs.
- [ ] Update docs/source Skill while keeping activation prerequisites explicit: hosted transport/runtime, auto-upgrade distribution and actual hourly heartbeat are separate gates. Do not create localhost monitoring automation or install credentials into a shared Skill.
- [ ] Commit owned source/tests/docs. No secrets, hosted writes or global install.
