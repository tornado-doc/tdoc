#!/usr/bin/env node
// Write the missing account-idp:github index for accounts born through
// Clerk + GitHub (#58). Those accounts were minted by handle, without the
// GitHub numeric id, so tdoc's own GitHub doors could not find them and
// minted a second account. Logic and safety rules: worker/identity-ops.mjs.
//
// DRY RUN BY DEFAULT: prints counts, the planned writes (account id + GitHub
// id) and every conflict (account ids only). Nothing is written without
// --write. An index that already names a different account is never touched;
// a GitHub id two accounts claim is written for neither. It also writes the
// account-github reverse key for every existing GitHub link and, last, the
// identity-reverse-index:complete marker that lets the worker trust a missing
// reverse key -- until then the worker attaches a GitHub id by email only to
// the Clerk-born record shape.
//
// Usage:
//   CLERK_SECRET_KEY=sk_live_... node worker/backfill-clerk-github.mjs <kv-namespace-id>
//   CLERK_SECRET_KEY=sk_live_... node worker/backfill-clerk-github.mjs <kv-namespace-id> --write
//
// Needs: wrangler logged in to the Cloudflare account that owns the KV.

import { planClerkGithubBackfill, applyWrites, wranglerKv } from './identity-ops.mjs';

const ns = process.argv[2];
const write = process.argv.includes('--write');
const key = String(process.env.CLERK_SECRET_KEY || '').trim();
if (!ns || ns.startsWith('--') || !key) {
  console.error('usage: CLERK_SECRET_KEY=... node worker/backfill-clerk-github.mjs <kv-namespace-id> [--write]');
  process.exit(1);
}

const clerkGet = async (path) => {
  const r = await fetch(`https://api.clerk.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'tdoc-backfill' },
  });
  return r.ok ? r.json() : null;
};
const clerk = {
  getUser: (id) => (/^[A-Za-z0-9_-]{1,64}$/.test(id) ? clerkGet(`/users/${id}`) : null),
  usersByEmail: async (email) => (await clerkGet(`/users?email_address=${encodeURIComponent(email)}&limit=10`)) || [],
};

const kv = await wranglerKv(ns);
const { counts, conflicts, writes } = await planClerkGithubBackfill({ kv, clerk });
for (const w of writes) console.log(`${write ? 'WRITE' : 'would'} ${w.key.split(':')[0]} account=${w.account_id} github_id=${w.github_id} via=${w.source}`);
for (const c of conflicts) console.log(`CONFLICT ${c.kind} accounts=${c.account_ids.join(',')}${c.github_id ? ` github_id=${c.github_id}` : ''}`);
console.log(JSON.stringify(counts));
if (write) {
  const { written, skipped } = await applyWrites(kv, writes);
  console.log(`done: ${written} key(s) written, ${skipped.length} skipped because they changed since the plan`);
  if (skipped.length) console.log('completion marker NOT written; re-run to finish.');
}
else console.log('dry run: nothing written. Re-run with --write to apply.');
