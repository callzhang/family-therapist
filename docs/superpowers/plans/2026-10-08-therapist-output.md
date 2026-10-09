# Therapist output validation Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Development uses GPT-6 Luna medium; primary performs acceptance.

**Goal:** Define the cloud consultation output and reject fabricated or out-of-scope citations before it can become a reply or automatic common point.

**Architecture:** A pure application validation boundary follows the existing Responses transport loop. Its trusted evidence list is supplied by the server from formal records at the frozen run snapshot; model output cannot define evidence or approve agreements.

**Tech Stack:** Pure JavaScript ES modules and Node test/assert; no network or new dependencies.

## Files

- `packages/therapist/output.mjs`: strict JSON schema `THERAPIST_OUTPUT_SCHEMA`, semantic structural/citation validation `validateTherapistOutput(output, context)` returning an independent cloned output or a typed error.
- `tests/therapist/output.test.mjs`: meaningful negative and positive evidence cases using synthetic UUIDs.
- `docs/operations/therapist-output.md`: contract and implementation/clinical limitations.
- `skills/cloud-therapist/SKILL.md`: align output contract and source use without repeating the entire schema.

Context is server-owned `{ space_id, thread_id, snapshot_seq, member_ids: [partnerA, partnerB], messages: [...] }`. Evidence messages carry `{message_id, space_id, thread_id, seq, actor_id, kind}`. The server obtains this set independently; output cannot import unknown references or supply a different context.

Output:

```js
{
  reply: 'Natural shared reply',
  source_message_ids: ['UUID'],
  common_points: [{text: 'A revisable common point', source_message_ids: ['UUID','UUID']}],
  differences: [{text: 'Attributed unresolved difference', source_message_ids: ['UUID']}],
  hypotheses: [{text: 'A question or tentative hypothesis', source_message_ids: ['UUID']}],
  consensus_proposal: null // or {text: 'Proposed exact wording', source_message_ids: ['UUID']}
}
```

All output keys required; nullable proposal; all object schemas forbid additional properties. Nonblank bounded strings and finite bounded lists keep storage predictable. UUID syntax must be validated with a generic format check, not topic or phrase matching. Every cited UUID must be in the trusted evidence set, in this space/thread, at/before snapshot, and from a `member_expression` submitted by one of the two members. Reject UUID duplicates in a citation list and ambiguous duplicate evidence IDs. Automatic common points specifically require actual formal expressions from BOTH member IDs; therapist replies, operations, model hypotheticals and one partner repeating themselves never substitute for the second person.

Reject action fields (`settle`, approvals, actor override) through strict shape rules. Proposal stays proposed; validation never creates confirmed agreements or changes thread status. An empty automatic-summary array is permitted, for example after only one member has spoken. This structural gate does not prove that the cited text semantically supports the generated statement; that needs frozen behavioral evaluations and primary review.

## Steps

- [x] Write tests first: valid two-partner common point; one-sided reply with empty common points; common point backed by only one person rejected; foreign space/thread and future record rejected; unknown/duplicate UUID rejected; operations or therapist reply cannot serve as member expression evidence; extra fields and malformed/blank/oversized output rejected; input output objects remain immutable; consensus proposal remains unconfirmed.
- [x] Run focused suite RED, implement minimum module, and run the focused suite GREEN. The shared full suite was not used as a gate because other agents are modifying it concurrently.
- [x] Review schema required/nullable/additional-properties consistency against provider strict mode. No transport/recovery or existing runtime tests were modified.
- [x] Document parser-vs-business-validation separation: existing transport completed means provider parsed, only this validated result is eligible for application commit. Current pipeline/real generation remains incomplete.
- [ ] Commit only owned files and report boundaries. Primary will integrate at the actual durable commit boundary; no mock claim of hosted persistence or clinical quality.
