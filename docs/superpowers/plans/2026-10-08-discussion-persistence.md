# Durable discussion commands Implementation Plan

> **For agentic workers:** Use subagent-driven-development. User-selected GPT-6 Luna medium implements; primary accepts.

**Goal:** Persist topic creation and bilateral proposal/approval commands, protecting single active topic and settled/reopen rules under concurrent requests.

**Architecture:** Reuse the approved pure discussion contract with a compact per-space projection and a separate storage CAS revision. A D1 batch changes the projection, appends the immutable command event and writes changed thread/agreement versions atomically. Personal Agent routes require the new member Token; website remains read-only.

**Tech Stack:** Existing protocol/discussion.mjs, D1 batch transactions/guarded SQL, strict Zod schemas, generated additive migration, actual SQLite integration tests.

## Files and contract

- `sites/family-therapist/src/server/discussion-commands.mjs`: read projection and strict command service; typed errors; immutable UUID receipts and bounded projection growth. Use actual current two members, never request-supplied actor/space.
- `sites/family-therapist/db/schema.ts` and generated next migration: `discussion_projection(space_id PRIMARY KEY, storage_revision INTEGER, state_json TEXT, last_command_id TEXT)`.
- `sites/family-therapist/app/api/discussion/route.ts`: GET current public discussion state and POST command, token-authenticated, bounded JSON, stable localized codes.
- `tests/site/discussion-commands.test.mjs`: actual generated migrations/D1-shaped transactions, not fake output stubs.
- `docs/operations/discussion-commands.md`: client confirmation and recovery contracts, CAS conflicts, source/evidence limitations.

Input is strict `{message_id:UUID, confirmed:true, action}`. Supported actions match pure module: create `{type:'create',id:UUID,title}`, propose `{type:'propose',id:UUID,kind:'consensus'|'settle'|'reopen'|'switch',thread_id:UUID,target_id:UUID|null,text}`, approve `{type:'approve',id:UUID,text}`. Approval must match stored immutable exact proposal text, including whitespace. Proposing alone never approves. No automatic model approvals.

All public commands are formal records; no local draft is accepted. UUID retry compares exact canonical action and actor/space, returns original receipt if identical even after later state changed. Conflicting payload/actor rejects without exposing another person's text. GET state excludes any credential and returns storage revision, threads, proposals/approvals and confirmed agreements for both members.

## Atomicity and mapping

Load projection or initialize from exactly two current members. Apply the pure contract to a clone. Validate approval text before calling pure action. Use an SQL guard on the existing storage revision (or not-exists for first insert) and current membership; store last_command_id. The following event/version inserts must be conditional on that same command marker and exact resulting projection, so a lost CAS cannot append a misleading event. Batch failure rolls back projection/event/versions together. Read back the command UUID and saved projection before issuing a receipt. CAS loss is an explicit retryable conflict, never silently overwrite or claim consent.

Thread_versions get a new immutable version anchored to this command event only when title/status/summary changes. Switching produces both changes on the same event. Settling carries the agreed exact conclusion into summary; reopening to pending preserves that conclusion. Newly confirmed agreement gets an agreement_versions row anchored to this command, id=proposal UUID, version1, confirmed1. Confirming one consensus keeps thread active. Messages kind `discussion_command` preserve the command/actor/time. This task does not create a cloud reply or silently repair inconsistent old records.

Projection state is compact current discussion data, not raw transcript. First version can bound serialized projection at the D1 row-safe budget and return an explicit limit error rather than dropping history. Do not add arbitrary topic-count caps or paused state. Pure semantic revision versus storage revision must stay distinct; first-party approval/proposal addition cannot invalidate the other party's exact-version approval. Assess unrelated pending thread creation's effect on an existing proposal: if pure reference global revision causes unnecessary invalidation, report to primary before changing the approved contract. Ordinary Skill releases do not enter this projection.

## Steps

- [ ] Test RED for first create active/second pending, proposer not approved, repeated one-party approval never settle, mismatched text rejected, bilateral consensus remains active, settle/reopen and atomic switch preserve versions/history.
- [ ] Test UUID retries/conflicts, two concurrent creates never produce two active, concurrent approvals/CAS loss and safe retry, failure at event/version write rolls back all rows, outsider/membership recheck rejects, no actor/body override.
- [ ] Coordinate schema ownership with `member_tokens`; generate next additive migration only after its commit. Do not modify token/update/intake/UI files.
- [ ] Implement shared service/routes. Use pure module imports in actual Worker build; keep full protocol source auditable. No real model calls, scheduling, credentials or hosted changes.
- [ ] Run focused/full suites, TypeScript/build. Root local acceptance uses preconfigured Tokens to create a fictional active topic, submit complete expressions, propose/confirm and verify query/UI/archive states. Primary acceptance remains unchecked until executed.
- [ ] Commit owned feature/docs; explicitly state durable worker and hosted runtime remain outstanding.
