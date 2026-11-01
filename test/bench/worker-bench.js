#!/usr/bin/env node
// Per-route CPU cost of the Worker against a platform of N synthetic docs.
//
// Cloudflare's free plan allows 10ms of CPU per request (error 1102 past it)
// and 1,000 KV writes a day. This harness boots worker.js in-process on a
// fake KV / R2 and measures, for each route, CPU time per request and how
// many KV / R2 operations it makes -- at several platform sizes, so a route
// whose cost grows with the WHOLE platform (not the requester's own data)
// shows up as a slope rather than a constant.
//
// Not part of `node test/run.js`: it takes a while at 20k docs and prints a
// table rather than pass/fail.
//
//   node test/bench/worker-bench.js                 # 500, 5000, 20000 docs
//   node test/bench/worker-bench.js --docs 500,5000 --iters 5
//
// The fake KV pages list() at 1,000 keys like Workers KV does, so the list
// subrequest count is realistic; CPU numbers are Node's, so read the slope
// and the ratio between routes, not the absolute milliseconds.

const path = require('path');
const { FakeKV, FakeR2, loadWorker, makeEnv, req, issue } = require('../helpers/worker-harness.js');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const SIZES = String(argOf('--docs', '500,5000,20000')).split(',').map(Number).filter((n) => n > 0);
const ITERS = Number(argOf('--iters', 5)) || 5;

class BenchKV extends FakeKV {
  constructor() { super(); this.ops = { get: 0, put: 0, delete: 0, list: 0 }; }
  async get(k) { this.ops.get++; return this.map.has(k) ? this.map.get(k) : null; }
  async getWithMetadata(k) {
    this.ops.get++;
    return { value: this.map.has(k) ? this.map.get(k) : null, metadata: this.metadata.get(k) || null };
  }
  // The sorted key list is kept incrementally (a binary insert per new key)
  // so a put between two list calls does not charge the next list for a
  // re-sort of the whole platform -- real KV charges nothing of the kind.
  _lower(k) {
    const all = this._sorted;
    let lo = 0, hi = all.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid] < k) lo = mid + 1; else hi = mid; }
    return lo;
  }
  async put(k, v, opts) {
    this.ops.put++;
    const fresh = !this.map.has(k);
    const r = await super.put(k, v, opts);
    if (fresh && this._sorted) { const i = this._lower(k); if (this._sorted[i] !== k) this._sorted.splice(i, 0, k); }
    return r;
  }
  async delete(k) {
    this.ops.delete++;
    if (this._sorted && this.map.has(k)) { const i = this._lower(k); if (this._sorted[i] === k) this._sorted.splice(i, 1); }
    return super.delete(k);
  }
  // Workers KV: at most 1,000 keys per list call, lexicographic, cursor paged.
  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    this.ops.list++;
    if (!this._sorted) this._sorted = [...this.map.keys()].sort();
    const all = this._sorted;
    let start = cursor ? Number(cursor) : 0;
    if (!cursor) {
      // binary search the first key >= prefix
      let lo = 0, hi = all.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid] < prefix) lo = mid + 1; else hi = mid; }
      start = lo;
    }
    const keys = [];
    let i = start;
    for (; i < all.length && keys.length < limit; i++) {
      const name = all[i];
      if (!name.startsWith(prefix)) break;
      keys.push(this.metadata.has(name) ? { name, metadata: this.metadata.get(name) } : { name });
    }
    const more = i < all.length && all[i].startsWith(prefix);
    return { keys, list_complete: !more, cursor: more ? String(i) : undefined };
  }
  resetOps() { this.ops = { get: 0, put: 0, delete: 0, list: 0 }; }
}

class BenchR2 extends FakeR2 {
  constructor() { super(); this.ops = { get: 0, put: 0, list: 0, bytes: 0 }; }
  async get(k, opts) {
    this.ops.get++;
    if (!this.map.has(k)) return null;
    let v = this.map.get(k);
    const range = opts && opts.range;
    if (range && typeof range.length === 'number') v = v.slice(range.offset || 0, (range.offset || 0) + range.length);
    this.ops.bytes += v.length;
    return { text: async () => v, size: this.map.get(k).length };
  }
  async list(o) { this.ops.list++; return super.list(o); }
  resetOps() { this.ops = { get: 0, put: 0, list: 0, bytes: 0 }; }
}

