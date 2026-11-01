// Shared core of the two identity maintenance scripts (#58):
//
//   worker/backfill-clerk-github.mjs   -- write the missing account-idp:github
//                                         index for accounts born through Clerk
//   worker/scan-account-duplicates.mjs -- read-only report of split accounts
//
// Both take a tiny KV interface so the logic is testable against an in-memory
// map (test/github-account-switch.test.js) and runs against Cloudflare KV
// through wrangler in production:
//
//   kv.list(prefix) -> [key names]     kv.get(key) -> string | null
//   kv.put(key, value)                 (backfill --write only)
//
// Output carries account ids and counts only -- never an email address.

const parse = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

function githubOfClerkUser(user) {
  const gh = (user && Array.isArray(user.external_accounts) ? user.external_accounts : [])
    .find((a) => a && /github/i.test(String(a.provider || '')));
  if (!gh || !gh.provider_user_id) return null;
  return { id: String(gh.provider_user_id), handle: String(gh.username || '').trim().toLowerCase() || null };
}

const githubSubs = (rec) => (rec && Array.isArray(rec.identities) ? rec.identities : [])
  .filter((i) => i && i.provider === 'github' && i.sub).map((i) => String(i.sub));

// Accounts born through Clerk + GitHub carry no account-idp:github index (the
// Clerk path minted by handle, without the numeric id), so tdoc's own GitHub
// doors could not find them. For each such account, ask Clerk which GitHub
// account its user connected and plan the missing index -- never over an
// index that already names a different account (reported as a conflict).
//
// Two ways to reach the Clerk user:
//   - account-idp:oidc:<clerk user id> -> account   (the user id directly)
//   - hosted-account:<handle> with no recorded GitHub id: the record's email,
//     looked up in Clerk; used only when exactly one Clerk user with that
//     address has GitHub @<handle> connected.
export const REVERSE_INDEX_COMPLETE_KEY = 'identity-reverse-index:complete';

