# Qwen Responses runtime verification

Date: 2026-10-09. Provider: `qwen3.8-27b`, medium reasoning, public Responses endpoint `https://llm-api.preseen.ai/v1`, accessed through the production `createResponsesRequest` adapter. Credentials remain outside source and verification records.

## Repaired behavior

The runtime separates read-tool evidence gathering from a no-tool structured final generation. Final input explicitly contains the original confirmed expression and persisted query results; empty provider continuation input is not used to infer the consultation task. Parsing reads the last assistant message only, excluding reasoning and intermediate prose. The worker rejects output that omits its triggering message UUID and covers other queued expressions only when their UUIDs are explicitly listed in the validated sources.

Failed regressions demonstrated reasoning contamination, missing final input, accidental final tool calls, and silently covered but unreferenced queued expressions before repair. Root independently ran all 186 initial deterministic tests and application type checking successfully; the Site build also passed. Separate specification and code reviews passed. The subsequent Workerd transport fix added two regression tests; all 188 tests, type checking, and the rebuilt Site passed.

## Real provider verification before deployment

Tests used fictional expressions, the production task worker and query executor, and isolated SQLite initialized from the application migrations. No provider response was injected or repaired.

| Case | Result | Requests / tool calls | Elapsed |
| --- | --- | --- | --- |
| Two member expressions | Complete reply and automatic understanding persisted; both expression receipts completed by one cited turn; repeating drain made no provider call | 11 / 9 | 186.6 seconds |
| One member and an existing settled agreement | Complete reply; common points empty and consensus proposal null; response respected the retrieved agreement without reopening it | 5 / 5 | 96.1 seconds |

Root inspected both generated replies for complete statements, correct attribution, one-topic focus, and the distinction between a proposed understanding and a jointly confirmed agreement. These controlled examples do not establish general clinical effectiveness. Repeated evidence queries remain possible within the twelve-tool-call budget, and provider latency varies.

Private operational receipts are retained locally under `.superpowers/qwen38-qa/worker-public-both.json` and `worker-public-one.json`. Earlier experimental schema-valid but incomplete or unrelated replies were rejected during manual acceptance and are not passing evidence.

## Hosted verification

The first private deployment applied the public Qwen environment. A hosted synthetic call failed before reaching the provider in 1.377 seconds. A matching Miniflare/Workerd runtime reproduced the cause: constructing a request with `redirect: "error"` throws immediately. The adapter now uses `manual` and rejects 3xx responses without following or forwarding authorization. A real Workerd regression loads the adapter source and verifies that behavior; Node-only checks had not exercised this difference.

The redirect repair reached the provider, but a subsequent hosted request was canceled after 57.4 seconds (HTTP 503, Worker outcome `canceled`), leaving the original task's checkpoint and expired lease available for recovery. An authenticated, model-free NDJSON probe then delivered its first frame in 0.935 seconds, periodic frames every five seconds, and a terminal frame after 75 seconds; total elapsed time was 75.962 seconds. This demonstrated that a connected status stream can remain open beyond the observed cancellation point.

The permanent repair returns private NDJSON status from drain/retry after preflight checks. It aborts provider work on disconnection, retains bounded provider calls and checkpoint recovery, and publishes a terminal task result only after worker execution. The worker's default clock also now uses actual current time for each checkpoint and publication guard. Regressions prove both timely lease extension and refusal to checkpoint or publish after expiry. A configured member client has matching bounded `processTherapist`/explicit `retryTherapist` methods. Local Assistant release `2026-10-09.1` explains how to process an already confirmed expression without submitting another expression.

The permanent implementation passed all 202 deterministic tests independently at root, TypeScript checking, the Site build, and focused code review. The temporary lifetime probe was removed before publishing the permanent implementation. Private deployment `appgdep_6ac8c3d765688191bde3e67a030bffe7` succeeded from source `c5471d50eb81b078651274a55cadfd99875bb402`, with environment revision 2. The production local client then maintained the actual hosted task stream for 91 seconds and received a terminal `failed/provider_transport_error`, at the adapter's single-call timeout. No Therapist reply was published. Tunnel logs recorded origin `/v1/responses` cancellation at that same deadline; available LiteLLM access logs have no timestamps or request IDs to associate a completion with that call. A subsequent local-to-public minimal request received a provider response in 0.627 seconds, proving current gateway reachability from the local machine, not hosted consultation success.

Final hosted output, UUID increments, two-member QA settlement, and export readback remain pending while the provider layer is diagnosed using fixed synthetic probes. The retained original synthetic task and source UUIDs are preserved. The existing private audience is preserved. No scheduler or unattended trigger is installed by this repair.