// An in-memory Cache API, so a Worker that caches baked output can be measured.
function fakeCaches() {
  const store = new Map();
  return {
    default: {
      async match(r) { const k = typeof r === 'string' ? r : r.url; const hit = store.get(k); return hit ? hit.clone() : undefined; },
      async put(r, res) { const k = typeof r === 'string' ? r : r.url; store.set(k, res.clone()); },
      async delete(r) { const k = typeof r === 'string' ? r : r.url; return store.delete(k); },
    },
    size: () => store.size,
  };
}

// Mirrors worker.js docMetaIndex, so seeded keys look like ones the Worker wrote.
function metaIndex(m) {
  const versions = m.versions || [];
  const hosted = m.hosted || {};
  return {
    v: 1,
    a: String(hosted.account_id || ''),
    o: String((hosted.github_login || '').toLowerCase()),
    k: String(hosted.owner_key || ''),
    w: String(m.workspace_id || ''),
    tf: String(m.workspace_id && m.team_folder || ''),
    f: m.created_from === 'feedback' ? 1 : 0,
    l: Number(versions[versions.length - 1]?.n) || 1,
    c: String(m.created || ''),
    u: String(versions[versions.length - 1]?.created || m.created || ''),
    t: String(m.title || '').slice(0, 300),
  };
}

function bigDocHtml({ tables = 40, rows = 30, iframes = 15, videos = 6, paras = 1200 } = {}) {
  const parts = ['<!doctype html><html><head><meta charset="utf-8"><title>Quarterly report</title></head><body><h1>Quarterly report</h1><p>Lead paragraph of the report, the one the share card quotes.</p>'];
  for (let t = 0; t < tables; t++) {
    parts.push(`<h2>Table ${t}</h2><table><thead><tr><th>Region</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th></tr></thead><tbody>`);
    for (let r = 0; r < rows; r++) parts.push(`<tr><td>Region ${r}</td><td>${r * 3}</td><td>${r * 5}</td><td>${r * 7}</td><td>${r * 11}</td></tr>`);
    parts.push('</tbody></table>');
    for (let p = 0; p < paras / tables; p++) parts.push(`<p>Paragraph ${t}.${p}: ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(8)}</p>`);
    if (t < iframes) parts.push(`<iframe src="/d/big-report/v/1/widget/w${t}" sandbox="allow-scripts allow-same-origin" width="600" height="320"></iframe>`);
    if (t < videos) parts.push(`<video src="https://cdn.example.com/clips/${t}.mp4" poster="https://cdn.example.com/p/${t}.jpg" preload="none" controls></video>`);
    parts.push(`<img src="https://cdn.example.com/i/${t}.png" alt="chart ${t}">`);
  }
  parts.push('</body></html>');
  return parts.join('\n');
}

function cpuMs(fn) {
  return async () => {
    const t0 = process.cpuUsage();
    await fn();
    const d = process.cpuUsage(t0);
    return (d.user + d.system) / 1000;
  };
}

