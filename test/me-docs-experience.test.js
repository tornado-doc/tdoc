// /me docs-experience behavior: time sorting, recents (visited docs — owned
// or not), starred docs, and personal folders. Runs worker.js in-process with
// fake KV/R2/DO bindings (same harness shape as hosted-oob-behavior.test.js).
//
// The per-user state lives in stars:<login> / recents:<login> /
// folders:<login> KV values; nothing here may touch another user's state or
// leak access data into the catalog HTML.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { webcrypto } = require('crypto');

if (typeof globalThis.crypto === 'undefined') globalThis.crypto = webcrypto;

if (typeof Response !== 'undefined' && !Response.json) {
  Response.json = (body, init = {}) => new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, String(v)); }
  async delete(k) { this.map.delete(k); }
  async list({ prefix = '' } = {}) {
    return {
      keys: [...this.map.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })),
      list_complete: true,
    };
  }
}

class FakeR2 {
  constructor() { this.map = new Map(); }
  async put(k, v) { this.map.set(k, String(v)); }
  async get(k) {
    if (!this.map.has(k)) return null;
    const v = this.map.get(k);
    return { text: async () => v };
  }
  async head(k) {
    if (!this.map.has(k)) return null;
    return { size: Buffer.byteLength(this.map.get(k)) };
  }
  async delete(k) { this.map.delete(k); }
  async list({ prefix = '' } = {}) {
    return {
      objects: [...this.map.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })),
      truncated: false,
    };
  }
}

class FakeStorage {
  constructor() { this.map = new Map(); }
  async transaction(fn) {
    const txn = {
      get: async (k) => this.map.get(k),
      put: async (k, v) => { this.map.set(k, v); },
      delete: async (k) => { this.map.delete(k); },
    };
    return fn(txn);
  }
}

class FakeDurableNamespace {
  constructor(env, StoreClass) {
    this.env = env;
    this.StoreClass = StoreClass;
    this.states = new Map();
  }
  idFromName(name) { return name; }
  stateFor(id) {
    if (!this.states.has(id)) this.states.set(id, { storage: new FakeStorage() });
    return this.states.get(id);
  }
  get(id) {
    return {
      fetch: async (url, init = {}) => {
        const store = new this.StoreClass(this.stateFor(id), this.env);
        return store.fetch(new Request(url, init));
      },
    };
  }
}

async function loadWorker() {
  const root = path.join(__dirname, '..');
  let src = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
  const readerCss = fs.readFileSync(path.join(root, 'server', 'reader.css'), 'utf8');
  src = src.replace(
    /const READER_CSS = `__TDOC_READER_CSS__`;/,
    'const READER_CSS = ' + JSON.stringify(readerCss) + ';'
  );
  const chromeMod = fs.readFileSync(path.join(root, 'server', 'chrome.js'), 'utf8');
  const shellMod = fs.readFileSync(path.join(root, 'server', 'shell.js'), 'utf8');
  const probeJs = fs.readFileSync(path.join(root, 'server', 'frame-probe.js'), 'utf8');
  const chromeCss = fs.readFileSync(path.join(root, 'server', 'chrome.css'), 'utf8');
  src = src.replace('/* __TDOC_CHROME_MODULE__ */', chromeMod);
  src = src.replace('/* __TDOC_SHELL_MODULE__ */', shellMod);
  src = src.replace(/const CHROME_JS = `__TDOC_CHROME_JS__`;/, 'const CHROME_JS = ' + JSON.stringify(chromeMod) + ';');
  src = src.replace(/const PROBE_JS = `__TDOC_PROBE_JS__`;/, 'const PROBE_JS = ' + JSON.stringify(probeJs) + ';');
  src = src.replace(/const CHROME_CSS = `__TDOC_CHROME_CSS__`;/, 'const CHROME_CSS = ' + JSON.stringify(chromeCss) + ';');
  const tmp = path.join(os.tmpdir(), `tdoc-worker-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`);
  fs.writeFileSync(tmp, src);
  const mod = await import(`file://${tmp}`);
  try { fs.unlinkSync(tmp); } catch {}
  return mod;
}

function makeEnv(StoreClass, extra = {}) {
  const env = {
    META: new FakeKV(),
    DOCS: new FakeR2(),
    TDOC_HOSTED_REGISTRATION: '1',
    ...extra,
  };
  env.COMMENTS = new FakeDurableNamespace(env, StoreClass);
  return env;
}