export async function planClerkGithubBackfill({ kv, clerk }) {
  const counts = { oidc_links: 0, handle_records: 0, already_linked: 0, planned: 0, conflicts: 0, no_github: 0, unresolved: 0, reverse_keys: 0, parked: 0, already_parked: 0 };
  // Accounts this run could not give a GitHub link: handle-only records Clerk
  // could not resolve, and accounts in a conflict. They get a placeholder
  // reverse key so the worker never attaches a GitHub id to them by email.
  const unresolvedAccounts = new Set();
  const conflicts = [];
  const writes = [];
  // Every value is written only if the key still holds what was read here
  // (applyWrites re-reads it): a sign-in that changed it meanwhile wins.
  const want = async (key, value, info) => {
    if (writes.some((w) => w.key === key)) return;
    writes.push({ key, value, before: await kv.get(key), ...info });
  };

  // 1. Candidates: (account, GitHub id) pairs Clerk attests.
  const claims = []; // { accountId, gh, source, recordKey }
  for (const key of await kv.list('account-idp:oidc:')) {
    counts.oidc_links++;
    const rec = parse(await kv.get(key));
    if (!rec || !rec.account_id) { counts.unresolved++; continue; }
    const gh = githubOfClerkUser(await clerk.getUser(key.slice('account-idp:oidc:'.length)));
    if (!gh) { counts.no_github++; continue; }
    claims.push({ accountId: rec.account_id, gh, source: 'oidc' });
  }
  for (const key of await kv.list('hosted-account:')) {
    const rec = parse(await kv.get(key));
    if (!rec || !rec.account_id || githubSubs(rec).length) continue;
    counts.handle_records++;
    const handle = key.slice('hosted-account:'.length).toLowerCase();
    const email = typeof rec.email === 'string' ? rec.email.trim().toLowerCase() : '';
    if (!email) { counts.unresolved++; unresolvedAccounts.add(rec.account_id); continue; }
    const users = (await clerk.usersByEmail(email)) || [];
    const matches = users.map(githubOfClerkUser).filter((gh) => gh && gh.handle === handle);
    if (matches.length !== 1) { counts.unresolved++; unresolvedAccounts.add(rec.account_id); continue; }
    claims.push({ accountId: rec.account_id, gh: matches[0], source: 'handle', recordKey: key });
  }

  // 2. One GitHub id claimed by two accounts: write neither, report both.
  const byId = new Map();
  for (const c of claims) {
    if (!byId.has(c.gh.id)) byId.set(c.gh.id, []);
    byId.get(c.gh.id).push(c);
  }
  const now = new Date().toISOString();
  const linked = new Map(); // account -> github id this run links it to
  for (const [id, list] of byId) {
    const accounts = [...new Set(list.map((c) => c.accountId))];
    if (accounts.length > 1) {
      counts.conflicts++;
      conflicts.push({ kind: 'github_id_claimed_by_two_accounts', github_id: id, account_ids: accounts.sort() });
      for (const a of accounts) unresolvedAccounts.add(a);
      continue;
    }
    const accountId = accounts[0];
    const existing = parse(await kv.get(`account-idp:github:${id}`));
    if (existing && existing.account_id === accountId) { counts.already_linked++; continue; }
    if (existing && existing.account_id) {
      counts.conflicts++;
      conflicts.push({ kind: 'github_id_linked_elsewhere', github_id: id, account_ids: [accountId, existing.account_id].sort() });
      unresolvedAccounts.add(accountId);
      continue;
    }
    const c = list[0];
    counts.planned++;
    linked.set(accountId, c.gh);
    const info = { account_id: accountId, github_id: id, source: c.source };
    await want(`account-idp:github:${id}`, JSON.stringify({ account_id: accountId, created: now, ...(c.gh.handle ? { handle: c.gh.handle } : {}), backfilled: 'clerk' }), info);
    const rk = list.find((x) => x.recordKey);
    if (rk) {
      const rec = parse(await kv.get(rk.recordKey));
      if (rec && rec.account_id === accountId && !githubSubs(rec).length) {
        const identities = Array.isArray(rec.identities) ? rec.identities.slice() : [];
        identities.push({ provider: 'github', sub: id, ...(c.gh.handle ? { handle: c.gh.handle } : {}), linked_at: now, last_seen: now });
        await want(rk.recordKey, JSON.stringify({ ...rec, identities }), info);
      }
    }
  }

  // 3. The reverse key (account-github:<account>) for every link, old and
  // new. Once all exist, the worker may trust a missing one to mean "no
  // GitHub linked" (REVERSE_INDEX_COMPLETE_KEY, written last).
  const reverse = new Map(); // account -> [github ids]
  for (const key of await kv.list('account-idp:github:')) {
    const rec = parse(await kv.get(key));
    if (!rec || !rec.account_id) continue;
    if (!reverse.has(rec.account_id)) reverse.set(rec.account_id, []);
    reverse.get(rec.account_id).push({ id: key.slice('account-idp:github:'.length), handle: rec.handle || null });
  }
  for (const [accountId, gh] of linked) {
    if (!reverse.has(accountId)) reverse.set(accountId, []);
    reverse.get(accountId).push({ id: gh.id, handle: gh.handle });
  }
  for (const [accountId, ids] of reverse) {
    if (parse(await kv.get(`account-github:${accountId}`))) continue;
    if (ids.length > 1) {
      // Several GitHub ids on one account: record the first, report it.
      conflicts.push({ kind: 'account_has_several_github_ids', account_ids: [accountId] });
    }
    counts.reverse_keys++;
    await want(`account-github:${accountId}`, JSON.stringify({ sub: ids[0].id, ...(ids[0].handle ? { handle: ids[0].handle } : {}), linked_at: now }),
      { account_id: accountId, github_id: ids[0].id, source: 'reverse' });
  }
  // 4. Park what is left: a placeholder reverse key the worker reads as
  // "never attach by email" (githubAttachable). A real link replaces it.
  let newlyParked = 0;
  for (const accountId of unresolvedAccounts) {
    if (reverse.has(accountId) || linked.has(accountId)) continue;
    const cur = parse(await kv.get(`account-github:${accountId}`));
    if (cur && cur.unresolved) { counts.already_parked++; continue; }
    if (cur) continue;
    counts.parked++;
    newlyParked++;
    await want(`account-github:${accountId}`, JSON.stringify({ unresolved: true, parked_at: now }),
      { account_id: accountId, github_id: null, source: 'park' });
  }
  // 5. The completion marker -- withheld while this run still has conflicts
  // or had to park anything new. Re-run after resolving them; accounts parked
  // by an earlier run no longer hold it back.
  if (!conflicts.length && !newlyParked) {
    await want(REVERSE_INDEX_COMPLETE_KEY, now, { account_id: null, github_id: null, source: 'marker' });
  }
  return { counts, conflicts, writes };
}

// Applies a plan. Each key is re-read first and skipped if it no longer holds
// what the plan saw -- somebody signed in meanwhile, and their write wins.
// The completion marker is written only when nothing was skipped.
export async function applyWrites(kv, writes) {
  let written = 0;
  const skipped = [];
  for (const w of writes) {
    if (w.source === 'marker') {
      if (skipped.length) continue;
    } else if ((await kv.get(w.key)) !== w.before) {
      skipped.push(w.key);
      continue;
    }
    await kv.put(w.key, w.value);
    written++;
  }
  return { written, skipped };
}

