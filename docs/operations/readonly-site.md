# Read-only Site local browser fixture

Use only a local D1 database and a local R2 bucket. Do not seed hosted services or use real participant messages.

1. Start from the site's generated local database migrations and apply them only to local state.
2. Create two member rows in one test space using actor IDs `partner-husband` and `partner-wife`, their `husband` / `wife` roles, and the matching token digest rows. Use only local D1.
3. Add a short active thread with two submitted member expressions, a therapist reply, an `understanding_updated` event whose source IDs point to those messages, one global confirmed principle, and one thread-specific confirmed conclusion.
4. Add a second settled thread with enough messages to exceed the 50-message page and include a structured body that is not one of the supported UI text shapes.
5. In local auth preview, enter one member's connection code in the page. Confirm it establishes a same-origin HttpOnly session cookie and shows that member's role. Test the other token in a separate browser session; a Sites visitor identity header alone must receive `requires_member_token`.
6. Confirm thread selection, paragraph preservation, safe text rendering, visible source references, confirmed-agreement labels, quiet empty state, refresh, and the earlier-history notice.
7. Download Markdown and JSONL from the settled archive. Confirm both contain all messages through the reported snapshot, the JSONL preserves the unsupported body, and the artifact is returned only after an R2 write/read succeeds.
8. Remove the local fixture database and bucket state when browser QA is complete.

The implementation task does not run this fixture or seed any data. Production use requires independently configured D1/R2 bindings and a verified hosted migration. R2 archive writes count UTF-8 bytes in a paged first pass, then stream a fresh read of the same fixed snapshot through a fixed-length stream; the site does not assemble full history in memory or set a guessed content length.

The principles view also offers independent Markdown and JSONL archives of confirmed global principles and topic conclusions, followed by a separate history of discussion-command operations. Its header records the space snapshot and actual last included message UUID. The browser route uses the member identity verified from its session cookie; the Agent route uses the member bearer-token context. Both persist under a private space/member/snapshot key and return only after R2 receipt and readback agree on size and ETag. The member token does not replace the private Sites outer-access gate. A hosted archive request or direct browser access for a second person is not proven by local acceptance.

## Primary browser acceptance

- Check the Chinese page title and readable three-item navigation at phone width, then use the visible thread selector to switch pending, active, and settled conversations.
- Open a settled item from the all-threads archive and verify its transcript is shown without changing its status. When the page omits earlier messages, use both full-export links.
- Verify only `member_expression` and `therapist_reply` appear as dialogue. Confirm each automated source link uses a readable speaker label and points to a visible message; an unsupported expression body displays the JSONL access notice.
- Clear the browser member session to verify the connection-code form appears and the page does not show the empty-space message. Separately verify an authenticated member with no records sees the calm empty state.
- Check a deliberately malformed latest `understanding_updated` record fails with an explicit read error instead of showing an empty or fabricated understanding summary.
- Compare downloaded archives with local D1 rows across multiple pages. Confirm Markdown speakers and UUIDs, JSONL raw-body preservation, and that a readback with mismatched R2 ETag or size cannot return a successful download.

## R2 fixed-length stream contract

The Cloudflare Workers runtime rejects `R2Bucket.put()` when given an unknown-length readable body. Archive export therefore uses two bounded passes over the same authenticated snapshot: count encoded bytes while discarding each first-pass chunk, then pipe a freshly generated archive through `FixedLengthStream(byteLength)` while `bucket.put()` consumes its readable side. The pipeline abort signal stops the producer if storage rejects. A successful download also requires the `put` receipt and `get` readback to match the counted size and ETag.
