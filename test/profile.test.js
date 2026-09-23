// Public /@<handle> profiles: hosted-only, claimed handle or GitHub login,
// public + unlisted docs listed, private excluded. Same worker harness as
// me-docs-experience.test.js.

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
  const shellMod = fs.readFileSync(path.join(root, 'server', 'shell.js'), 'utf8');
  const probeJs = require(path.join(root, 'server', 'frame-probe-source.js'))();
  src = src.replace('/* __TDOC_SHELL_MODULE__ */', shellMod);
  src = src.replace(/const PROBE_JS = `__TDOC_PROBE_JS__`;/, 'const PROBE_JS = ' + JSON.stringify(probeJs) + ';');
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

function req(pathname, { method = 'GET', host = 'tdoc.dev', accept = '', cookie = '', body = null } = {}) {
  return new Request(`https://${host}${pathname}`, {
    method,
    headers: {
      ...(accept ? { Accept: accept } : {}),
      ...(cookie ? { Cookie: cookie.includes('=') ? cookie : `tdoc_sid=${cookie}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function putSession(env, { login = '', email = '', account_id = '' } = {}) {
  const id = [...crypto.getRandomValues(new Uint8Array(16))]
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.META.put(`session:${id}`, JSON.stringify({
    ...(login ? { login } : {}),
    ...(email ? { email } : {}),
    ...(account_id ? { account_id } : {}),
    name: login || email || 'user',
    avatar_url: '',
    created: new Date().toISOString(),
  }));
  return `tdoc_sid=${id}`;
}

async function seedAccount(env, login, accountId = `acct-${login}`) {
  const norm = String(login).toLowerCase();
  await env.META.put(`hosted-account:${norm}`, JSON.stringify({
    account_id: accountId,
    github_login: norm,
    created: '2026-01-01T00:00:00.000Z',
  }));
  return accountId;
}

async function seedEmailAccount(env, email, accountId = `acct-email`) {
  await env.META.put(`account-email:${email}`, JSON.stringify({
    account_id: accountId,
    email,
    created: '2026-01-01T00:00:00.000Z',
  }));
  return accountId;
}

async function seedDoc(env, slug, { owner, accountId, created = '2026-01-01T00:00:00.000Z', versions, title, access } = {}) {
  const vs = versions || [{ n: 1, created }];
  const meta = { title: title || slug, slug, created, versions: vs };
  if (owner) {
    meta.hosted = {
      account_id: accountId || `acct-${owner}`,
      github_login: owner,
    };
  }
  if (access) meta.access = access;
  await env.META.put(`meta:${slug}`, JSON.stringify(meta));
  for (const v of vs) {
    await env.DOCS.put(
      `docs/${slug}/v${v.n}/index.html`,
      `<h1>${title || slug}</h1><p>Opening paragraph about ${slug} for profile previews.</p>`
        + `<img src="https://example.com/${slug}.png" alt="">`,
    );
  }
}

function bootData(html, name) {
  const marker = `window.${name} = `;
  const start = html.indexOf(marker);
  assert(start >= 0, `${name} missing`);
  const end = html.indexOf(';</script>', start);
  assert(end >= 0, `${name} script is not terminated`);
  return JSON.parse(html.slice(start + marker.length, end));
}

async function seedPins(env, accountId, pins, extra = {}) {
  await env.META.put(`account-profile:${accountId}`, JSON.stringify({
    account_id: accountId,
    pins,
    created: '2026-01-01T00:00:00.000Z',
    ...extra,
  }));
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('public @handle profiles');

  await t('/@alice lists only pinned readable docs', async () => {
    const env = makeEnv(mod.CommentsStore);
    const alice = await seedAccount(env, 'alice');
    await seedAccount(env, 'bob');
    await seedDoc(env, 'alice-open', {
      owner: 'alice',
      access: { visibility: 'public' },
      versions: [{ n: 1, created: '2026-02-01T00:00:00.000Z' }],
    });
    await seedDoc(env, 'alice-link', {
      owner: 'alice',
      access: { visibility: 'unlisted' },
      versions: [{ n: 1, created: '2026-03-01T00:00:00.000Z' }],
    });
    await seedDoc(env, 'alice-secret', {
      owner: 'alice',
      access: { visibility: 'private' },
    });
    await seedDoc(env, 'bob-open', {
      owner: 'bob',
      access: { visibility: 'public' },
    });
    // Pin order preserved; private pin is omitted from the public page.
    await seedPins(env, alice, ['alice-link', 'alice-secret', 'alice-open', 'bob-open']);

    const empty = await worker.fetch(req('/@bob'), env, {});
    assert(empty.status === 200, `/@bob ${empty.status}`);
    const emptyBoot = bootData(await empty.text(), '__TDOC_APP_BOOT__');
    assert(emptyBoot.docs.length === 0, 'unpinned profile is empty');

    const r = await worker.fetch(req('/@alice'), env, {});
    assert(r.status === 200, `/@alice ${r.status}`);
    const boot = bootData(await r.text(), '__TDOC_APP_BOOT__');
    assert(boot.page === 'profile' && boot.login === 'alice', 'profile boot');
    assert(boot.docs.map((d) => d.slug).join(',') === 'alice-link,alice-open',
      `expected pinned public/unlisted only, got ${JSON.stringify(boot.docs)}`);
    assert(boot.docs.every((d) => d.url && d.title), 'rows need url + title');
  });

  await t('/@Alice normalizes case; unknown handle 404s', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedAccount(env, 'alice');
    await seedDoc(env, 'only', { owner: 'alice', access: { visibility: 'public' } });
    const okRes = await worker.fetch(req('/@Alice'), env, {});
    assert(okRes.status === 200, `case fold ${okRes.status}`);
    const miss = await worker.fetch(req('/@nobody-here'), env, {});
    assert(miss.status === 404, `unknown must 404, got ${miss.status}`);
    const bad = await worker.fetch(req('/@not valid'), env, {});
    assert(bad.status === 404, `invalid handle must 404, got ${bad.status}`);
  });

  await t('Accept: application/json returns pinned catalog', async () => {
    const env = makeEnv(mod.CommentsStore);
    const alice = await seedAccount(env, 'alice');
    await seedDoc(env, 'pub', { owner: 'alice', access: { visibility: 'public' } });
    await seedDoc(env, 'other', { owner: 'alice', access: { visibility: 'public' } });
    await seedPins(env, alice, ['pub']);
    const r = await worker.fetch(req('/@alice', { accept: 'application/json' }), env, {});
    assert(r.status === 200, `json ${r.status}`);
    const body = await r.json();
    assert(body.ok && body.login === 'alice' && body.docs.length === 1 && body.docs[0].slug === 'pub',
      `json body ${JSON.stringify(body)}`);
  });

  await t('BYOK host refuses profiles', async () => {
    const env = makeEnv(mod.CommentsStore, { TDOC_HOSTED_REGISTRATION: '0' });
    await seedAccount(env, 'alice');
    const r = await worker.fetch(req('/@alice', { host: 'alice.workers.dev' }), env, {});
    assert(r.status === 404, `BYOK must 404, got ${r.status}`);
  });

  await t('email account can claim handle and pin a doc', async () => {
    const env = makeEnv(mod.CommentsStore);
    const accountId = await seedEmailAccount(env, 'sam@example.com', 'acct-sam');
    await seedDoc(env, 'sam-open', {
      accountId,
      access: { visibility: 'public' },
      versions: [{ n: 1, created: '2026-04-01T00:00:00.000Z' }],
    });
    // No github_login on meta — ownership is account_id only.
    const meta = JSON.parse(await env.META.get('meta:sam-open'));
    meta.hosted = { account_id: accountId };
    await env.META.put('meta:sam-open', JSON.stringify(meta));

    const before = await worker.fetch(req('/@sam'), env, {});
    assert(before.status === 404, 'unclaimed must 404');

    const cookie = await putSession(env, { email: 'sam@example.com', account_id: accountId });
    const claim = await worker.fetch(req('/api/me/handle', {
      method: 'POST', cookie, body: { handle: 'sam' },
    }), env, {});
    assert(claim.status === 200, `claim ${claim.status} ${await claim.clone().text()}`);
    const claimed = await claim.json();
    assert(claimed.ok && claimed.handle === 'sam' && claimed.url === '/@sam', JSON.stringify(claimed));

    const empty = await worker.fetch(req('/@sam'), env, {});
    assert(empty.status === 200, `/@sam ${empty.status}`);
    assert(bootData(await empty.text(), '__TDOC_APP_BOOT__').docs.length === 0, 'no pins yet');

    const pin = await worker.fetch(req('/api/me/profile/pin', {
      method: 'POST', cookie, body: { slug: 'sam-open', pinned: true },
    }), env, {});
    assert(pin.status === 200, `pin ${pin.status} ${await pin.clone().text()}`);
    const metaAfter = JSON.parse(await env.META.get('meta:sam-open'));
    assert(metaAfter.preview && /Opening paragraph/.test(metaAfter.preview.excerpt),
      `preview cached on pin: ${JSON.stringify(metaAfter.preview)}`);
    assert(metaAfter.preview.image === 'https://example.com/sam-open.png', 'first graphic cached');

    const page = await worker.fetch(req('/@sam'), env, {});
    assert(page.status === 200, `/@sam ${page.status}`);
    const boot = bootData(await page.text(), '__TDOC_APP_BOOT__');
    assert(boot.page === 'profile' && boot.handle === 'sam', 'claimed profile boot');
    assert(boot.docs.map((d) => d.slug).join(',') === 'sam-open', `docs ${JSON.stringify(boot.docs)}`);
    assert(/Opening paragraph/.test(boot.docs[0].excerpt || ''), 'boot carries excerpt from meta');
    assert(boot.docs[0].image === 'https://example.com/sam-open.png', 'boot carries first graphic');
  });

  await t('curate forces public; take-down restores prior visibility', async () => {
    const env = makeEnv(mod.CommentsStore);
    const accountId = await seedAccount(env, 'owner', 'acct-owner');
    await seedDoc(env, 'secret', {
      owner: 'owner',
      accountId,
      access: { visibility: 'private' },
    });
    const cookie = await putSession(env, { login: 'owner', account_id: accountId });
    await worker.fetch(req('/api/me/handle', {
      method: 'POST', cookie, body: { handle: 'owner' },
    }), env, {});
    const pin = await worker.fetch(req('/api/me/profile/pin', {
      method: 'POST', cookie, body: { slug: 'secret', pinned: true },
    }), env, {});
    assert(pin.status === 200, `pin ${pin.status}`);
    const pinnedBody = await pin.json();
    assert(pinnedBody.visibility === 'public', `curate must publicize, got ${pinnedBody.visibility}`);
    const metaPinned = JSON.parse(await env.META.get('meta:secret'));
    assert(metaPinned.profile && metaPinned.profile.curated === true, 'curated flag');
    assert(metaPinned.profile.restore_visibility === 'private', 'remember private');
    assert(metaPinned.access.visibility === 'public', 'meta visibility public');

    const asPublic = await worker.fetch(req('/@owner'), env, {});
    const pubBoot = bootData(await asPublic.text(), '__TDOC_APP_BOOT__');
    assert(pubBoot.docs.map((d) => d.slug).join(',') === 'secret',
      `public must see curated doc, got ${JSON.stringify(pubBoot.docs)}`);

    const unpin = await worker.fetch(req('/api/me/profile/pin', {
      method: 'POST', cookie, body: { slug: 'secret', pinned: false },
    }), env, {});
    assert(unpin.status === 200, `unpin ${unpin.status}`);
    const unpinnedBody = await unpin.json();
    assert(unpinnedBody.visibility === 'private', `restore private, got ${unpinnedBody.visibility}`);
    const metaRestored = JSON.parse(await env.META.get('meta:secret'));
    assert(!metaRestored.profile, 'curated flag cleared');
    assert(metaRestored.access.visibility === 'private', 'visibility restored');
  });

  await t('non-author cannot curate', async () => {
    const env = makeEnv(mod.CommentsStore);
    const ownerId = await seedAccount(env, 'owner', 'acct-owner');
    await seedAccount(env, 'guest', 'acct-guest');
    await seedDoc(env, 'owners-doc', {
      owner: 'owner',
      accountId: ownerId,
      access: { visibility: 'public' },
    });
    const guestCookie = await putSession(env, { login: 'guest', account_id: 'acct-guest' });
    const pin = await worker.fetch(req('/api/me/profile/pin', {
      method: 'POST', cookie: guestCookie, body: { slug: 'owners-doc', pinned: true },
    }), env, {});
    assert(pin.status === 403, `guest pin must 403, got ${pin.status}`);
  });

  await t('vanity claim works; github login still resolves', async () => {
    const env = makeEnv(mod.CommentsStore);
    const accountId = await seedAccount(env, 'ghuser', 'acct-gh');
    await seedDoc(env, 'pub', {
      owner: 'ghuser',
      accountId,
      access: { visibility: 'public' },
    });
    const cookie = await putSession(env, { login: 'ghuser', account_id: accountId });
    const claim = await worker.fetch(req('/api/me/handle', {
      method: 'POST', cookie, body: { handle: 'julie' },
    }), env, {});
    assert(claim.status === 200, `vanity claim ${claim.status}`);
    const vanity = await worker.fetch(req('/@julie'), env, {});
    assert(vanity.status === 200, `/@julie ${vanity.status}`);
    const viaGh = await worker.fetch(req('/@ghuser'), env, {});
    assert(viaGh.status === 200, 'github login fallback still works');
  });

  await t('cannot claim another account github login', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seedAccount(env, 'alice', 'acct-alice');
    const cookie = await putSession(env, {
      email: 'bob@example.com',
      account_id: await seedEmailAccount(env, 'bob@example.com', 'acct-bob'),
    });
    const claim = await worker.fetch(req('/api/me/handle', {
      method: 'POST', cookie, body: { handle: 'alice' },
    }), env, {});
    assert(claim.status === 409, `must 409, got ${claim.status}`);
  });

  await t('owner can change handle; old @ frees', async () => {
    const env = makeEnv(mod.CommentsStore);
    const accountId = await seedAccount(env, 'mover', 'acct-mover');
    const cookie = await putSession(env, { login: 'mover', account_id: accountId });
    const first = await worker.fetch(req('/api/me/handle', {
      method: 'POST', cookie, body: { handle: 'first-name' },
    }), env, {});
    assert(first.status === 200, `first claim ${first.status}`);
    const second = await worker.fetch(req('/api/me/handle', {
      method: 'POST', cookie, body: { handle: 'second-name' },
    }), env, {});
    assert(second.status === 200, `change ${second.status} ${await second.clone().text()}`);
    const body = await second.json();
    assert(body.handle === 'second-name' && body.changed === true, JSON.stringify(body));
    assert((await worker.fetch(req('/@second-name'), env, {})).status === 200, 'new handle live');
    assert((await worker.fetch(req('/@first-name'), env, {})).status === 404, 'old handle freed');
  });

  await t('signed-in without account_id still mints and claims', async () => {
    const env = makeEnv(mod.CommentsStore);
    // Spectator session: GitHub login + idp, no account_id yet (sign-in does
    // not mint until publish / claim).
    const cookie = await putSession(env, {
      login: 'newbie',
      // putSession only stores login/email/account_id — write raw session.
    });
    const sid = cookie.replace('tdoc_sid=', '');
    await env.META.put(`session:${sid}`, JSON.stringify({
      login: 'newbie',
      name: 'newbie',
      avatar_url: '',
      created: '2026-01-01T00:00:00.000Z',
      idp: { provider: 'github', sub: '999001' },
    }));
    const claim = await worker.fetch(req('/api/me/handle', {
      method: 'POST', cookie, body: { handle: 'julie' },
    }), env, {});
    assert(claim.status === 200, `mint+claim ${claim.status} ${await claim.clone().text()}`);
    const body = await claim.json();
    assert(body.ok && body.handle === 'julie', JSON.stringify(body));
    const page = await worker.fetch(req('/@julie'), env, {});
    assert(page.status === 200, `/@julie after mint ${page.status}`);
    const sess = JSON.parse(await env.META.get(`session:${sid}`));
    assert(sess.account_id, 'session should gain account_id');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
