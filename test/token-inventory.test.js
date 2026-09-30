// /me/tokens: an account can see the terminal credentials it has handed out
// and revoke exactly one, without the all-or-nothing unpair sweep. Browser
// session only; a token cannot list or revoke its siblings.

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

function revokeReq(id, { cookie = '', token = '', origin = 'https://tdoc.dev' } = {}) {
  return new Request('https://tdoc.dev/me/tokens/revoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(origin ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: `id=${encodeURIComponent(id)}`,
  });
}

async function tokenIds(env) {
  return [...env.META.map.keys()].filter(k => k.startsWith('hosted-token:')).map(k => k.slice(13));
}

async function works(worker, env, token) {
  const r = await worker.fetch(req('/api/upload', {
    method: 'POST', token, body: { slug: `probe-${Math.random().toString(16).slice(2, 8)}`, version: 1, html: '<h1>x</h1>' },
  }), env, {});
  return r.status === 200;
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('terminal credential inventory');

  async function seed() {
    const env = makeEnv(mod.CommentsStore);
    const mine = await issue(worker, env, 'owner', 'my-laptop-doc');
    const shared = await issue(worker, env, 'owner', 'hawaii-trip');
    const other = await issue(worker, env, 'stranger', 'their-doc');
    return { env, mine, shared, other };
  }
  async function idOf(env, token) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  await t('the owner sees only their own credentials, with label and approval time', async () => {
    const { env, mine } = await seed();
    const r = await worker.fetch(req('/me/tokens', { cookie: mine.cookie }), env, {});
    assert(r.status === 200, `status ${r.status}`);
    const html = await r.text();
    assert(html.includes('my-laptop-doc') && html.includes('hawaii-trip'), 'own labels missing');
    assert(!html.includes('their-doc'), 'another account\'s credential leaked into the list');
    assert(!/<script/i.test(html), 'page must not need JavaScript');
  });

  await t('revoking one kills that credential and leaves the others working', async () => {
    const { env, mine, shared, other } = await seed();
    const id = await idOf(env, shared.token);
    const r = await worker.fetch(revokeReq(id, { cookie: mine.cookie }), env, {});
    assert(r.status === 303, `status ${r.status}`);
    assert(!(await works(worker, env, shared.token)), 'revoked token still publishes');
    assert(await works(worker, env, mine.token), 'sibling token was revoked too');
    assert(await works(worker, env, other.token), 'another account was affected');
  });

  await t('a credential cannot list or revoke its siblings', async () => {
    const { env, mine, shared } = await seed();
    const list = await worker.fetch(req('/me/tokens', { token: shared.token }), env, {});
    assert(list.status === 302 || list.status === 303, `bearer listing should bounce to sign-in, got ${list.status}`);
    const id = await idOf(env, mine.token);
    const r = await worker.fetch(revokeReq(id, { token: shared.token }), env, {});
    assert(r.status === 401, `bearer revoke should be refused, got ${r.status}`);
    assert(await works(worker, env, mine.token), 'token was revoked by a sibling');
  });

  await t('another account cannot revoke your credential', async () => {
    const { env, mine, other } = await seed();
    const id = await idOf(env, mine.token);
    const r = await worker.fetch(revokeReq(id, { cookie: other.cookie }), env, {});
    assert(r.status === 404, `status ${r.status}`);
    assert((await tokenIds(env)).includes(id), 'foreign revoke deleted the key');
  });

  await t('a cross-site or origin-less post is refused', async () => {
    const { env, mine, shared } = await seed();
    const id = await idOf(env, shared.token);
    for (const origin of ['https://evil.example', '']) {
      const r = await worker.fetch(revokeReq(id, { cookie: mine.cookie, origin }), env, {});
      assert(r.status === 403, `origin ${origin || '(none)'} got ${r.status}`);
    }
    assert(await works(worker, env, shared.token), 'token revoked by a forged post');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
