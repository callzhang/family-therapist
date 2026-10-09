# Confirmed expression intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Root performs acceptance; development uses user-selected GPT-6 Luna medium.

**Goal:** Accept an authenticated member's exact confirmed expression once, atomically append its formal record and a durable queued Therapist task, and expose an authenticated UUID receipt.

**Architecture:** Reuse Sites identity and membership context. A D1 transaction batch conditionally inserts a message only into the latest active thread version, followed by its unique queued task. This task implements receipt/intake, not a running worker or member enrollment.

**Tech Stack:** Existing Vinext routes, D1 prepared SQL, Drizzle schema generation, Zod strict input validation, Node SQLite transactional integration tests.

## Files and contract

- Create `sites/family-therapist/src/server/intake.mjs`: strict command validation, authenticated scope checks, guarded transactional insert, immutable receipt comparison/readback, typed errors.
- Modify `sites/family-therapist/db/schema.ts`: `therapist_tasks` keyed by input message UUID, FK to immutable message sequence, space/thread, status `queued`, server creation timestamp. No pretend running/done flags before a worker exists.
- Generate an additive schema-only migration with `npm run db:generate`; do not rewrite existing migrations or apply hosted SQL.
- Create `sites/family-therapist/app/api/messages/route.ts`: member authenticated POST, JSON only, bounded request size, no accepted actor/space overrides.
- Create `sites/family-therapist/app/api/messages/[messageId]/route.ts`: GET authenticated receipt restricted to caller's submitted expression in its own space, no arbitrary historical-message bypass.
- Create `tests/site/intake.test.mjs`: use actual generated migrations and SQLite transactions behind a D1-shaped batch adapter, not stubbed SQL results.
- Create `docs/operations/expression-intake.md`; update README/CHANGELOG/tasks with verified boundary.

Input:

```js
{
  message_id: 'UUID',
  thread_id: 'UUID',
  expected_thread_seq: 1, // version anchor from get_thread, not last message seq
  text: 'Exact confirmed expression; whitespace and paragraphs preserved',
  confirmed: true
}
```

Reject extra fields and prototype properties. UUIDs use existing Zod dependency, expected version positive safe integer, text nonblank and bounded by UTF-8 request byte limit. Server never trims stored text or accepts model identity. Confirmation is the caller's explicit assertion under the local Skill; the API cannot verify that a human actually saw the text.

Receipt returns original `message_id`, `thread_id`, `seq`, `created_at`, server content digest or exact confirmed text, `task_status: 'queued'`, and duplicate flag. Queued is not a Therapist reply or proof of unattended execution. The actor and space always come from `memberContext`, not request JSON.

## Transaction invariants

The SQL batch must recheck latest thread status/version and current membership at insertion time, even after preflight reads. `INSERT ... SELECT ... WHERE` with latest-version conditions prevents a concurrent settlement or membership revocation from accepting a stale expression. A duplicate message UUID is not changed. The task insert selects the saved message only if space, actor, thread and exact payload match the incoming command. Read back both rows after batch. Missing message, missing task, or failed batch is an error; no accepted receipt on partial persistence.

An identical retry returns the original receipt, even if the thread subsequently settled. Same UUID with different content, actor, thread or space is conflict; a foreign UUID must not disclose its body. Compare preserved text exactly, not a normalized variant. Concurrent identical requests result in one message and one task; concurrent conflicting content produces one accepted immutable record and one conflict. A batch failure rolls back both writes.

## Steps

- [x] Write regression tests for confirmed exact-text intake and task readback, idempotent duplicate, conflicting UUID, outsider/actor override, pending/settled/foreign thread refusal, stale version, state change between preflight/batch, atomic rollback and concurrent identical/conflicting requests.
- [x] Run the focused suite before implementation; record the missing-module or contract failure. The initial run failed because `src/server/intake.mjs` did not yet exist.
- [x] Add the schema and generate/inspect SQL. Implement the guarded service and bounded member routes without calling OpenAI, exposing secrets or creating participants.
- [ ] Run focused suite and all current root suites, TypeScript and build. Tests must assert message/task counts and actual saved text, not successful function return alone.
- [ ] Root applies new migration only to task-owned local fixture, exercises HTTP POST with fictional confirmed text and GET readback, then checks the UI and downloads include the same UUID/text. No hosted writes or real relationship material.
- [ ] Document implemented intake, outstanding native agent connection, discussion mutation API, worker claiming/checkpoint/late-output guards, hosted secrets, unattended trigger and real provider credit blockers. Commit only this bounded feature.

This plan deliberately produces a real queued intake boundary. It does not satisfy the full cloud runtime completion criterion or automatically start hourly local automations.
