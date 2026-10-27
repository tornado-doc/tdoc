#!/usr/bin/env node
// Read-only report of split accounts and mis-owned documents (#58): one
// GitHub id or email reachable from several accounts, handle pointers that
// disagree with the GitHub id index, and docs whose owner account is unknown,
// merged into another, or one of the duplicates. Prints counts and account
// ids only -- no email addresses, no handles. Writes nothing.
//
// Usage:
//   node worker/scan-account-duplicates.mjs <kv-namespace-id>
//
// Needs: wrangler logged in to the Cloudflare account that owns the KV.

import { scanAccountDuplicates, wranglerKv } from './identity-ops.mjs';

const ns = process.argv[2];
if (!ns || ns.startsWith('--')) {
  console.error('usage: node worker/scan-account-duplicates.mjs <kv-namespace-id>');
  process.exit(1);
}
const kv = await wranglerKv(ns);
const readOnly = { list: kv.list, get: kv.get };
console.log(JSON.stringify(await scanAccountDuplicates({ kv: readOnly }), null, 2));
