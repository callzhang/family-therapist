# Cloudflare Worker deployment

This project can run independently of ChatGPT Sites on Cloudflare Workers. The
production Worker configuration is `wrangler.cloudflare.jsonc`; the app remains
built with the existing Vinext/Cloudflare adapter.

## Configure your deployment

Create a Worker, D1 database, and R2 bucket in your own Cloudflare account.
Replace the D1 and R2 placeholders in `wrangler.cloudflare.jsonc` with your
resource names and D1 UUID. Configure the model and trusted Responses API base
URL for your provider.

## Build and deploy

From the repository root:

```sh
node scripts/build-site-root.mjs
wrangler deploy --config wrangler.cloudflare.jsonc
```

Cloudflare assigns the `workers.dev` address using your account and Worker
name. The deployment address is specific to your account.

## Runtime secrets and membership

`THERAPIST_API_KEY` and `THERAPIST_MEMBER_SEED` are Worker secrets and must not
be committed. The generated member codes and setup seed are stored in the
ignored, permission-restricted `.local-members/` directory. Do not copy those
files into source control or logs. The site itself is protected by the two
individual member codes; API reads and writes reject requests without a valid
member identity.

Configure each local client with your deployment's URL and the matching member
credential before use. Keep production URLs out of public source files when
they identify a private deployment.