async function seed(env, worker, N) {
  const kv = env.META;
  const r2 = env.DOCS;
  const created = '2026-03-01T00:00:00.000Z';
  const me = await issue(worker, env, 'me');
  const mate = await issue(worker, env, 'mate');
  const team = (await worker.fetch(req('/api/teams', { method: 'POST', token: me.token, body: { name: 'Bench team' } }), env, {}).then((r) => r.json())).team;
  const detail = await worker.fetch(req(`/api/team?id=${team.id}`, { cookie: me.cookie }), env, {}).then((r) => r.json());
  const inviteToken = detail.team && detail.team.invite_token;
  if (inviteToken) await worker.fetch(req('/api/team/join', { method: 'POST', cookie: mate.cookie, body: { token: inviteToken } }), env, {});

  const accounts = Math.max(10, Math.floor(N / 40));
  const putDoc = async (slug, meta, html) => {
    await kv.put(`meta:${slug}`, JSON.stringify(meta), { metadata: metaIndex(meta) });
    await r2.put(`docs/${slug}/v1/index.html`, html || `<!doctype html><html><head><title>${slug}</title></head><body><h1>${slug}</h1><p>Body of ${slug}.</p></body></html>`);
  };
  const hostedFor = (i) => ({ account_id: `acct-${i}`, github_login: `user${i}`, owner_key: `user${i}` });
  const access = { visibility: 'public', commenting: 'signed_in', history_visibility: 'public', allowed_users: [] };
  // Everyone else's docs: the platform. ~2% written before the index existed.
  let n = 0;
  for (let i = 0; n < N; i++) {
    const owner = i % accounts;
    const slug = `doc-${String(i).padStart(6, '0')}`;
    const meta = { title: `Doc ${i}`, slug, created, versions: [{ n: 1, created }], access, hosted: hostedFor(owner) };
    if (i % 50 === 0) {
      await kv.put(`meta:${slug}`, JSON.stringify(meta));
      await r2.put(`docs/${slug}/v1/index.html`, '<p>legacy</p>');
    } else await putDoc(slug, meta);
    n++;
  }
  // Feedback spaces, one per 100 docs, owned by others.
  for (let i = 0; i < Math.max(2, N / 100); i++) {
    const slug = `fb-space-${i}`;
    await putDoc(slug, { title: `Feedback ${i}`, slug, created, versions: [{ n: 1, created }], access, hosted: hostedFor(i % accounts), created_from: 'feedback', feedback: { origin: `https://app${i}.example.com` } });
  }
  // The viewer's own docs (25), and 10 team docs by the viewer, 5 by a mate.
  const mine = [];
  for (let i = 0; i < 25; i++) {
    const slug = `mine-${i}`;
    mine.push(slug);
    await putDoc(slug, { title: `Mine ${i}`, slug, created, versions: [{ n: 1, created }], access, hosted: { account_id: me.account_id, github_login: 'me', owner_key: 'me' } });
  }
  for (let i = 0; i < 15; i++) {
    const slug = `team-${i}`;
    const who = i < 10 ? me : mate;
    await putDoc(slug, { title: `Team ${i}`, slug, created, versions: [{ n: 1, created }], access: { ...access, team: true }, workspace_id: team.id, hosted: { account_id: who.account_id, github_login: who.login, owner_key: who.login } });
  }
  // Teams on the platform (one per 100 docs), each with two invites; one invites the viewer.
  const teams = Math.max(3, Math.floor(N / 100));
  for (let i = 0; i < teams; i++) {
    const id = `t${String(i).padStart(5, '0')}`;
    const invites = i === 1 ? ['me', `inv${i}b`] : [`inv${i}a`, `inv${i}b`];
    const t = { id, name: `Team ${i}`, members: [{ account_id: `acct-${i % accounts}`, name: `user${i}`, role: 'admin' }], invites, created, invite_token: `tok${i}` };
    await kv.put(`team:${id}`, JSON.stringify(t), { metadata: { v: 1, n: t.name, i: invites } });
  }
  // A big doc with many tables and embeds, and a small one, owned by the viewer.
  const big = bigDocHtml();
  await putDoc('big-report', { title: 'Big report', slug: 'big-report', created, versions: [{ n: 1, created }], access, hosted: { account_id: me.account_id, github_login: 'me', owner_key: 'me' } }, big);
  await putDoc('small-doc', { title: 'Small doc', slug: 'small-doc', created, versions: [{ n: 1, created }], access, hosted: { account_id: me.account_id, github_login: 'me', owner_key: 'me' } });
  // The big doc carries the hash a real publish records (so /frame can be
  // cached per version), a widget, and a few hundred comments with replies
  // -- what the reader page folds on open.
  const bigMeta = JSON.parse(await kv.get('meta:big-report'));
  bigMeta.versions[0].sha = 'abcdef0123456789';
  await kv.put('meta:big-report', JSON.stringify(bigMeta), { metadata: metaIndex(bigMeta) });
  await r2.put('docs/big-report/v1/widgets/w0.html', '<!doctype html><html><body><script>document.body.textContent = "widget";</script></body></html>');
  const comments = Number(argOf('--comments', 300)) || 0;
  for (let i = 0; i < comments; i++) {
    const c = await worker.fetch(req('/api/comments', { method: 'POST', cookie: (i % 3 ? me : mate).cookie, body: { slug: 'big-report', version: 1, text: `Comment ${i}: please tighten this paragraph.`, anchor: { kind: 'text', text: `Paragraph ${i % 40}.${i % 7}` } } }), env, {}).then((r) => r.json());
    if (c && c.id && i % 2 === 0) {
      await worker.fetch(req('/api/comments', { method: 'POST', cookie: mate.cookie, body: { slug: 'big-report', version: 1, text: `Reply ${i}`, parent_id: c.id } }), env, {});
    }
  }
  // A shared team folder with the viewer's team docs filed in it.
  const folder = (await worker.fetch(req('/api/folders', { method: 'POST', token: me.token, body: { name: 'Reports', team: team.id } }), env, {}).then((r) => r.json())).folder;
  let shareId = null;
  if (folder) {
    await worker.fetch(req('/api/folders/move', { method: 'POST', token: me.token, body: { slugs: ['team-0', 'team-1', 'team-2'], folder: folder.id, team: team.id } }), env, {});
    const shared = await worker.fetch(req('/api/folders', { method: 'PATCH', token: me.token, body: { id: folder.id, team: team.id, visibility: 'public' } }), env, {}).then((r) => r.json());
    shareId = shared.folder && shared.folder.share_id;
  }
  return { me, mate, team, shareId, bigBytes: big.length, mine };
}

