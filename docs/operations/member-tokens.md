# Personal Agent member tokens

Each partner uses a separate, pre-generated member token for the private message API. ChatGPT or Codex account sign-in does not identify an API member. The server binds each token digest to the current `(space_id, user_id)` membership and supplies `actor_id` from that row; request bodies and visitor headers cannot choose the actor.

From the repository root, run `node scripts/provision-member-tokens.mjs` once on the machine that will hold the local member configuration. The command creates `.local-members/partner-husband.json`, `.local-members/partner-wife.json`, and `.local-members/seed.sql`. The directory is mode `0700`; config files are mode `0600`. The two JSON files contain the plaintext tokens and must stay private. The seed SQL contains only SHA-256 token digests and membership rows. `.local-members/` is ignored by Git.

Run the generated seed SQL only against the intended local D1 database after migrations. The provisioner does not connect to or write any database. Re-running it validates and reuses the existing tokens. If the directory has partial files, inconsistent contents, or unsafe permissions, it stops for manual inspection. It never silently replaces a token.

Configure each personal Agent locally with its own token and send `Authorization: Bearer <member_token>` to the message API. Do not put the token in a source file, scheduled prompt, URL, request body, or log. Missing or invalid tokens receive HTTP 401 with a stable error code. Revoking a token sets `revoked_at`; removing its membership also invalidates it.

Member tokens identify API actors only. They do not change website sign-in, Sites audience, or the outer private-access requirement. Hosted use also needs the actual Sites access configuration and a private deployment that admits the intended people. Those hosted settings and unattended cloud execution require separate setup and verification.