function req(pathname, { method = 'GET', body = null, cookie = '', host = 'tdoc.dev' } = {}) {
  return new Request(`https://${host}${pathname}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie.includes('=') ? cookie : `tdoc_sid=${cookie}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function putSession(env, login) {
  const id = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.META.put(`session:${id}`, JSON.stringify({
    login, name: login, avatar_url: '', created: new Date().toISOString(),
  }));
  return `tdoc_sid=${id}`;
}

async function seedDoc(env, slug, { owner, created = '2026-01-01T00:00:00.000Z', versions, title, access } = {}) {
  const vs = versions || [{ n: 1, created }];
  const meta = { title: title || slug, slug, created, versions: vs };
  if (owner) meta.hosted = { account_id: `acct-${owner}`, github_login: owner };
  if (access) meta.access = access;
  await env.META.put(`meta:${slug}`, JSON.stringify(meta));
  for (const v of vs) await env.DOCS.put(`docs/${slug}/v${v.n}/index.html`, `<h1>${slug}</h1>`);
}

function pane(html, id) {
  const start = html.indexOf(`id="${id}"`);
  assert(start >= 0, `pane ${id} missing`);
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('/me docs experience (sorting / recents / stars / folders)');

  await t('/me sorts the catalog by last update, newest first, and renders sort + tabs', async () => {
    const env = makeEnv(mod.CommentsStore);
    const cookie = await putSession(env, 'alice');
    await seedDoc(env, 'a-older', { owner: 'alice', versions: [{ n: 1, created: '2026-01-05T00:00:00.000Z' }] });
    await seedDoc(env, 'z-newer', { owner: 'alice', versions: [
      { n: 1, created: '2026-02-01T00:00:00.000Z' },
      { n: 2, created: '2026-03-01T00:00:00.000Z' },
    ] });
    const r = await worker.fetch(req('/me', { cookie }), env, {});
    assert(r.status === 200, `/me ${r.status}`);
    const html = await r.text();
    const iNew = html.indexOf('data-slug="z-newer"');
    const iOld = html.indexOf('data-slug="a-older"');
    assert(iNew >= 0 && iOld >= 0, 'both rows must render');
    assert(iNew < iOld, 'latest-updated doc must come first (KV order is alphabetical, so this proves the sort)');
    assert(html.includes('id="doc-sort"'), 'sort select missing');
    assert(html.includes('data-updated="2026-03-01T00:00:00.000Z"'), 'rows must carry data-updated for client re-sort');
    assert(html.includes('data-created='), 'rows must carry data-created');
    assert(html.includes('data-pane="pane-recent"') && html.includes('data-pane="pane-starred"'), 'Recent/Starred tabs missing');
    assert(html.includes('updated 2026-03-01'), 'row meta should show the update day');
  });

  await t('a signed-in visit to a readable doc records recents:<login>; /me shows it with a byline', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDoc(env, 'bobs-doc', { owner: 'bob' });
    const cookie = await putSession(env, 'alice');
    const r = await worker.fetch(req('/d/bobs-doc/v/1', { cookie }), env, {});
    assert(r.status === 200, `doc view ${r.status}`);
    const recents = JSON.parse(await env.META.get('recents:alice'));
    assert(recents && recents.items.length === 1 && recents.items[0].slug === 'bobs-doc',
      `visit not recorded: ${await env.META.get('recents:alice')}`);
    const me = await worker.fetch(req('/me', { cookie }), env, {});
    const html = await me.text();
    const recent = pane(html, 'pane-recent');
    assert(recent.includes('data-slug="bobs-doc"'), 'Recent pane must list the visited doc');
    assert(recent.includes('by bob'), 'Recent row must say whose doc it is');
    // Not alice's doc — it must NOT appear in her own catalog list.
    assert(!pane(html, 'pane-mine').includes('data-slug="bobs-doc"'), "someone else's doc must stay out of My docs");
  });

  await t('anonymous and denied visits record nothing; HEAD records nothing', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDoc(env, 'open-doc', { owner: 'bob' });
    await seedDoc(env, 'locked-doc', { owner: 'bob', access: { visibility: 'private' } });
    await worker.fetch(req('/d/open-doc/v/1'), env, {});
    assert([...env.META.map.keys()].every(k => !k.startsWith('recents:')), 'anonymous visit must not write recents');
    const cookie = await putSession(env, 'alice');
    const denied = await worker.fetch(req('/d/locked-doc/v/1', { cookie }), env, {});
    assert(denied.status === 403, `private doc should deny alice, got ${denied.status}`);
    assert(!(await env.META.get('recents:alice')), 'denied visit must not be recorded');
    await worker.fetch(req('/d/open-doc/v/1', { cookie, method: 'HEAD' }), env, {});
    assert(!(await env.META.get('recents:alice')), 'HEAD must not be recorded');
  });

  await t('revisits dedupe (newest first) and immediate reloads do not rewrite', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDoc(env, 'doc-one', { owner: 'bob' });
    await seedDoc(env, 'doc-two', { owner: 'bob' });
    const cookie = await putSession(env, 'alice');
    await worker.fetch(req('/d/doc-one/v/1', { cookie }), env, {});
    const first = await env.META.get('recents:alice');
    await worker.fetch(req('/d/doc-one/v/1', { cookie }), env, {});
    assert(await env.META.get('recents:alice') === first, 'immediate reload must not rewrite the recents value');
    await worker.fetch(req('/d/doc-two/v/1', { cookie }), env, {});
    await worker.fetch(req('/d/doc-one/v/1', { cookie }), env, {});
    const items = JSON.parse(await env.META.get('recents:alice')).items;
    assert(items.length === 2, `expected 2 recents, got ${items.length}`);
    assert(items[0].slug === 'doc-one' && items[1].slug === 'doc-two', 'revisit must move the doc to the head, not duplicate it');
  });

  await t('star/unstar round-trip: API + Starred pane; anonymous 401; unreadable 404', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDoc(env, 'starrable', { owner: 'bob' });
    await seedDoc(env, 'hidden', { owner: 'bob', access: { visibility: 'private' } });
    const anon = await worker.fetch(req('/api/star', { method: 'POST', body: { slug: 'starrable', starred: true } }), env, {});
    assert(anon.status === 401, `anon star should 401, got ${anon.status}`);
    const cookie = await putSession(env, 'alice');
    const star = await worker.fetch(req('/api/star', { method: 'POST', cookie, body: { slug: 'starrable', starred: true } }), env, {});
    assert(star.status === 200, `star ${star.status}`);
    assert(JSON.parse(await env.META.get('stars:alice')).items[0].slug === 'starrable', 'star not persisted');
    const noDoc = await worker.fetch(req('/api/star', { method: 'POST', cookie, body: { slug: 'no-such-doc', starred: true } }), env, {});
    assert(noDoc.status === 404, `missing doc should 404, got ${noDoc.status}`);
    const priv = await worker.fetch(req('/api/star', { method: 'POST', cookie, body: { slug: 'hidden', starred: true } }), env, {});
    assert(priv.status === 404, `unreadable doc must 404 (no existence oracle), got ${priv.status}`);
    let html = await (await worker.fetch(req('/me', { cookie }), env, {})).text();
    assert(pane(html, 'pane-starred').includes('data-slug="starrable"'), 'Starred pane must list the doc');
    const unstar = await worker.fetch(req('/api/star', { method: 'POST', cookie, body: { slug: 'starrable', starred: false } }), env, {});
    assert(unstar.status === 200, `unstar ${unstar.status}`);
    assert(JSON.parse(await env.META.get('stars:alice')).items.length === 0, 'unstar must remove the item');
    html = await (await worker.fetch(req('/me', { cookie }), env, {})).text();
    assert(!pane(html, 'pane-starred').includes('data-slug="starrable"'), 'unstarred doc must leave the pane');
  });

  await t('starred/recent rows vanish when the doc becomes unreadable or is deleted', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDoc(env, 'was-open', { owner: 'bob' });
    const cookie = await putSession(env, 'alice');
    await worker.fetch(req('/d/was-open/v/1', { cookie }), env, {});
    await worker.fetch(req('/api/star', { method: 'POST', cookie, body: { slug: 'was-open', starred: true } }), env, {});
    // Bob flips the doc private — alice's saved pointers must go dark.
    const meta = JSON.parse(await env.META.get('meta:was-open'));
    meta.access = { visibility: 'private' };
    await env.META.put('meta:was-open', JSON.stringify(meta));
    const html = await (await worker.fetch(req('/me', { cookie }), env, {})).text();
    assert(!pane(html, 'pane-recent').includes('data-slug="was-open"'), 'Recent must drop unreadable docs');
    assert(!pane(html, 'pane-starred').includes('data-slug="was-open"'), 'Starred must drop unreadable docs');
  });

  await t('folders: create → move → chip filter data; delete returns docs to root', async () => {
    const env = makeEnv(mod.CommentsStore);
    const cookie = await putSession(env, 'alice');
    await seedDoc(env, 'my-doc', { owner: 'alice' });
    const anon = await worker.fetch(req('/api/folders', { method: 'POST', body: { name: 'Work' } }), env, {});
    assert(anon.status === 401, `anon create should 401, got ${anon.status}`);
    const create = await worker.fetch(req('/api/folders', { method: 'POST', cookie, body: { name: 'Work' } }), env, {});
    assert(create.status === 200, `create ${create.status}: ${await create.clone().text()}`);
    const folder = (await create.json()).folder;
    assert(folder && folder.id && folder.name === 'Work', 'create must return the folder');
    const dup = await worker.fetch(req('/api/folders', { method: 'POST', cookie, body: { name: 'work' } }), env, {});
    assert(dup.status === 400 && (await dup.json()).error === 'duplicate_name', 'duplicate names (case-insensitive) must 400');
    const empty = await worker.fetch(req('/api/folders', { method: 'POST', cookie, body: { name: '   ' } }), env, {});
    assert(empty.status === 400, 'blank name must 400');

    const move = await worker.fetch(req('/api/folders/move', { method: 'POST', cookie, body: { slugs: ['my-doc'], folder: folder.id } }), env, {});
    assert(move.status === 200, `move ${move.status}: ${await move.clone().text()}`);
    let html = await (await worker.fetch(req('/me', { cookie }), env, {})).text();
    assert(html.includes(`data-folder="${folder.id}"`), 'moved row must carry its folder id');
    assert(html.includes('data-folder="Work"') === false && html.includes('>Work</button>'), 'folder chip must render by name');

    const bogus = await worker.fetch(req('/api/folders/move', { method: 'POST', cookie, body: { slugs: ['my-doc'], folder: 'f_nope' } }), env, {});
    assert(bogus.status === 404, `move to unknown folder should 404, got ${bogus.status}`);

    const del = await worker.fetch(req('/api/folders?id=' + folder.id, { method: 'DELETE', cookie }), env, {});
    assert(del.status === 200, `delete folder ${del.status}`);
    html = await (await worker.fetch(req('/me', { cookie }), env, {})).text();
    assert(html.includes('data-slug="my-doc"'), 'doc must survive folder deletion');
    assert(html.includes('data-folder=""'), 'doc must fall back to the root after its folder is deleted');
  });

  await t('folders shelve only your own docs; rename works; state is per-login', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDoc(env, 'bobs-doc', { owner: 'bob' });
    await seedDoc(env, 'alices-doc', { owner: 'alice' });
    const cookie = await putSession(env, 'alice');
    const create = await worker.fetch(req('/api/folders', { method: 'POST', cookie, body: { name: 'Mine' } }), env, {});
    const folder = (await create.json()).folder;
    const foreign = await worker.fetch(req('/api/folders/move', { method: 'POST', cookie, body: { slugs: ['bobs-doc'], folder: folder.id } }), env, {});
    assert(foreign.status === 403, `moving someone else's doc should 403, got ${foreign.status}`);
    const rename = await worker.fetch(req('/api/folders', { method: 'PATCH', cookie, body: { id: folder.id, name: 'Renamed' } }), env, {});
    assert(rename.status === 200 && (await rename.json()).folder.name === 'Renamed', 'rename failed');
    // Bob's folder state is untouched by everything alice did.
    assert(!(await env.META.get('folders:bob')), "alice's folder ops must never write bob's state");
    const stored = JSON.parse(await env.META.get('folders:alice'));
    assert(stored.folders.length === 1 && stored.folders[0].name === 'Renamed', 'rename must persist');
  });

  await t('doc-page bar carries the star beside the title — signed-in viewers only, state server-rendered', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedDoc(env, 'bar-doc', { owner: 'bob' });
    // chrome.js/chrome.css ship inline on every page, so the button's source
    // strings are always present. Only the RENDERED markup has the class
    // attribute closed with a double quote — key the checks off that.
    const rendered = /class="tdoc-star-btn( is-starred)?" aria-pressed="(true|false)"/;
    const anonHtml = await (await worker.fetch(req('/d/bar-doc/v/1'), env, {})).text();
    assert(!rendered.test(anonHtml), 'anonymous doc view must not render the bar star');
    const cookie = await putSession(env, 'alice');
    let html = await (await worker.fetch(req('/d/bar-doc/v/1', { cookie }), env, {})).text();
    assert(/class="tdoc-star-btn" aria-pressed="false"/.test(html), 'signed-in view must render the empty-star state');
    assert(!html.includes('class="tdoc-star-btn is-starred"'), 'unstarred doc must not render as starred');
    await worker.fetch(req('/api/star', { method: 'POST', cookie, body: { slug: 'bar-doc', starred: true } }), env, {});
    html = await (await worker.fetch(req('/d/bar-doc/v/1', { cookie }), env, {})).text();
    assert(/class="tdoc-star-btn is-starred" aria-pressed="true"/.test(html), 'starred doc must render the filled state');
    const me = await (await worker.fetch(req('/me', { cookie }), env, {})).text();
    assert(!rendered.test(me), 'the /me site bar must not carry the doc star (rows have their own)');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
