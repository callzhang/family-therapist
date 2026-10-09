# Confirmed expression intake

The Sites API accepts an authenticated member's confirmed expression for the latest active thread. `POST /api/messages` accepts only `message_id`, `thread_id`, `expected_thread_seq`, `text`, and literal `confirmed: true`. The actor and shared space come from the signed-in member context. Extra properties, invalid UUIDs, blank text, stale thread versions, non-active threads, missing membership, non-JSON bodies, invalid UTF-8, and bodies larger than 64 KiB are rejected.

The submitted text is stored exactly as provided, including leading or trailing spaces and paragraph breaks. The confirmation flag records the caller's assertion; this API cannot prove that a person saw or approved the exact text. The local Therapist Assistant must show the exact outgoing text and obtain confirmation before it calls this endpoint.

At this implementation checkpoint, the HTTP routes use the existing Sites `memberContext()` identity and membership adapter. This is interim route wiring, not the final identity path for a local Codex Therapist Assistant. The separately planned agent API token integration will bind the member from the pre-generated member token; request JSON will continue to be unable to choose actor or space.

The service writes one immutable `member_expression` message and one `therapist_tasks` row with `status = 'queued'` in one D1 batch. The SQL checks current membership and the latest active thread version during insertion. A repeated identical UUID and payload returns the original receipt; reusing the UUID for different text, actor, space, or thread returns a conflict. A receipt includes the server sequence and creation timestamp, exact text, and `task_status: 'queued'`.

`GET /api/messages/{messageId}` returns a receipt only for an expression submitted by the authenticated member in the member's current space. Missing and out-of-scope messages both return not found.

**A queued receipt proves persistence and queue acceptance only.** It does not mean a Therapist ran, produced a reply, or completed an unattended consultation. A persistent task claimant, execution checkpoint/recovery, late-output status guards, and real provider execution are still outstanding. Do not interpret a queue receipt as a Therapist response.

The migration is additive and schema-only. It has not been applied to a hosted database, and this implementation does not enroll members, seed relationship data, call a model provider, or install an automation.
