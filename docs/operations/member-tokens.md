# Personal Agent member tokens

Each partner uses a separate, pre-generated member token. ChatGPT or Codex account sign-in does not identify an application member. The server binds each token digest to the current `(space_id, user_id)` membership and supplies `actor_id` and role from that row; request bodies and Sites visitor headers cannot choose the actor. Provisioned roles are `husband` and `wife`.

From the repository root, run `node scripts/provision-member-tokens.mjs` once on the machine that will hold the local member configuration. The command creates `.local-members/partner-husband.json`, `.local-members/partner-wife.json`, and `.local-members/seed.sql`. The directory is mode `0700`; config files are mode `0600`. The two JSON files contain the plaintext tokens and must stay private. The seed SQL contains only SHA-256 token digests and membership rows. `.local-members/` is ignored by Git.

Run the generated seed SQL only against the intended local D1 database after migrations. The provisioner does not connect to or write any database. Re-running it validates and reuses the existing tokens. If the directory has partial files, inconsistent contents, or unsafe permissions, it stops for manual inspection. It never silently replaces a token.

For a newly deployed hosted D1 database, apply the reviewed migrations first. Configure the server-only `THERAPIST_MEMBER_SEED` value with the exact JSON shape below, using the same space ID, fixed actors and roles, and SHA-256 digests of the two privately provisioned tokens:

```json
{"space_id":"<uuid>","members":[{"actor_id":"partner-husband","role":"husband","token_sha256":"<64 lowercase hex characters>"},{"actor_id":"partner-wife","role":"wife","token_sha256":"<64 lowercase hex characters>"}]}
```

Then each partner calls `POST /api/setup` with their own `Authorization: Bearer <member_token>` header and no request body. The caller must match one configured digest. The endpoint initializes both fixed members and token digests in one database batch, and returns only the caller's actor and role. An exact repeat is safe after readback. Any partial state, revoked token, or mismatch returns a conflict and is not repaired or rotated automatically; investigate the database and server configuration before proceeding. Setup never runs during reads and the request cannot choose a space or actor.

Configure each personal Agent locally with its own token and send `Authorization: Bearer <member_token>` to its APIs. A partner may also enter that token in the website's password-style connection field; the server sets a session-only `HttpOnly; SameSite=Strict` cookie, with `Secure` on HTTPS. Browser read requests then use that cookie, while Agent API requests continue to use the bearer header. The page offers a session exit action. Do not put the token in a source file, scheduled prompt, URL, request body, or log. Missing or invalid credentials receive HTTP 401 with a stable error code. Revoking a token sets `revoked_at`; removing its membership also invalidates both browser and Agent access.

Member tokens bind application membership. They do not replace any additional hosting-level access policy an operator chooses to configure. The seed environment value must remain server-side and must never be placed in a client bundle, checked into source, or printed in logs. These setup instructions do not deploy or verify the hosted service.
