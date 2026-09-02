// Regression test for "comments vanish and posting 500s from v2 onward".
//
// Root cause: #296 deleted `const AGENT_STATUS_EMOJI` from worker.js but left
// the two references in snapshotAt(). The line only runs when a fold produces
// an agent verdict (a marked_applied / marked_open event at or below the
// requested version), so v1 folded fine and every v>=2 read threw
// `ReferenceError: AGENT_STATUS_EMOJI is not defined` → 500 on GET and POST
// /api/comments. Live docs looked like they had lost their comments.
//
// The existing fold tests missed it because they INJECT AGENT_STATUS_EMOJI into
// the VM sandbox. This one takes the definition from worker.js itself, so a
// deleted constant fails here instead of in production.
//
// Run with: node test/agent-status-emoji.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, err) { console.log(`  ✗ ${name}\n    ${err}`); fail++; }
function t(name, fn) { try { fn(); ok(name); } catch (e) { bad(name, e.message); } }
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const workerSrc = fs.readFileSync(path.join(__dirname, '..', 'worker', 'worker.js'), 'utf8');

function sliceFn(name) {
  const start = workerSrc.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in worker.js`);
  let i = workerSrc.indexOf('{', start);
  let depth = 0;
  for (; i < workerSrc.length; i++) {
    if (workerSrc[i] === '{') depth++;
    else if (workerSrc[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return workerSrc.slice(start, i);
}

// The constant comes from the SOURCE, not from the sandbox — that is the point.
const emojiDecl = /^const AGENT_STATUS_EMOJI = \{.*\};$/m.exec(workerSrc);

t('worker.js defines AGENT_STATUS_EMOJI (snapshotAt references it)', () => {
  assert(emojiDecl, 'AGENT_STATUS_EMOJI is referenced by snapshotAt but never declared in worker.js');
});

const deps = [
  'isFiniteVersion', 'eventEid', 'backfillEids', 'dedupEvents',
  'ensureEventLog', 'legacyToEvents', 'snapshotAt', 'keepThread', 'asTombstone', 'snapshotList',
].map(sliceFn).join('\n\n');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${emojiDecl ? emojiDecl[0] : ''}\n\n${deps}`, sandbox);

// A comment created on v1 and marked applied by the agent on v2 — the exact
// shape that took every v>=2 read down.
function appliedOnV2() {
  return {
    id: 'c_applied',
    author: { login: 'tester' },
    created: '2026-01-01T00:00:00Z',
    created_in: 1,
    events: [
      { kind: 'created', at_version: 1, at: '2026-01-01T00:00:00Z', anchor: { kind: 'text', text: 'x' }, text: 'hi' },
      { kind: 'marked_applied', at_version: 2, at: '2026-01-02T00:00:00Z', applied_in: 2, by: 'tdoc-agent', agent_status: 'applied' },
    ],
  };
}

t('folding at v1 keeps the comment open (verdict event is out of scope)', () => {
  const snap = sandbox.snapshotAt(appliedOnV2(), 1);
  assert(snap, 'v1 snapshot missing');
  assert(snap.status === 'open', `expected open at v1, got ${snap.status}`);
});

t('folding at v2 renders the ✅ verdict instead of throwing', () => {
  const snap = sandbox.snapshotAt(appliedOnV2(), 2);
  assert(snap, 'v2 snapshot missing');
  assert(snap.status === 'applied', `expected applied at v2, got ${snap.status}`);
  assert(Array.isArray(snap.reactions['✅']), 'agent verdict emoji not synthesized at v2');
  assert(snap.reactions['✅'].includes('tdoc-agent'), 'verdict emoji not attributed to the agent');
});

t('the whole list still folds at the latest version (GET /api/comments path)', () => {
  const list = sandbox.snapshotList([appliedOnV2()], Infinity);
  assert(list.length === 1, `expected 1 comment, got ${list.length}`);
  assert(list[0].reactions['✅'], 'latest fold lost the verdict emoji');
});

t('partial and question verdicts fold too', () => {
  for (const [status, emoji] of [['partial', '🟡'], ['question', '❓']]) {
    const c = appliedOnV2();
    c.events[1].agent_status = status;
    const snap = sandbox.snapshotAt(c, 2);
    assert(snap.reactions[emoji], `${status} verdict did not render ${emoji}`);
  }
});


// ─────────────────────────────────────────────────────────────────────────
// End-to-end guard: the REAL /api/comments route, real worker module, fake
// bindings. The fold tests above pin one constant; this pins the whole route,
// so ANY runtime ReferenceError on a v>=2 read or write fails here instead of
// serving a 500 to readers.

