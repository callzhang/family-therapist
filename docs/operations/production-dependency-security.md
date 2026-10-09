# Production dependency security update

The Site production dependency graph had five advisories in the saved baseline audit: one critical, two high, and two moderate. The app lockfile now resolves all five to patched releases while keeping Next.js on the existing 16.3 minor line.

| Package | Before | After | Reason and dependency path |
| --- | --- | --- | --- |
| `next` | 16.3.4 | 16.3.8 | Direct dependency, also reached through `vinext` → `@unpic/react`. 16.3.8 includes the 16.3.6 critical `next/og` RCE fix and the 16.3.8 SSRF/cache fixes. [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j), [GHSA-cjq9-62q9-8jv4](https://github.com/advisories/GHSA-cjq9-62q9-8jv4) |
| `sharp` | 0.35.4 | 0.35.5 | Used by Next and Miniflare; the former Miniflare-only override pinned the vulnerable release. [GHSA-wq5f-xc86-pv6w](https://github.com/advisories/GHSA-wq5f-xc86-pv6w) |
| `source-map-js` | 1.2.1 | 1.2.2 | Transitive through Tailwind's PostCSS tooling. [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) |
| `baseline-browser-mapping` | 2.10.30 | 2.11.0 | Transitive through Next and Browserslist. [GHSA-w5vr-8v7q-w6rv](https://github.com/advisories/GHSA-w5vr-8v7q-w6rv) |
| `fast-uri` | 3.1.7 | 3.1.8 | Transitive through `@hookform/resolvers` → AJV. [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) |

## Verification

The saved baseline `npm audit --omit=dev` report had 5 findings (2 moderate, 2 high, 1 critical; 197 production dependencies). After the lockfile update, the same command reports 0 findings (197 production dependencies). This result covers the production graph only; it does not claim to clear the separate GitHub alert count or development-only advisories.

The following local checks passed against the updated app lockfile:

- `npx tsc --noEmit -p tsconfig.json`
- `node --test tests/protocol/*.test.mjs tests/therapist/*.test.mjs tests/site/*.test.mjs tests/local/*.test.mjs` — 179 passed, 0 failed.
- `npm run build` at repository root — the app's Vinext build completed, then the root wrapper prepared and validated `dist/` and Drizzle metadata.

No hosted source, Site configuration, database, or deployment was changed as part of this dependency update.
