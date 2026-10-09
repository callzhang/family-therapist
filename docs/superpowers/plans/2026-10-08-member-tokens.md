# Fixed per-partner API Tokens Implementation Plan

> **For agentic workers:** Use subagent-driven-development or executing-plans. GPT-6 Luna medium implements; primary accepts.

**Goal:** Authenticate each personal Agent with its own pre-generated stable Token and obtain a server-bound space/member identity without email or ChatGPT user mapping.

**Architecture:** Store only SHA-256 digests of high-entropy member tokens in D1, associated with the two-member rows. Member authentication is separate from Sites' outer private-access credential. Website visitor authentication stays under Sites; personal-agent HTTP endpoints require the member Token.

**Tech Stack:** Web Crypto digest, Bearer parsing, D1 prepared queries and generated schema migration, real SQLite integration tests, bounded Node provisioning script.

Confirmed 2026-10-08 steering supersedes the earlier email-based personal-agent authentication prerequisite. Each side uses their own ChatGPT or Codex and a preconfigured member Token. No token may appear in source, response bodies, schedule prompts or browser URL parameters.

## Files and contracts

- `sites/family-therapist/src/server/member-token.mjs`: `authenticateMemberToken({db, request})` returns `{space_id, actor_id, role}` after hashing the header and joining current membership. Missing/invalid/revoked token returns typed401 without logging the header or trying visitor identity.
- `sites/family-therapist/src/server/api-member-context.ts`: calls token auth and creates server-owned snapshot/query context. Existing browser `memberContext` stays unchanged; no default visitor identity fallback.
- Schema additive `member_tokens(token_sha256 PRIMARY KEY, space_id, user_id, revoked_at nullable)` with FK to composite members identity. At most one fixed Token per space/user; any replacement needs an explicit later operation, not silent rotation.
- Message POST/receipt GET routes use `apiMemberContext(request)` after the original intake commit is complete, retaining handlers and stable error codes.
- `scripts/provision-member-tokens.mjs`: generate into ignored `.local-members` files0600/directory0700 only when missing. Re-run validates existing configs and reuses Tokens, never rotates silently. Print paths/readiness only. Generate seed SQL with hashes/membership and no plaintext. Stable actorIDs `partner-husband`, `partner-wife`, fresh UUID space and random32-byte Tokens.
- `tests/site/member-token.test.mjs` and `tests/local/member-provisioning.test.mjs`: actual generated migrations; both distinct member mappings, wrong/missing Token, revocation/membership removal, no visitor-header fallback, idempotent provisioning and private permissions.
- `docs/operations/member-tokens.md`: exact header/config and local-versus-hosted readiness.

Provisioner config contains role, actor_id, space_id and member_token; base_url and site_access_token are supplied by primary from actual Sites metadata later, never guessed or printed. Missing remote configuration is explicit. Keep it independent from OPENAI_API_KEY. No raw Token in process arguments, returned receipts or logs.

## Execution

- [ ] Write focused tests RED using actual migrations, meaningful own-member/cross-member readback and safe provisioning re-run.
- [ ] Generate and inspect additive schema; implement hash registry/context/provisioner. No account invitation, access change, automation or hosted DB write.
- [ ] Coordinate with original intake agent; replace its two context imports only after its feature commit. Other query/UI/archive files remain untouched.
- [ ] Run focused/full current suites, TypeScript/build. Primary generates private local Tokens once, applies only local migrations/seed, submits fictional confirmed text with each Token and checks attribution, retry/conflict and wrong-token refusal.
- [ ] Document hosted Site outer-access dependency, fixed-token attribution and remaining webpage/unattended-work proof. Commit owned code/tests/docs; never secret files.

The API Token does not bypass private Sites dispatch. Website two-person access and unattended cloud execution remain separate acceptance requirements. Do not change Site audience or make the platform service credential act as a spouse.