const os = require('os');
const { webcrypto } = require('crypto');
if (typeof globalThis.crypto === 'undefined') globalThis.crypto = webcrypto;
if (typeof Response !== 'undefined' && !Response.json) {
  Response.json = (body, init = {}) => new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

async function ta(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e && e.message ? e.message : e); } }

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, String(v)); }
  async delete(k) { this.map.delete(k); }
  async list({ prefix = '' } = {}) {
    return { keys: [...this.map.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true };
  }
}
class FakeR2 {
  constructor() { this.map = new Map(); }
  async put(k, v) { this.map.set(k, String(v)); }
  async get(k) { return this.map.has(k) ? { text: async () => this.map.get(k) } : null; }
  async head(k) { return this.map.has(k) ? { size: Buffer.byteLength(this.map.get(k)) } : null; }
  async delete(k) { this.map.delete(k); }
  async list({ prefix = '' } = {}) {
    return { objects: [...this.map.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false };
  }
}
class FakeStorage {
  constructor() { this.map = new Map(); }
  async transaction(fn) {
    return fn({
      get: async (k) => this.map.get(k),
      put: async (k, v) => { this.map.set(k, v); },
      delete: async (k) => { this.map.delete(k); },
    });
  }
}
class FakeDurableNamespace {
  constructor(env, StoreClass) { this.env = env; this.StoreClass = StoreClass; this.states = new Map(); }
  idFromName(name) { return name; }
  stateFor(id) {
    if (!this.states.has(id)) this.states.set(id, { storage: new FakeStorage() });
    return this.states.get(id);
  }
  get(id) {
    return { fetch: async (url, init = {}) => new this.StoreClass(this.stateFor(id), this.env).fetch(new Request(url, init)) };
  }
}

// Load worker.js as a module with the shell placeholders inlined, exactly like
// bin/tdoc-bundle does.
async function loadWorker() {
  const root = path.join(__dirname, '..');
  let src = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
  const readerCss = fs.readFileSync(path.join(root, 'server', 'reader.css'), 'utf8');
  src = src.replace(/const READER_CSS = `__TDOC_READER_CSS__`;/, 'const READER_CSS = ' + JSON.stringify(readerCss) + ';');
  src = src.replace('/* __TDOC_SHELL_MODULE__ */', fs.readFileSync(path.join(root, 'server', 'shell.js'), 'utf8'));
  src = src.replace(
    /const PROBE_JS = `__TDOC_PROBE_JS__`;/,
    'const PROBE_JS = ' + JSON.stringify(require(path.join(root, 'server', 'frame-probe-source.js'))()) + ';'
  );
  const tmp = path.join(os.tmpdir(), `tdoc-worker-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(tmp, src);
  const mod = await import(`file://${tmp}`);
  try { fs.unlinkSync(tmp); } catch {}
  return mod;
}

function makeEnv(StoreClass) {
  const env = { META: new FakeKV(), DOCS: new FakeR2() };
  env.COMMENTS = new FakeDurableNamespace(env, StoreClass);
  return env;
}

function req(pathname, { method = 'GET', body = null, cookie = '' } = {}) {
  return new Request(`https://tdoc.dev${pathname}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function putSession(env, login) {
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
  await env.META.put(`session:${id}`, JSON.stringify({
    login, name: login, avatar_url: '', created: new Date().toISOString(),
  }));
  return `tdoc_sid=${id}`;
}

const SLUG = 'verdict-doc';

// A doc at v2 whose one comment was answered by the agent on v2 — the exact
// production shape (avgraph-orchestration-theory) that returned 500 for every
// read and every new comment. Comments are seeded through the legacy KV key
// the DO migrates from on first touch.
async function seedDocWithAppliedComment(env) {
  await env.META.put(`meta:${SLUG}`, JSON.stringify({
    title: SLUG, slug: SLUG, created: '2026-01-01T00:00:00Z',
    versions: [{ n: 1, created: '2026-01-01T00:00:00Z' }, { n: 2, created: '2026-01-02T00:00:00Z' }],
  }));
  for (const n of [1, 2]) await env.DOCS.put(`docs/${SLUG}/v${n}/index.html`, `<h1>${SLUG}</h1>`);
  await env.META.put(`comments:${SLUG}`, JSON.stringify([{
    id: 'c_applied',
    author: { login: 'reader' },
    created: '2026-01-01T00:00:00Z',
    created_in: 1,
    events: [
      { kind: 'created', at_version: 1, at: '2026-01-01T00:00:00Z', anchor: { kind: 'text', text: 'x' }, text: 'hi' },
      { kind: 'marked_applied', at_version: 2, at: '2026-01-02T00:00:00Z', applied_in: 2, by: 'tdoc-agent', agent_status: 'applied' },
    ],
  }]));
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;

  await ta('GET /api/comments at v1 serves the comment', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDocWithAppliedComment(env);
    const r = await worker.fetch(req(`/api/comments?slug=${SLUG}&version=1`), env, {});
    assert(r.status === 200, `expected 200, got ${r.status}`);
    const list = await r.json();
    assert(list.length === 1, `expected 1 comment, got ${list.length}`);
  });

  await ta('GET /api/comments at v2 serves the comment instead of 500', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDocWithAppliedComment(env);
    const r = await worker.fetch(req(`/api/comments?slug=${SLUG}&version=2`), env, {});
    assert(r.status === 200, `expected 200, got ${r.status} — a v>=2 read is throwing again`);
    const list = await r.json();
    assert(list.length === 1, `v2 lost the comment (got ${list.length})`);
    assert(list[0].status === 'applied', `expected applied at v2, got ${list[0].status}`);
    assert(list[0].reactions['✅'], 'agent verdict emoji missing at v2');
  });

  await ta('GET /api/comments?version=all serves the full history', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDocWithAppliedComment(env);
    const r = await worker.fetch(req(`/api/comments?slug=${SLUG}&version=all`), env, {});
    assert(r.status === 200, `expected 200, got ${r.status} — tdoc-pull would lose comments`);
    assert((await r.json()).length === 1, 'history view lost the comment');
  });

  await ta('POST /api/comments on v2 still accepts a new comment', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDocWithAppliedComment(env);
    const cookie = await putSession(env, 'reader');
    const r = await worker.fetch(req('/api/comments', {
      method: 'POST', cookie,
      body: { slug: SLUG, version: 2, text: 'new one', anchor: { kind: 'text', text: 'x' } },
    }), env, {});
    assert(r.status === 200, `expected 200, got ${r.status} — posting on v>=2 is throwing again`);
    const back = await worker.fetch(req(`/api/comments?slug=${SLUG}&version=2`), env, {});
    assert(back.status === 200, `read-back ${back.status}`);
    assert((await back.json()).length === 2, 'the new comment did not come back');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
