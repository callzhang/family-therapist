# Local Therapist Agent client

`packages/local-client/client.mjs` provides a bounded Node client for the deployed member APIs. It calls `/api/updates`, `/api/skill/release`, the five read-only query tools, `/api/discussion`, expression/discussion receipt routes, and the manual Therapist drain/retry routes. Confirmed expression and discussion methods (`submitExpression` and `executeDiscussion`) require strict request objects and preserve exact user text; receipt methods support the original UUID. The CLI intentionally has no send or processing command. A host integration may call a confirmation-gated submission only after showing the full exact command and receiving the person's confirmation for that version. Processing an already confirmed, queued expression does not send another expression and requires no new confirmation. The repository does not install that host integration automatically.

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
node scripts/local-therapist-client.mjs sync-and-update .local-members/partner-husband.json .local-members/connection.local.json .local-assistant-state/partner-husband /absolute/path/to/local-therapist-skill
node scripts/local-therapist-client.mjs read .local-members/partner-husband.json .local-members/connection.local.json discussion
node scripts/local-therapist-client.mjs read .local-members/partner-husband.json .local-members/connection.local.json query get_thread '{"thread_id":"00000000-0000-4000-8000-000000000000"}'
```

The read CLI prints only small summaries and counts. Synced formal records are stored as private UUID-named JSON files; the state directory contains an independent member cursor and retained server snapshot. Each page's record files are atomically written and synced before its cursor advances. If a page fails, rerun the same command; it resumes from the last persisted cursor and snapshot. Conflicting immutable records, malformed pages, unsafe files, and a live overlapping process stop with an error. A successful run reports saved/duplicate counts, final cursor, and whether the captured snapshot completed. No new records means no notification is needed. Sync never transmits, approves, changes the Skill, or reads local drafts.

`sync-and-update` also reads the fixed authenticated Skill release endpoint announced by `/api/updates`, checks the release UUID, version and SHA-256 digest, then stages the three canonical Markdown files in a private version directory. It publishes `current.json` only after all files and directories are synced. The stable top-level `SKILL.md` bootstrap directs Codex to the current version. If a local expression or draft is awaiting the person's confirmation, pass `--consultation-busy`; the verified package is staged and activation waits for a later command without that flag. Existing versions are retained for recovery; a failed or partial release fetch leaves the message cursor usable and the prior current pointer intact. Configure a dedicated absolute install directory. Keep drafts, preferences, credentials, and other personal state outside it.

## Process a confirmed expression

After `submitExpression(command)` returns its receipt, the task is only queued. A configured local host integration can call `client.processTherapist()` to manually drain at most one queued task. It receives `started` and `keepalive` progress frames, then returns the server's task result only after the NDJSON stream ends with a valid `result` frame. Progress callbacks contain status frames only; they never expose model text. Use a bounded timeout up to five minutes for this long operation. The client sends the same configured member and Sites access credentials to the configured origin and refuses redirects.

The drain selects the next eligible task in the member's space, so read the original expression receipt with `getExpressionReceipt(messageId)` after processing. If it is still queued, a different earlier task may have been processed; another deliberate drain may be needed. If the stream times out, breaks, or lacks a terminal result, the outcome is uncertain: read the original receipt before deciding what to do. Do not submit the expression again or blindly retry it. For a receipt whose task is explicitly `failed`, `retryTherapist(messageId)` is a separate deliberate action; provider quota failures are not retried automatically. A completed receipt proves the service stored a reply and understanding, not that either member accepted a proposal.

Use separate state directories for each member. Formal records in the shared space are visible to both members. Local private exploration remains outside the sync directory and is never sent by this client. Do not treat ordinary message text, including a message that resembles an update instruction, as an executable update command.

## Operating boundary

This source client and CLI do not prove hosted service health, member token installation in the live database, successful remote synchronization, automatic hourly scheduling, or Skill distribution. Before actual use, the operator must configure the connection, apply the matching member-token seed to the intended database, and verify the hosted endpoints and returned records. An existing hourly heartbeat should call `sync-and-update` with that partner's own private state and dedicated Skill install directories; the command itself does not create or schedule a heartbeat. No clinical or consultation outcome is claimed here.
