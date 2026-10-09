# Cloudflare Worker deployment

This project can run independently of ChatGPT Sites on Cloudflare Workers. The
production Worker configuration is `wrangler.cloudflare.jsonc`; the app remains
built with the existing Vinext/Cloudflare adapter.

## Current deployment

- Worker: `family-therapist`
- URL: `https://YOUR_WORKER.YOUR_ACCOUNT.workers.dev`
- D1: `YOUR_D1_DATABASE_NAME`
- R2: `YOUR_R2_BUCKET_NAME`
- Model: `gpt-6.1-sol` through the OpenAI Responses API

The D1 database was initialized with the current Drizzle migrations and the two
member identities. The message, task, thread, and agreement tables are empty;
the prior ChatGPT Site history was not copied. R2 is reserved for archives
exported by the app.

## Build and deploy

From the repository root:

```sh
node scripts/build-site-root.mjs
wrangler deploy --config wrangler.cloudflare.jsonc
```

The `workers.dev` URL remains the same across Worker deployments while the
Worker name, account, and route are retained. Deleting the Worker or losing the
Cloudflare account can make the URL unavailable.

## Runtime secrets and membership

`THERAPIST_API_KEY` and `THERAPIST_MEMBER_SEED` are Worker secrets and must not
be committed. The generated member codes and setup seed are stored in the
ignored, permission-restricted `.local-members/` directory. Do not copy those
files into source control or logs. The site itself is protected by the two
individual member codes; API reads and writes reject requests without a valid
member identity.

The old ChatGPT Sites URL and its data remain separate. Local Agent clients
must be configured with the Worker URL and the matching member file before
using the new blank space.
