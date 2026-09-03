#!/usr/bin/env node
// Backfill the immutable GitHub numeric id onto hosted-account records that
// predate the identity index.
//
// Why: account resolution is id-first (`account-idp:github:<id>`), and the
// worker no longer falls back to claiming an account by handle — a freed
// GitHub name can be registered by anyone, and a handle-only record cannot
// tell its returning owner from a squatter wearing the name. That fallback
// is safe to retire only once every record carries its id, which is what
// this script does. Run it BEFORE deploying a worker that includes the
// retirement; installs with no handle-only records have nothing to do.
//
// The id for each handle comes from GitHub's public API *today* — correct as
// long as the handle has not changed hands since the record was written.
// Review the printed handle → id mapping before confirming; if a handle
// looks reclaimed, exclude it and resolve that account by hand.
//
// Usage:
//   node worker/backfill-github-identities.mjs <kv-namespace-id>            # dry run
//   node worker/backfill-github-identities.mjs <kv-namespace-id> --write
//
// Needs: wrangler logged in to the Cloudflare account that owns the KV.

import { execFileSync } from 'node:child_process';

const ns = process.argv[2];
const write = process.argv.includes('--write');
if (!ns) {
  console.error('usage: node worker/backfill-github-identities.mjs <kv-namespace-id> [--write]');
  process.exit(1);
}

const kv = (args, input) => execFileSync('npx', ['wrangler', 'kv', 'key', ...args, '--namespace-id', ns, '--remote'], {
  encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
});

const listing = JSON.parse(kv(['list', '--prefix', 'hosted-account:']).replace(/^[^[]*/, ''));
let touched = 0;
for (const { name } of listing) {
  const handle = name.slice('hosted-account:'.length);
  const rec = JSON.parse(kv(['get', name]));
  if (Array.isArray(rec.identities) && rec.identities.some((i) => i && i.provider === 'github')) {
    console.log(`ok    ${handle} — already carries a github identity`);
    continue;
  }
  const r = await fetch(`https://api.github.com/users/${encodeURIComponent(handle)}`, {
    headers: { 'Accept': 'application/json', 'User-Agent': 'tdoc-backfill' },
  });
  if (!r.ok) {
    console.log(`SKIP  ${handle} — GitHub /users lookup failed (${r.status}); resolve by hand`);
    continue;
  }
  const gh = await r.json();
  const id = gh && gh.id ? String(gh.id) : null;
  if (!id) { console.log(`SKIP  ${handle} — no id in GitHub response`); continue; }
  const now = new Date().toISOString();
  const identities = Array.isArray(rec.identities) ? rec.identities.slice() : [];
  identities.push({ provider: 'github', sub: id, handle, linked_at: now, last_seen: now });
  console.log(`${write ? 'WRITE' : 'would'} ${handle} → github id ${id} (account ${rec.account_id})`);
  if (write) {
    kv(['put', name, JSON.stringify({ ...rec, identities })]);
    kv(['put', `account-idp:github:${id}`, JSON.stringify({ account_id: rec.account_id, created: now })]);
    touched++;
  }
}
console.log(write ? `done — ${touched} record(s) backfilled` : 'dry run — re-run with --write to apply');
