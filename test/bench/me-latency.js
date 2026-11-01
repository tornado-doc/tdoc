#!/usr/bin/env node
// Wall-clock cost of opening My docs (/me), with every storage call paying a
// network round trip the way it does on Cloudflare.
//
// worker-bench.js measures CPU (the 10ms limit). What a person waits for when
// they click "My docs" is mostly something else: KV, R2 and Durable Object
// calls made one after another. In-process fakes answer in microseconds, so
// a chain of twenty awaited round trips looks free there and takes seconds
// on tdoc.dev. This harness delays every call by a fixed, configurable
// latency and reports the wall time of /me and how many round trips the
// slowest path had to wait for in series.
//
// Not part of `node test/run.js`. Read the ratio between runs, not the
// absolute milliseconds: the latencies are a model.
//
//   node test/bench/me-latency.js
//   node test/bench/me-latency.js --docs 5000 --mine 120 --get 30 --list 80 --put 150 --do 150
//   TDOC_WORKER_JS=/path/to/main/worker/worker.js node test/bench/me-latency.js   # compare

const { FakeKV, FakeR2, loadWorker, makeEnv, req, issue } = require('../helpers/worker-harness.js');

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const N = Number(argOf('--docs', 5000));
const MINE = Number(argOf('--mine', 120));
const LAT = {
  get: Number(argOf('--get', 30)),
  list: Number(argOf('--list', 80)),
  put: Number(argOf('--put', 150)),
  do: Number(argOf('--do', 150)),
  r2: Number(argOf('--r2', 50)),
};
const DAILY_CAP = argOf('--cap', null);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every call waits its latency. `depth` follows the longest chain of calls
// that each started only after the previous one finished, which is the
// number of round trips the page waited for.
class Tracer {
  constructor() { this.reset(); this.on = false; }
  reset() { this.ops = {}; this.inflight = 0; this.chain = 0; this.depth = 0; this.lastEnd = 0; }
  async call(kind, ms, fn) {
    if (!this.on) return fn();
    this.ops[kind] = (this.ops[kind] || 0) + 1;
    // A call that starts after every earlier call has finished extends the
    // serial chain; one that overlaps another rides along with it.
    if (this.inflight === 0) this.chain += 1;
    this.depth = Math.max(this.depth, this.chain);
    this.inflight += 1;
    try {
      await sleep(ms);
      return await fn();
    } finally {
      this.inflight -= 1;
    }
  }
}
const tracer = new Tracer();

