// Single source of truth: org-owned GitHub OAuth App for commenter login on
// published docs. Owned by github.com/tornado-doc. Client ID is public.
//
// Two flows share this App:
//   - Device flow (CLIs, and the fallback when no secret is set) — no secret.
//   - Web redirect flow (browsers) — needs a client secret, injected out of
//     band as the GITHUB_CLIENT_SECRET worker secret (never in git). Set the
//     App's Authorization callback URL to https://<host>/auth/github/callback
//     for the redirect flow (a device approve may still bounce to /auth/done,
//     which stays a friendly static page).
//
// Consumers: worker/wrangler.toml.template (literal must match this module —
// enforced by test/no-drift.test.js), vercel/api/tdoc.js via
// vercel/lib/github-oauth.js.

module.exports = {
  GITHUB_CLIENT_ID: 'Ov23li1jJiBkS23x4O07',
};
