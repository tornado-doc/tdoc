Remote storage is source of truth. Local HTML is disposable. Local skill is authoring/scaffold.
Published reader invariants are provider-enforced in overlay/worker code and tests, not left only to author HTML or prompts.
Publish auth, multi-tenant scoping, GitHub-account/BYOK switching, and the client-version gap are documented as a tdoc at docs/publish-auth-architecture.html (live: tdoc.dev/d/tdoc-auth-arch) — read it before touching bin/tdoc-publish, bin/tdoc-update-nag, or the worker auth/hosted-token routes.