class SlowKV extends FakeKV {
  get(k) { return tracer.call('kv.get', LAT.get, () => super.get(k)); }
  getWithMetadata(k) { return tracer.call('kv.get', LAT.get, () => super.getWithMetadata(k)); }
  put(k, v, o) { return tracer.call('kv.put', LAT.put, () => super.put(k, v, o)); }
  delete(k) { return tracer.call('kv.delete', LAT.put, () => super.delete(k)); }
  // Workers KV pages list() at 1,000 keys.
  list({ prefix = '', cursor, limit = 1000 } = {}) {
    return tracer.call('kv.list', LAT.list, () => {
      if (!this._sorted || this._sortedSize !== this.map.size) { this._sorted = [...this.map.keys()].sort(); this._sortedSize = this.map.size; }
      const all = this._sorted;
      let start = cursor ? Number(cursor) : 0;
      if (!cursor) {
        let lo = 0, hi = all.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (all[mid] < prefix) lo = mid + 1; else hi = mid; }
        start = lo;
      }
      const keys = [];
      let i = start;
      for (; i < all.length && keys.length < limit; i++) {
        const name = all[i];
        if (!name.startsWith(prefix)) break;
        if (!this.map.has(name)) continue;
        keys.push(this.metadata.has(name) ? { name, metadata: this.metadata.get(name) } : { name });
      }
      const more = i < all.length && all[i].startsWith(prefix);
      return { keys, list_complete: !more, cursor: more ? String(i) : undefined };
    });
  }
}
class SlowR2 extends FakeR2 {
  get(k, o) { return tracer.call('r2.get', LAT.r2, () => super.get(k, o)); }
  put(k, v) { return tracer.call('r2.put', LAT.r2, () => super.put(k, v)); }
}

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

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, DAILY_CAP != null ? { TDOC_INDEX_BACKFILL_DAILY: DAILY_CAP } : {});
  env.META = new SlowKV();
  env.DOCS = new SlowR2();
  env.COMMENTS = makeEnv(mod.CommentsStore, { META: env.META, DOCS: env.DOCS }).COMMENTS;
  // Durable Object calls pay a round trip too (one location for the platform).
  const ns = env.COMMENTS;
  const get = ns.get.bind(ns);
  ns.get = (id) => {
    const stub = get(id);
    return { fetch: (u, i) => tracer.call('do', LAT.do, () => stub.fetch(u, i)) };
  };

  const me = await issue(worker, env, 'me');
  const team = (await worker.fetch(req('/api/teams', { method: 'POST', token: me.token, body: { name: 'Bench team' } }), env, {}).then((r) => r.json())).team;
  const created = '2026-03-01T00:00:00.000Z';
  const access = { visibility: 'public', commenting: 'signed_in', history_visibility: 'public', allowed_users: [] };
  const putDoc = async (slug, meta) => env.META.put(`meta:${slug}`, JSON.stringify(meta), { metadata: metaIndex(meta) });
  for (let i = 0; i < N; i++) {
    const slug = `doc-${String(i).padStart(6, '0')}`;
    await putDoc(slug, { title: `Doc ${i}`, slug, created, versions: [{ n: 1, created }], access, hosted: { account_id: `acct-${i % 200}`, github_login: `user${i % 200}`, owner_key: `user${i % 200}` } });
  }
  for (let i = 0; i < MINE; i++) {
    const slug = `mine-${i}`;
    await putDoc(slug, { title: `Mine ${i}`, slug, created, versions: [{ n: 1, created }], access, hosted: { account_id: me.account_id, github_login: 'me', owner_key: 'me' } });
  }
  for (let i = 0; i < 10; i++) {
    const slug = `team-${i}`;
    await putDoc(slug, { title: `Team ${i}`, slug, created, versions: [{ n: 1, created }], access: { ...access, team: true }, workspace_id: team.id, hosted: { account_id: me.account_id, github_login: 'me', owner_key: 'me' } });
  }
  // The docidx markers publish wrote for these are what an existing platform
  // does NOT have: drop them so /me starts the way the first load after the
  // index shipped did.
  for (const k of [...env.META.map.keys()]) if (k.startsWith('docidx:')) { env.META.map.delete(k); env.META.metadata.delete(k); }

  console.log(`platform ${N} docs, viewer owns ${MINE} + 10 team docs; latency get ${LAT.get} list ${LAT.list} put ${LAT.put} DO ${LAT.do} R2 ${LAT.r2} ms`);
  console.log('| load | status | wall ms | serial round trips | ops |');
  console.log('|---|---|---|---|---|');
  const waits = [];
  const ctx = { waitUntil: (p) => { waits.push(Promise.resolve(p).catch(() => {})); } };
  for (let i = 1; i <= 8; i++) {
    tracer.reset();
    tracer.on = true;
    const t0 = Date.now();
    const r = await worker.fetch(req('/me', { cookie: me.cookie }), env, ctx);
    await r.text();
    const wall = Date.now() - t0;
    const depth = tracer.depth;
    const ops = Object.entries(tracer.ops).map(([k, v]) => `${k} ${v}`).join(', ');
    console.log(`| /me #${i} | ${r.status} | ${wall} | ${depth} | ${ops} |`);
    // Background work (waitUntil) finishes before the next click.
    await Promise.all(waits.splice(0));
    tracer.on = false;
  }
  const built = [...env.META.map.keys()].filter((k) => k.startsWith('docidx:built:'));
  console.log(`\nbuilt facets: ${built.length ? built.join(', ') : 'none'}`);
})().catch((e) => { console.error(e); process.exit(1); });
