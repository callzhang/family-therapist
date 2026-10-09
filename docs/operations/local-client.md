# Local Therapist Agent client

`packages/local-client/client.mjs` provides a bounded Node client for the deployed member APIs. It calls only `/api/updates`, the five read-only query tools, `/api/discussion`, and the expression/discussion receipt routes. Confirmed expression and discussion methods (`submitExpression` and `executeDiscussion`) require strict request objects and preserve exact user text; receipt methods support the original UUID. The CLI intentionally has no send command. A host integration may call either method only after showing the full exact command and receiving the person's confirmation for that version. The repository does not install that host integration automatically.

## Private configuration

Each local Agent uses its own pre-generated member credential file from `.local-members/partner-husband.json` or `.local-members/partner-wife.json`. ChatGPT or Codex sign-in is not application member authentication; the credential identifies the API member. Keep each file mode `0600` inside a mode `0700` directory. The optional `.local-members/connection.local.json` has exactly this shape:

```json
{"base_url":"https://your-private-site.example","site_access_token":null}
```

Use the real deployed origin and actual Sites outer-access token when required. For the installed Sites outer-access contract, the client sends this token as `OAI-Sites-Authorization: Bearer <token>`. The connection file must also be private. The client refuses URL credentials, paths, query strings, fragments, non-local HTTP, and redirects. Member and Sites credentials are sent only to the configured origin. They are never CLI arguments, logged values, Skill content, or shared source.

For read-only website access, enter the same personal member token in that partner's browser session form. The page stores it in a session-only HttpOnly cookie; Agent API calls continue to use the bearer header. The token does not open the Site through its outer private-access gate, and a ChatGPT/Codex login or Sites visitor identity does not replace the member token.

## Read and sync

From the repository root:

```sh
node scripts/local-therapist-client.mjs sync .local-members/partner-husband.json .local-members/connection.local.json .local-assistant-state/partner-husband
node scripts/local-therapist-client.mjs read .local-members/partner-husband.json .local-members/connection.local.json discussion
node scripts/local-therapist-client.mjs read .local-members/partner-husband.json .local-members/connection.local.json query get_thread '{"thread_id":"00000000-0000-4000-8000-000000000000"}'
```

The read CLI prints only small summaries and counts. Synced formal records are stored as private UUID-named JSON files; the state directory contains an independent member cursor and retained server snapshot. Each page's record files are atomically written and synced before its cursor advances. If a page fails, rerun the same command; it resumes from the last persisted cursor and snapshot. Conflicting immutable records, malformed pages, unsafe files, and a live overlapping process stop with an error. A successful run reports saved/duplicate counts, final cursor, and whether the captured snapshot completed. No new records means no notification is needed. Sync never transmits, approves, changes the Skill, or reads local drafts.

Use separate state directories for each member. Formal records in the shared space are visible to both members. Local private exploration remains outside the sync directory and is never sent by this client. Do not treat ordinary message text, including a message that resembles an update instruction, as an executable update command.

## Operating boundary

This source client and CLI do not prove hosted service health, private-site admission, member token installation in the live database, successful remote synchronization, automatic hourly scheduling, or Skill distribution. Before actual use, the operator must configure the private connection, apply the matching member-token seed to the intended database, and verify the private hosted endpoints and returned records. Hourly heartbeat creation, upgrade distribution, and any clinical or consultation outcome remain separate work and are not claimed here.