// Read-only. Finds people split across accounts and documents whose owner is
// not a live, canonical account:
//   - one GitHub numeric id reachable from more than one account
//   - one email address reachable from more than one account
//   - hosted-account:<handle> naming a different account than the GitHub id
//     index for the id that record (or the index) names
//   - docs whose meta.hosted.account_id no index knows, that is a merged
//     (non-canonical) member of an account group, or that sits in one of the
//     duplicate sets above
// Accounts in the same account-group are one person on purpose and are not
// reported as duplicates.
export async function scanAccountDuplicates({ kv }) {
  const known = new Set();
  const canonical = new Map(); // account id -> group canonical
  for (const key of await kv.list('account-group:')) {
    const g = parse(await kv.get(key));
    const id = key.slice('account-group:'.length);
    known.add(id);
    if (g && g.canonical) canonical.set(id, g.canonical);
  }
  const person = (id) => canonical.get(id) || id;
  const byGithub = new Map();
  const byEmail = new Map();
  const add = (map, k, acct) => {
    if (!k || !acct) return;
    known.add(acct);
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(acct);
  };
  const handleMismatch = new Set();

  const idpGithub = new Map();
  for (const key of await kv.list('account-idp:github:')) {
    const rec = parse(await kv.get(key));
    const id = key.slice('account-idp:github:'.length);
    if (!rec || !rec.account_id) continue;
    idpGithub.set(id, rec.account_id);
    add(byGithub, id, rec.account_id);
    if (rec.handle) {
      const named = parse(await kv.get(`hosted-account:${rec.handle}`));
      if (named && named.account_id && person(named.account_id) !== person(rec.account_id)) {
        handleMismatch.add(JSON.stringify([named.account_id, rec.account_id].sort()));
      }
    }
  }
  for (const key of await kv.list('account-idp:oidc:')) {
    const rec = parse(await kv.get(key));
    if (rec && rec.account_id) known.add(rec.account_id);
  }
  for (const key of await kv.list('account-github:')) {
    const rec = parse(await kv.get(key));
    if (rec && rec.sub) add(byGithub, String(rec.sub), key.slice('account-github:'.length));
  }
  for (const key of await kv.list('hosted-account:')) {
    const rec = parse(await kv.get(key));
    if (!rec || !rec.account_id) continue;
    known.add(rec.account_id);
    for (const sub of githubSubs(rec)) {
      add(byGithub, sub, rec.account_id);
      const indexed = idpGithub.get(sub);
      if (indexed && person(indexed) !== person(rec.account_id)) {
        handleMismatch.add(JSON.stringify([indexed, rec.account_id].sort()));
      }
    }
    add(byEmail, typeof rec.email === 'string' ? rec.email.toLowerCase() : null, rec.account_id);
    for (const i of rec.identities || []) add(byEmail, i && typeof i.email === 'string' ? i.email.toLowerCase() : null, rec.account_id);
  }
  for (const key of await kv.list('account-email:')) {
    const rec = parse(await kv.get(key));
    if (rec && rec.account_id) add(byEmail, key.slice('account-email:'.length), rec.account_id);
  }

  const splits = (map) => [...map.values()]
    .map((set) => [...set])
    .filter((ids) => new Set(ids.map(person)).size > 1)
    .map((ids) => ids.sort());
  const githubDupes = splits(byGithub);
  const emailDupes = splits(byEmail);
  const dupAccounts = new Set([...githubDupes, ...emailDupes].flat());

  const docs = { scanned: 0, owner_unknown: 0, owner_merged: 0, owner_in_duplicate_set: 0 };
  const docOwnerIds = { owner_unknown: new Set(), owner_merged: new Set(), owner_in_duplicate_set: new Set() };
  for (const key of await kv.list('meta:')) {
    const meta = parse(await kv.get(key));
    const owner = meta && meta.hosted && meta.hosted.account_id;
    if (!owner) continue;
    docs.scanned++;
    if (!known.has(owner)) { docs.owner_unknown++; docOwnerIds.owner_unknown.add(owner); }
    if (canonical.has(owner) && canonical.get(owner) !== owner) { docs.owner_merged++; docOwnerIds.owner_merged.add(owner); }
    if (dupAccounts.has(owner)) { docs.owner_in_duplicate_set++; docOwnerIds.owner_in_duplicate_set.add(owner); }
  }

  return {
    counts: {
      accounts_known: known.size,
      github_id_split: githubDupes.length,
      email_split: emailDupes.length,
      handle_vs_github_index_mismatch: handleMismatch.size,
      ...Object.fromEntries(Object.entries(docs).map(([k, v]) => [`docs_${k}`, v])),
    },
    github_id_split: githubDupes,
    email_split: emailDupes,
    handle_vs_github_index_mismatch: [...handleMismatch].map((s) => JSON.parse(s)),
    doc_owner_accounts: Object.fromEntries(Object.entries(docOwnerIds).map(([k, v]) => [k, [...v].sort()])),
  };
}

// Cloudflare KV through wrangler, for the CLIs. Read-only unless put is used.
export async function wranglerKv(namespaceId) {
  const { execFileSync } = await import('node:child_process');
  const run = (args) => execFileSync('npx', ['wrangler', 'kv', 'key', ...args, '--namespace-id', namespaceId, '--remote'], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28,
  });
  return {
    async list(prefix) { return JSON.parse(run(['list', '--prefix', prefix]).replace(/^[^[]*/, '')).map((k) => k.name); },
    async get(key) { try { return run(['get', key]); } catch { return null; } },
    async put(key, value) { run(['put', key, value]); },
  };
}
