# Family Therapist

A couples-communication project that pairs a private local assistant for each participant with a shared AI therapist service. The local assistant helps a person organize one topic into a complete expression and asks for confirmation before submission. The shared service handles submitted messages, therapist responses, and mutually confirmed agreements.

The application supports UUID-based incremental history synchronization, full-history retrieval, and local file export. Agreement summaries are suggestions until both participants approve the same conclusion. A settled topic is referenced as agreed context; reopening it requires both participants' agreement. Later conduct is discussed as a separate event.

## Repository layout

- `sites/family-therapist/` — web application and service APIs
- `skills/local-therapist-assistant/` — local participant-side communication skill
- `skills/cloud-therapist/` — server-side therapist instructions
- `packages/` — shared protocol, therapist runtime, and local client packages
- `docs/operations/` — product and deployment guidance

## Development

Run the test suites and build from the repository root:

```sh
node --test tests/therapist/*.test.mjs tests/local/*.test.mjs tests/protocol/*.test.mjs tests/site/*.test.mjs
npm run build
```

Type-check the site with:

```sh
cd sites/family-therapist
npx tsc --noEmit
```

## Deploying your own instance

The Cloudflare configuration in `wrangler.cloudflare.jsonc` is a template. Replace the D1 database and R2 bucket placeholders with resources in your own Cloudflare account, apply the migrations, and set `THERAPIST_API_KEY` and `THERAPIST_MEMBER_SEED` as server-side secrets. Configure the trusted Responses API base URL and model for your deployment. Never commit credentials, member codes, real relationship conversations, or private exports.

See [Cloudflare deployment guidance](docs/operations/cloudflare-deployment.md) and [member token guidance](docs/operations/member-tokens.md).

## Privacy and scope

This repository contains application code and generic operating guidance. A deployment operator must independently configure access, storage, provider credentials, and retention. The application is an AI communication aid, not a licensed mental-health professional, diagnosis, or emergency service.
