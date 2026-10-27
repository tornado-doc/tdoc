#!/usr/bin/env node
// Add the preview-only Clerk OAuth client to a materialized Wrangler config.
// The client secret is installed separately as a Worker secret by preview.yml.
const fs = require('fs');

const file = process.argv[2];
const clientId = String(process.env.TDOC_PREVIEW_OIDC_CLIENT_ID || '').trim();
if (!file) throw new Error('usage: tdoc-preview-oidc-config.js <wrangler.toml>');
if (!clientId) process.exit(0);
if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) {
  throw new Error('TDOC_PREVIEW_OIDC_CLIENT_ID must be an OAuth client ID');
}

const marker = '# PREVIEW_OIDC_VARS';
const input = fs.readFileSync(file, 'utf8');
if (!input.includes(marker) || input.includes('OIDC_CLIENT_ID =')) {
  throw new Error('preview Wrangler template has missing or duplicate OIDC settings');
}
const vars = [
  'OIDC_ISSUER = "https://clerk.tdoc.dev"',
  `OIDC_CLIENT_ID = "${clientId}"`,
  'OIDC_LABEL = "Email"',
].join('\n');
fs.writeFileSync(file, input.replace(marker, vars));
