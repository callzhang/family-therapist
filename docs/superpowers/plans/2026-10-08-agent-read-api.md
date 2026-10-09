# Agent history and incremental sync Implementation Plan

> **For agentic workers:** Use subagent-driven-development. GPT-6 Luna medium develops, primary accepts.

**Goal:** Expose the existing read services to token-authenticated personal Agents and provide a complete space-wide UUID increment stream for hourly synchronization.

**Architecture:** Agent APIs use `apiMemberContext(request)` from the token task. Query requests use the same five strict argument definitions as the Responses runtime, with server-owned member-view scope. A separate paged space stream includes formal expressions, Therapist replies, operations and system upgrade notices without uploading local drafts.

**Tech Stack:** Existing prepared D1, ES modules, Zod/strict function validator, Vinext routes, real SQLite tests.

## Files

- `sites/family-therapist/src/server/updates.mjs`: `getSpaceUpdates({db,scope,after_message_id,limit,snapshot_seq})`, membership before cursor lookup, parsed formal messages and immutable snapshot metadata. Args are UUID/null cursor, integer1..100 limit, optional safe snapshot no later than server current scope snapshot. No scope/actor override.
- `sites/family-therapist/app/api/updates/route.ts`: GET token-authenticated updates; strict URL args, stable localized error codes.
- `sites/family-therapist/app/api/query/[name]/route.ts`: POST read-only tool args JSON, bounded body using existing intake reader; validate with `packages/therapist/tools.mjs`, execute `context.execute(name,args,context.scope)` with purpose member_view fixed server-side. Only the five supported read functions; unknown names and extra/prototype/identity args rejected. Clients may read settled archives; this does not relax cloud Therapist context.
- `tests/site/updates.test.mjs`: actual SQLite tables or generated migrations. Cross-member full/read, global system record, cursor exclusion, stable snapshot with later insert, all pages, final/empty cursor retained, wrong-member/scope/cursor, malformed JSON and bad envelope errors.
- `docs/operations/agent-read-api.md`: exact path/header/pagination protocol, quiet/no-new-events state and private Site outer access prerequisite.

Every page returns `{items,next_after_id,has_more,snapshot_seq}`. Initial full fetch has null cursor and captures current max seq for this space. The client reuses that snapshot for the remainder of the batch, saves the page before advancing UUID, and starts a later batch without snapshot override to capture new messages. Unknown/foreign/out-of-snapshot cursors fail explicitly. Empty page retains input cursor. Include actor/kind/body/time/thread/UUID/seq; no private drafts, Tokens or model hidden reasoning. Failing JSON parse or DB results must never become empty success.

## Steps

- [x] Test RED for actual pagination/scopes and failed storage/JSON, then implement the minimum shared service.
- [x] Add token routes after the `apiMemberContext(request)` contract existed; coordinate without editing token or message-route files. Preserve website view and all writes.
- [x] Validate strict query name/argument boundary, limit and snapshot parsing. Reuse existing validator instead of a second divergent schema; no arbitrary SQL or member identity.
- [x] Run focused and current root suites plus targeted TypeScript, ESLint, and build checks after token task commits. Primary's pre-generated two-member local-token HTTP acceptance is still pending.
- [x] Document implemented endpoints versus the uninstalled local client/heartbeat/upgrader and private Site outer-access prerequisite. No publishing, scheduling, secrets, or new Site.
- [x] Commit only owned files. The primary's live HTTP QA is a separate pending acceptance gate.
