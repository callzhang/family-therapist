# Responses runtime verification — 2026-10-08

## Implemented and accepted locally

- Five strict read-only tool definitions: list_threads, get_thread, get_messages, get_message, get_agreements.
- Responses continuation and tool result correlation by call_id.
- Awaited checkpoints for input, raw provider response, processing phase, tool results and completed output.
- Completed turns return cached output; interrupted final parsing reuses persisted response; first-call failures retain original input.
- Checkpoints are bound to run, actor, space, snapshot and model. Unsupported model-supplied properties are rejected.

Primary acceptance command:

```sh
node --test tests/protocol/history.test.mjs tests/protocol/discussion.test.mjs tests/therapist/responses.test.mjs
```

Result: 38 tests passed, 0 failed (protocol: 15, Responses runtime including subtests: 23). The primary agent read implementation and repair diffs; acceptance identified recovery defects, which were reproduced by failing regressions and repaired in e97f64d. The full test run after repairs completed successfully.

Cloud Skill `skills/cloud-therapist/SKILL.md` and its focused consultation-method reference pass the skill-creator frontmatter/scaffold validator. This is structural validation; behavioral consultation evaluation has not run.

Sites starter dependencies installed. Plugin build helper completed a baseline Vinext build; this verifies the starter environment, not product pages or API behavior. A private unpublished Site is registered; project identity is stored in its hosting manifest. No deployment occurred.

## Live provider boundary

The project credential was created through the secure Platform workflow and saved only to ignored local configuration. Secret values and temporary setup material are not part of this document or Git.

- GET /v1/models: HTTP 200, confirming key authentication and model listing access.
- Synthetic Responses tool-loop probe: HTTP 429 before any tool execution; no generated result accepted.
- Single diagnostic minimal Responses request: HTTP 429, error.code=credit_balance_exhausted, error.type=insufficient_quota.
- Diagnostic request receipt: req_6ed6a919fb034cbb83f2c8c8238cda05.
- No retry-after header. Further generation retries stopped pending billing correction.

Official meaning: the selected organization has exhausted prepaid API credits. See [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes). This is not evidence of transient rate limiting, invalid key, successful generation, or live tool execution.

## Still required

Restore API credit balance, then rerun a synthetic live tool loop and fixed consultation cases. Implement authenticated snapshot-filtering database adapters, application output validation, independently triggered hosted task continuation, file exports, complete website pages and local client heartbeat/upgrade installation. Hosted credential configuration and both-member access remain separate deployment steps. None of those is established by the local pure-module tests or the starter build.
