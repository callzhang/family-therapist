# Independent principles and consensus files Implementation Plan

> **For agentic workers:** Use subagent-driven-development. GPT-6 Luna medium implements; primary accepts.

**Goal:** Produce separate private Markdown/JSONL files for formal shared principles and agreed conclusions, with source/confirmation/reopen records and exact export cutoff UUID.

**Architecture:** Reuse snapshot-filtered agreement queries and space updates, and the accepted known-length R2 writer. Browser and Agent routes have distinct auth helpers but call one export service. Only confirmed agreement rows are presented as agreements; source operation records remain separately labeled.

**Tech Stack:** Existing Vinext/D1/R2, streamed paginated ES modules, real SQLite/stream tests and local R2 acceptance.

## Files and requirements

- `src/server/agreement-archive.mjs` under the Site: creates streams with `{format,scope,snapshot,cutoff_message_id,readAgreementsPage,readUpdatesPage,rolesByActor}`. Formal agreement record includes ID/thread/scope/version/text/message_seq and actual confirmation-event message UUID resolved by trusted DB query at/before snapshot. Markdown labels global principle versus specific topic conclusion, then a separate operational history section; JSONL types distinguish header/agreement/operation.
- Export operation history includes `discussion_command` and earlier formal confirmation/reopen record kinds from the authenticated space at fixed snapshot; do not relabel pending proposal or unilateral approval as an agreement. Preserve original UUID/actor/body/time of operations. No member_expression or Therapist free-text body in this independent file; those remain in thread archives.
- `src/server/save-agreement-archive.ts`: context accepts common trusted db/scope/execute, read members/cutoff/source IDs parameterized, count bytes then same-snapshot streaming through FixedLengthStream, put/get expected size+ETag checks, private keyed by space/actor/snapshot. No public object URL or guessed UUID.
- Browser GET `app/api/archives/agreements/route.ts` uses existing memberContext; Agent GET `app/api/agreements/archive/route.ts` uses apiMemberContext(request). No auth fallback and no write controls.
- Principles section in relationship-view adds two download anchors. Reply labels/header clearly identify the AI as AI咨询师; no invented human credentials or clinical disclaimer block.
- Existing thread export headers gain actual `cutoff_message_id` (last included thread message UUID at fixed snapshot, null if empty), JSONL/Markdown header and response metadata. Preserve all old per-message IDs, snapshot and R2 checks.
- `tests/site/agreement-archive.test.mjs` and narrow updates to archive tests: multiple pages, global versus topic confirmed records, operations distinct from agreements, real UUID/cutoff preservation, malformed paging errors, source/body unchanged, fixed snapshot excluding later events.
- `docs/operations/readonly-site.md` describes separate export/local proof and remaining hosted access.

All streams are bounded by pages, and malformed `has_more` with missing/unchanged cursor must fail rather than silently stop or loop. Existing shared source lists supply canonical records; no semantic keyword classifiers, diagnosis or fabricated confirmation details.

## Steps

- [ ] Tests RED for independent streams/source metadata/operation separation and last-UUID header, implement minimal shared service/routes/UI.
- [ ] Run focused/current repository suites, TypeScript/build. Do not alter token/discussion/client/Skill code other agents own; exported source/history consumes their contracts.
- [ ] Root downloads actual generated-token space's independent file locally, compares three confirmed rows (one global principle) and bilateral/state operation records with DB/API UUIDs; root browser downloads fictional fixture archive and checks cutoff.
- [ ] Record source/build versus real local R2/hosted limits; commit owned files. No deployment, data seed, models or new Site registration.
