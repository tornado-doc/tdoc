#!/usr/bin/env node
// Move existing "public" docs that are not on anyone's profile to
// "Anyone with the link" (stored as visibility `unlisted`).
//
// Why: until this change a doc published with no flags was public, and a
// public doc is served without noindex, so search engines could index docs
// whose owners only meant to paste a link into Slack. New docs now default to
// the link; this moves the old ones. Docs pinned on a profile (/@handle) stay
// Public -- pinning a doc is the owner saying "show this to the world" -- and
// so do the site's own pages (homepage, /start, templates, pricing, the
// product feedback doc). Pass --keep for any other slug that must stay.
//
// "Public" here means what the worker reads as public: `access.visibility`
// is `public`, or the doc predates access policies and has no `access` block
// at all (legacy, read as public + full history). A legacy doc keeps its full
// history and commenting; only the visibility changes.
//
// Idempotent: a doc that is already link/private is left alone, so a second
// run finds nothing to do. Each migrated doc records `access_migration`
// ({ from, at }) so --undo can put back exactly what was there.
//
// Never runs on deploy. Run it by hand, dry run first:
//   node worker/migrate-public-to-link.mjs <kv-namespace-id>                 # dry run: counts + slugs
//   node worker/migrate-public-to-link.mjs <kv-namespace-id> --write         # apply
//   node worker/migrate-public-to-link.mjs <kv-namespace-id> --undo [--write]   # roll back
// Options: --keep <slug,slug>   leave these public as well
//
// Needs: wrangler logged in to the Cloudflare account that owns the KV (the
// META namespace). Writes keep each record's KV metadata (the doc index).

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The site's own pages: served at / , /start, /templates, /pricing and linked
// from /llms.txt. They are published Public on purpose.
export const SITE_PUBLIC_SLUGS = ['tornado-doc', 'tdoc-start', 'tdoc-templates', 'tdoc-pricing', 'd-hctqbnme'];

const LINK_ACCESS_FOR_LEGACY = { visibility: 'unlisted', commenting: 'signed_in', history_visibility: 'public', allowed_users: [] };

// What the worker's accessFromMeta() calls public, without importing it.
export function publicKind(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const a = meta.access;
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'legacy';
  if (a.visibility === 'public') return 'public';
  // An unknown value normalizes to unlisted on a policy-bearing doc.
  return null;
}

export function toLink(meta, at) {
  const kind = publicKind(meta);
  if (!kind) return null;
  const access = kind === 'legacy'
    ? { ...LINK_ACCESS_FOR_LEGACY, allowed_users: [] }
    : { ...meta.access, visibility: 'unlisted' };
  delete access.signin_required;
  return { ...meta, access, access_migration: { from: kind, at } };
}

export function undoLink(meta) {
  const m = meta && meta.access_migration;
  if (!m || (m.from !== 'public' && m.from !== 'legacy')) return null;
  const { access_migration: _drop, ...rest } = meta;
  // Only undo a doc that is still where the migration left it; an owner who
  // has since chosen something else keeps their choice.
  if (!rest.access || rest.access.visibility !== 'unlisted') return { ...rest };
  if (m.from === 'legacy') {
    const { access: _a, ...legacy } = rest;
    return legacy;
  }
  return { ...rest, access: { ...rest.access, visibility: 'public' } };
}

async function listAll(kv, prefix) {
  const out = [];
  let cursor;
  for (;;) {
    const page = await kv.list({ prefix, ...(cursor ? { cursor } : {}) });
    out.push(...(page.keys || []));
    if (page.list_complete !== false || !page.cursor) break;
    cursor = page.cursor;
  }
  return out;
}

// Slugs any profile pins, plus docs that carry the curated flag.
async function pinnedSlugs(kv) {
  const pinned = new Set();
  for (const { name } of await listAll(kv, 'account-profile:')) {
    let rec = null;
    try { rec = JSON.parse(await kv.get(name)); } catch {}
    for (const item of (rec && Array.isArray(rec.pins) ? rec.pins : [])) {
      const slug = typeof item === 'string' ? item : (item && item.slug);
      if (typeof slug === 'string' && slug) pinned.add(slug);
    }
  }
  return pinned;
}

