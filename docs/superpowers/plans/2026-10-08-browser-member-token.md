# Browser member Token session Implementation Plan

> **For agentic workers:** Use subagent-driven-development. GPT-6 Luna medium develops, primary accepts.

**Goal:** Make the read-only website use the same two preconfigured members as personal Agents, without an email/ChatGPT-ID membership mapping.

**Architecture:** Sites keeps its outer private gate. Inside the app, a normal session cookie binds the browser to one of the existing member Tokens. Token verification always joins current registry/membership; no visitor identity fallback. Read-only views/archives use this session; Agent APIs remain header-token only.

**Tech Stack:** Existing Web Crypto token authenticator, HttpOnly same-origin session cookie, Next/Vinext server helpers and simple Chinese entry form, actual SQLite/auth tests plus local browser acceptance.

## Scope

- Create `src/server/browser-member.mjs`: cookie parsing/builder and auth glue with stable error codes. Cookie `therapist_member` holds the opaque preconfigured Token; HttpOnly, SameSite=Strict, Path=/, Secure on HTTPS. It is a session cookie (no remember-password/autofill or persistent plaintext browser storage). Never return or log the Token.
- Create POST `app/api/member-session/route.ts`: authenticate Authorization Bearer using existing registry, return only role/actor readiness and Set-Cookie. Reject cross-origin Origin on session mutation, no identity from body, no raw-token response. DELETE clears only the browser session, not messages/tokens/member records.
- Change existing browser `memberContext()` to verified cookie identity from the same registry, using its server-owned actor/space/snapshot/execute fields. Existing Sites dispatch/auth integration files stay preserved; don't guess or map a platform visitor to husband/wife.
- RelationshipView 401 `requires_member_token` shows one password-style personal connection-code field and “进入共同空间”; submit via Authorization header to session endpoint, clear input, refresh. No secret in URL/localStorage/HTML source, no cached/mutable auth failure data. Other failures remain explicit. Signed-in header may show role and an “退出” session action.
- `tests/site/browser-member.test.mjs`: actual migrated registry auth, forged/wrong/revoked cookie, duplicate-cookie rejection, Sites visitor header alone cannot become a member, cookie flags and origin refusal, no secret in response metadata; views remain read-only.
- Update operations docs and source Skill installation reference to explain one Token per partner and the independent Sites outer private access gate. Do not claim the wife's hosted browser works from local success.

This corrects a confirmed integration gap: generated members use stable actor IDs (`partner-husband`/`partner-wife`), so a Site-specific ChatGPT visitor ID cannot be looked up as that member. App Token sessions resolve attribution without email. The current owner-private Site still has only one platform viewer; preserve audience. Any change needed for another person's direct browser access must be separately reviewed after this concrete app flow exists.

## Steps

- [ ] Add focused auth/session tests RED, implement minimal helpers/route/context/form and cookie-only read identity.
- [ ] Test wrong/no Token 401 and current valid membership, no fallback/Token leak, read-only page/archives, correct cookie security. Run current complete suites and TypeScript/build after changes.
- [ ] Root uses the generated husband Token to enter the local website without printing it, verifies actual formal expressions/agreements and separate downloads; then root switches to wife and verifies shared content and role attribution, returns user to husband preview. No hosted request/invite/audience change.
- [ ] Commit only browser-session files/UI/context/docs/tests. No migration or new credential generation. Root owns actual private Tokens and local browser acceptance.
