// Single source of truth: org-owned GitHub OAuth App for Device Flow
// commenter login on published docs. Owned by github.com/tornado-doc.
// Client ID is public; tdoc does not use a client secret for device flow.
//
// Consumers: worker/wrangler.toml.template (literal must match this module —
// enforced by test/no-drift.test.js), vercel/api/tdoc.js via
// vercel/lib/github-oauth.js. Set the OAuth App's Authorization callback URL
// to https://<host>/auth/done so GitHub's post-authorize redirect is not a 404.

module.exports = {
  GITHUB_CLIENT_ID: 'Ov23li1jJiBkS23x4O07',
};
