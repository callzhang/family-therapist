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

The original synthetic task and source UUIDs are retained for an explicit retry after the repaired deployment. Final hosted output, UUID increments, two-member QA settlement, and export readback are still pending. The existing private audience is preserved. No scheduler or unattended trigger is installed by this repair.