// kv: { list({prefix, cursor}) -> { keys:[{name, metadata}], list_complete, cursor },
//       get(name) -> string|null, put(name, value, { metadata }) }
// The Workers KV binding has exactly this shape; the CLI wraps wrangler in it.
export async function runMigration(kv, { write = false, undo = false, keep = [], now = new Date().toISOString(), log = () => {} } = {}) {
  const keepSet = new Set([...SITE_PUBLIC_SLUGS, ...keep]);
  const pinned = undo ? new Set() : await pinnedSlugs(kv);
  const counts = { docs: 0, public: 0, legacy: 0, kept_pinned: 0, kept_site: 0, changed: 0, undone: 0 };
  const changed = [];
  for (const { name, metadata } of await listAll(kv, 'meta:')) {
    const slug = name.slice('meta:'.length);
    let meta = null;
    try { meta = JSON.parse(await kv.get(name)); } catch {}
    if (!meta || typeof meta !== 'object') continue;
    counts.docs++;
    let next = null;
    if (undo) {
      next = undoLink(meta);
      if (next) { counts.undone++; log(`${write ? 'UNDO ' : 'would undo'} ${slug} (was ${meta.access_migration.from})`); }
    } else {
      const kind = publicKind(meta);
      if (!kind) continue;
      counts[kind]++;
      if (pinned.has(slug) || (meta.profile && meta.profile.curated === true)) { counts.kept_pinned++; log(`keep  ${slug} (on a profile)`); continue; }
      if (keepSet.has(slug)) { counts.kept_site++; log(`keep  ${slug} (site page / --keep)`); continue; }
      next = toLink(meta, now);
      counts.changed++;
      log(`${write ? 'WRITE' : 'would'} ${slug}: ${kind} -> anyone with the link`);
    }
    if (!next) continue;
    changed.push(slug);
    if (write) await kv.put(name, JSON.stringify(next), metadata !== undefined && metadata !== null ? { metadata } : undefined);
  }
  return { counts, changed, write, undo };
}

function wranglerKv(ns) {
  const run = (args) => execFileSync('npx', ['wrangler', 'kv', 'key', ...args, '--namespace-id', ns, '--remote'], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 30,
  });
  return {
    // wrangler pages through the whole prefix itself and prints one array.
    async list({ prefix }) {
      return { keys: JSON.parse(run(['list', '--prefix', prefix]).replace(/^[^[]*/, '')), list_complete: true };
    },
    async get(name) { return run(['get', name]); },
    async put(name, value, opts) {
      const args = ['put', name, value];
      if (opts && opts.metadata !== undefined) args.push('--metadata', JSON.stringify(opts.metadata));
      run(args);
    },
  };
}

async function main(argv) {
  const ns = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--keep');
  const write = argv.includes('--write');
  const undo = argv.includes('--undo');
  const keepAt = argv.indexOf('--keep');
  const keep = keepAt >= 0 ? String(argv[keepAt + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (!ns) {
    console.error('usage: node worker/migrate-public-to-link.mjs <kv-namespace-id> [--write] [--undo] [--keep slug,slug]');
    process.exit(1);
  }
  const { counts, changed } = await runMigration(wranglerKv(ns), { write, undo, keep, log: (line) => console.log(line) });
  console.log('');
  console.log(JSON.stringify(counts));
  if (undo) console.log(`${changed.length} doc(s) ${write ? 'restored' : 'would be restored'}.`);
  else console.log(`${counts.public + counts.legacy} public (${counts.public} explicit, ${counts.legacy} legacy); ${counts.kept_pinned} kept (on a profile), ${counts.kept_site} kept (site / --keep); ${changed.length} ${write ? 'moved' : 'would move'} to anyone with the link.`);
  if (!write) console.log('Dry run. Nothing was written; re-run with --write to apply.');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
}