async function measure(env, worker, label, make, iters, opts = {}) {
  const times = [];
  let ops = null;
  let status = 0;
  for (let i = 0; i < iters; i++) {
    env.META.resetOps(); env.DOCS.resetOps();
    const ms = await cpuMs(async () => {
      const r = await worker.fetch(make(i), env, { waitUntil: () => {} });
      status = r.status;
      if (opts.drain !== false) await r.text();
    })();
    times.push(ms);
    ops = { kv: { ...env.META.ops }, r2: { ...env.DOCS.ops } };
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)];
  return { label, status, min: times[0], med, kv: ops.kv, r2: ops.r2 };
}

function row(r) {
  const kvs = `get ${r.kv.get} / list ${r.kv.list} / put ${r.kv.put}`;
  return `| ${r.label} | ${r.status} | ${r.min.toFixed(2)} | ${r.med.toFixed(2)} | ${kvs} | ${r.r2.get} / ${(r.r2.bytes / 1024).toFixed(0)}KB |`;
}

(async () => {
  if (typeof globalThis.caches === 'undefined') globalThis.caches = fakeCaches();
  const mod = await loadWorker();
  const worker = mod.default;
  const results = {};
  for (const N of SIZES) {
    const env = makeEnv(mod.CommentsStore);
    env.META = new BenchKV();
    env.DOCS = new BenchR2();
    env.COMMENTS = makeEnv(mod.CommentsStore, { META: env.META, DOCS: env.DOCS }).COMMENTS;
    const t0 = Date.now();
    const s = await seed(env, worker, N);
    const seedMs = Date.now() - t0;
    const docKeys = [...env.META.map.keys()].filter((k) => k.startsWith('meta:')).length;
    console.log(`\n### platform: ${docKeys} docs (seeded in ${seedMs}ms; big doc ${(s.bigBytes / 1024).toFixed(0)}KB)\n`);
    console.log('| route | status | cpu min ms | cpu median ms | KV ops/request | R2 gets / bytes |');
    console.log('|---|---|---|---|---|---|');
    const out = [];
    const push = async (r) => { out.push(r); console.log(row(r)); };
    // First /api/me after deploy (cold: builds any per-viewer index), then steady state.
    await push(await measure(env, worker, '/api/me (first load)', () => req('/api/me', { cookie: s.me.cookie }), 1));
    for (let i = 0; i < 12; i++) await worker.fetch(req('/api/me', { cookie: s.me.cookie }), env, { waitUntil: () => {} });
    await push(await measure(env, worker, '/api/me (steady)', () => req('/api/me', { cookie: s.me.cookie }), ITERS));
    await push(await measure(env, worker, '/api/me/feedback', () => req('/api/me/feedback', { cookie: s.me.cookie }), ITERS));
    await push(await measure(env, worker, '/d/small-doc (shell page)', () => req('/d/small-doc', { cookie: s.me.cookie }), ITERS));
    await push(await measure(env, worker, '/d/big-report (shell page)', () => req('/d/big-report', { cookie: s.me.cookie }), ITERS));
    await push(await measure(env, worker, '/d/big-report (shell, anon)', () => req('/d/big-report'), ITERS));
    await push(await measure(env, worker, '/d/big-report (shell, owner, 300 comments)', () => req('/d/big-report', { cookie: s.me.cookie }), ITERS));
    await push(await measure(env, worker, '/api/comments?slug=big-report', () => req('/api/comments?slug=big-report&version=1', { cookie: s.me.cookie }), ITERS));
    await push(await measure(env, worker, '/api/notify/targets?slug=big-report', () => req('/api/notify/targets?slug=big-report', { cookie: s.me.cookie }), ITERS));
    await push(await measure(env, worker, '/api/notify/handoffs?slug=big-report', () => req('/api/notify/handoffs?slug=big-report', { cookie: s.me.cookie }), ITERS));
    await push(await measure(env, worker, '/api/doc/agent-status?slug=big-report', () => req('/api/doc/agent-status?slug=big-report', { cookie: s.me.cookie }), ITERS));
    await push(await measure(env, worker, '/api/mentions?slug=big-report', () => req('/api/mentions?slug=big-report', { cookie: s.me.cookie }), ITERS));
    await push(await measure(env, worker, '/d/big-report/v/1/widget/w0', () => req('/d/big-report/v/1/widget/w0', { dest: 'iframe' }), ITERS));
    await push(await measure(env, worker, '/d/big-report/v/1/raw', () => req('/d/big-report/v/1/raw', { cookie: s.me.cookie }), ITERS));
    await push(await measure(env, worker, '/d/big-report/v/1/export', () => req('/d/big-report/v/1/export', { cookie: s.me.cookie }), ITERS));
    await push(await measure(env, worker, '/d/small-doc/v/1/frame', () => req('/d/small-doc/v/1/frame', { dest: 'iframe' }), ITERS));
    await push(await measure(env, worker, '/d/big-report/v/1/frame (first)', () => req('/d/big-report/v/1/frame', { dest: 'iframe' }), 1));
    await push(await measure(env, worker, '/d/big-report/v/1/frame (repeat)', () => req('/d/big-report/v/1/frame', { dest: 'iframe' }), ITERS));
    await push(await measure(env, worker, 'POST /api/upload (new doc: quota count)', (i) => req('/api/upload', { method: 'POST', token: s.me.token, body: { slug: `bench-new-${N}-${i}`, version: 1, html: '<p>new</p>' } }), ITERS));
    if (s.shareId) await push(await measure(env, worker, '/api/folders/shared (team folder)', () => req(`/api/folders/shared?id=${encodeURIComponent(s.shareId)}`, { cookie: s.me.cookie }), ITERS));
    await push(await measure(env, worker, '/api/teams (list mine)', () => req('/api/teams', { cookie: s.me.cookie }), ITERS));
    results[N] = out;
    const marker = [...env.META.map.keys()].filter((k) => k.startsWith('docidx:') || k.startsWith('tinv:')).length;
    if (marker) console.log(`\n(index keys written so far: ${marker}; cache entries: ${globalThis.caches.size ? globalThis.caches.size() : '?'})`);
  }
  if (args.includes('--json')) console.log(JSON.stringify(results, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
