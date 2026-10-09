# Responses Therapist runtime: bounded implementation task

Approved authority: `../specs/2026-10-08-family-therapist-design.md`, especially section 3.0. Credential decision resolved: project key created and securely saved in ignored root `.env.local`; do not read or print its contents during unit implementation.

## Task 1: tool registry and one resumable model turn

Create `packages/therapist/tools.mjs`, `packages/therapist/responses.mjs`, `tests/therapist/responses.test.mjs`. No external dependencies, no database, no scaffold changes. Registry is an explicit finite function protocol, not natural-language keyword checking.

- [ ] Write meaningful tests first: model asks get_thread then get_messages then emits structured output; strict tool definitions have all properties required with nullable optionals; fixed authenticated run scope reaches executor but model cannot override actor/space/snapshot; unsupported write tool rejected; arguments malformed or executor fails produces explicit task failure; model incomplete/failed never yields success; tool budget prevents loops; continuation checkpoint is available after each response and tool result and can restore an interrupted round without duplicate tool execution.
- [ ] Observe expected failures before implementation.
- [ ] Implement Responses request/continuation using injectable `request` and `executeTool` functions. Do not write a live network caller for unit tests. Inputs include explicit model, instructions, input messages, authenticated run scope, max tool calls, and optional persisted checkpoint. User instructions are supplied on every request in the call chain, independent of previous_response_id. Function result items carry matching call_id. Tools list contains only list_threads, get_thread, get_messages, get_message, get_agreements. Queries accept UUID/pagination/status fields, not actor/space identity; a server-bound scope is passed separately to executor.
- [ ] Save each response/individual tool result through awaited `saveCheckpoint`, supplied by the application. Idempotency identity is run id + model call_id; read queries may rerun after crash before checkpoint, but already persisted results are reused. A thrown provider/tool/parse/budget error leaves usable checkpoint and never returns an invented final reply. Budget and structured output JSON Schema are explicit inputs. Parse final JSON, return its object only after an actually completed model response and no pending function calls; application validates business references and persists outputs later. No consensus approval tools.
- [ ] Run focused unit tests and all existing protocol tests once after final changes; self-review and commit only these files.

Return artifact and checkpoint contracts in `docs/operations/responses-runtime.md`; record actual test results. This library establishes tool orchestration, not hosted durable scheduling or clinical effectiveness. Live provider verification follows separately with synthetic input and secure environment loading, only after unit acceptance.

## Next integration steps

- Install Sites starter dependencies and retain hosting project ID.
- Implement authenticated D1 query adapter with snapshot filtering, then connect registry to shared HTTP/query services.
- Add cloud Therapist Skill and structured output validation; conduct fixed synthetic consultation eval.
- Verify independent background continuation, private access and hosted credential configuration before calling product usable.
