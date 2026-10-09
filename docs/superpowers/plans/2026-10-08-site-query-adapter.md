# Sites query adapter — bounded task

Authority: approved family therapist design and Responses tools. Work in existing Site at `sites/family-therapist`; project ID already registered. No new Site, publishing, key creation or model calls.

## Task: snapshot-filtered D1 reads

Create `sites/family-therapist/src/server/queries.mjs`, `sites/family-therapist/db/schema.ts`, a schema migration through the starter's db:generate, and `tests/site/queries.test.mjs`. Current schema is empty; do not replace starter auth/build helpers. Use actual parameterized SQL with D1 `.prepare().bind().all()/first()` and input scope supplied by the server, not model args.

Tables: members(space_id, user_id, role); messages(seq INTEGER PRIMARY KEY AUTOINCREMENT, message_id UUID UNIQUE, space_id, thread_id nullable, kind, actor_id, body_json, created_at); thread_versions(space_id, thread_id, message_seq, title, status pending/active/settled, summary); agreement_versions(space_id, agreement_id, thread_id nullable, message_seq, version, text, confirmed). Version message_seq anchors an existing message. Each query obtains latest relevant version at or before scope.snapshot_seq. Pending confirmation and mutations are not implemented in this read task.

Export `createQueryExecutor(db)` returning an async execute(name,args,scope) for five existing runtime tools. Require membership of scope.actor_id in scope.space_id before any object/cursor lookup. scope includes snapshot_seq and consultation_thread_id; no model can alter these. Thread list summaries may include old settled threads, but transcript reads/get_message must be limited to the consultation thread and must reject settled transcript access. get_thread returns the snapshot version and official conclusion information, not raw closed history. get_agreements includes only confirmed versions at the snapshot, also global principles when relevant.

All list results have stable server order, limit cap, has_more and next cursor (UUID, exclusive). Messages return parsed body and actor attribution, never arbitrary SQL or private local data. Unknown cursor, foreign cursor or foreign object must return explicit error after membership check. No UUID string sorting. JSON parsing failures fail explicitly.

Tests first using real SQLite semantics (Node sqlite DatabaseSync via a small D1-shaped test adapter, no mocked results): incremental/full pages, late insert excluded by snapshot, latest version chosen before snapshot, settled transcripts denied, foreign members/cursors/threads denied, global/confirmed agreements, invalid JSON fails, unknown tool fails. Use synthetic UUIDs. Register the Site hosting bindings DB/BUCKET in existing .openai/hosting.json while preserving project_id. Generate schema migrations and inspect SQL. Do not seed real participants or apply hosted migrations.

Run focused tests, then existing suite once before commit; update docs/operations/site-queries.md describing authenticated actor mapping and production integration obligations. Commit only adapter/schema/migration/manifest/tests/docs for this task. Existing parent protocol/runtime implementation remains authoritative; do not rename or change it.
