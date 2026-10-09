# Read-only Site local browser fixture

Use only a local D1 database and a local R2 bucket. Do not seed hosted services or use real participant messages.

1. Start from the site's generated local database migrations and apply them only to local state.
2. Create fictional member rows for `local_seedy` and one fictional partner in one test space, each with distinct user IDs and role labels.
3. Add a short active thread with two submitted member expressions, a therapist reply, an `understanding_updated` event whose source IDs point to those messages, one global confirmed principle, and one thread-specific confirmed conclusion.
4. Add a second settled thread with enough messages to exceed the 50-message page and include a structured body that is not one of the supported UI text shapes.
5. In local auth preview, exercise the signed-in member identity header for each fixture member. Confirm missing identity gives 401, no membership gives 403, and no D1 binding gives 503.
6. Confirm thread selection, paragraph preservation, safe text rendering, visible source references, confirmed-agreement labels, quiet empty state, refresh, and the earlier-history notice.
7. Download Markdown and JSONL from the settled archive. Confirm both contain all messages through the reported snapshot, the JSONL preserves the unsupported body, and the artifact is returned only after an R2 write/read succeeds.
8. Remove the local fixture database and bucket state when browser QA is complete.

The implementation task does not run this fixture or seed any data. Production use requires independently configured D1/R2 bindings and a verified hosted migration.
