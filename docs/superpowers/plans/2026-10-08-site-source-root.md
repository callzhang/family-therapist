# Sites source checkout root

The Sites source helper requires Git and .openai/hosting.json at the selected checkout root. Preserve the existing registered Site and full protocol/runtime/Skill source history. Do not initialize a nested repository or register another Site.

Add a root hosting manifest matching sites/family-therapist/.openai/hosting.json, a root package manifest with a build wrapper, and scripts/build-site-root.mjs. The wrapper runs the existing app build with its own unchanged Sites integration, verifies matching project/binding manifests, then prepares root dist and drizzle from the app outputs for the official packager. Generated root outputs are ignored. Refuse stale/conflicting manifests; build artifacts may be replaced only as generated files in the explicit repository-root locations. Preserve app migrations ordering and all source files. No dependency duplication or root node_modules is needed.

Verify local wrapper build, final Worker entry/assets metadata, migrations including journal, and official prepare-site-build artifact inspection without a native save or deploy. Focused tests only for mismatch/missing build-output guards if useful; don't test shell plumbing by mirroring implementation. No source push, credentials, native Site mutation, hosted migration, or deployment in this task. Root owns publishing and acceptance.
