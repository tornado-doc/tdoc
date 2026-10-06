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
  return new Request('https://tdoc.dev/api/me/tokens/revoke', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ id }),
  });
}

function revokeAllReq({ cookie = '', token = '', origin = 'https://tdoc.dev' } = {}) {
  return new Request('https://tdoc.dev/api/me/tokens/revoke-all', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: '{}',
  });
}

async function listOf(worker, env, cookie) {
  const r = await worker.fetch(req('/api/me/tokens', { cookie }), env, {});
  assert(r.status === 200, `list ${r.status}`);
  return (await r.json()).tokens;
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
    const list = await listOf(worker, env, mine.cookie);
    const labels = list.map(x => x.label).sort();
    assert(JSON.stringify(labels) === JSON.stringify(['hawaii-trip', 'my-laptop-doc']), `labels ${labels}`);
    assert(list.every(x => x.created && /^[a-f0-9]{64}$/.test(x.id)), 'created/id missing');
    const legacy = await worker.fetch(req('/me/tokens', { cookie: mine.cookie }), env, {});
    assert(legacy.status === 302 && legacy.headers.get('Location') === '/me/agents?tab=access', 'old /me/tokens link should land on the Access tab');
    const page = await worker.fetch(req('/me/agents?tab=access', { cookie: mine.cookie }), env, {});
    assert(page.status === 200, `page ${page.status}`);
    const html = await page.text();
    assert(html.includes('"page":"agents"') && html.includes('hawaii-trip'), 'page boot missing the list');
    assert(!html.includes('their-doc'), 'another account\'s credential leaked into the page');
  });

  await t('a label resolves to its doc title only when the doc is yours', async () => {
    const { env, mine, shared, other } = await seed();
    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token: shared.token, body: { slug: 'hawaii-trip', version: 1, html: '<h1>Hawaii 7 days</h1>', title: 'Hawaii 7 days' },
    }), env, {});
    assert(up.status === 200, `upload ${up.status}`);
    const row = (await listOf(worker, env, mine.cookie)).find(x => x.label === 'hawaii-trip');
    assert(row.doc && row.doc.slug === 'hawaii-trip' && row.doc.title, `doc not resolved: ${JSON.stringify(row)}`);
    // A stranger whose credential label names Julie's slug must not learn its title.
    await issue(worker, env, 'stranger', 'hawaii-trip');
    const theirs = (await listOf(worker, env, other.cookie)).find(x => x.label === 'hawaii-trip');
    assert(theirs && theirs.doc === null, `foreign title leaked: ${JSON.stringify(theirs)}`);
  });

  await t('a paired terminal is listed by the device and client it described', async () => {
    const env = makeEnv(mod.CommentsStore);
    const start = await worker.fetch(req('/api/cli/pair/start', {
      method: 'POST', body: { label: 'x', device: 'shared-vm', client: 'Instinct' },
    }), env, {});
    const s0 = await start.json();
    const { putSession } = require('./helpers/worker-harness');
    const cookie = await putSession(env, 'owner');
    const look = await worker.fetch(req('/api/cli/pair/lookup', {
      method: 'POST', cookie, body: { user_code: s0.user_code }, headers: { Origin: 'https://tdoc.dev' },
    }), env, {});
    const l = await look.json();
    assert(l.device === 'shared-vm' && l.client === 'Instinct', `approval page not told who is asking: ${JSON.stringify(l)}`);
    const ap = await worker.fetch(req('/api/cli/pair/approve', {
      method: 'POST', cookie, body: { user_code: s0.user_code }, headers: { Origin: 'https://tdoc.dev' },
    }), env, {});
    assert(ap.status === 200, `approve ${ap.status} ${await ap.text()}`);
    const poll = await worker.fetch(req('/api/cli/pair/poll', {
      method: 'POST', body: { user_code: s0.user_code, pair_secret: s0.pair_secret },
    }), env, {});
    const pd = await poll.json();
    assert(pd.token, `poll ${JSON.stringify(pd)}`);
    const row = (await listOf(worker, env, cookie))[0];
    assert(row.device === 'shared-vm' && row.client === 'Instinct', `row ${JSON.stringify(row)}`);
    assert(!row.last_used, 'unused token claims a last use');
    await works(worker, env, pd.token);
    const used = (await listOf(worker, env, cookie))[0];
    assert(used.last_used, 'using the token did not stamp last_used');
  });

  await t('revoking one kills that credential and leaves the others working', async () => {
    const { env, mine, shared, other } = await seed();
    const id = await idOf(env, shared.token);
    const r = await worker.fetch(revokeReq(id, { cookie: mine.cookie }), env, {});
    assert(r.status === 200, `status ${r.status}`);
    assert(!(await works(worker, env, shared.token)), 'revoked token still publishes');
    assert(await works(worker, env, mine.token), 'sibling token was revoked too');
    assert(await works(worker, env, other.token), 'another account was affected');
  });

  await t('remove all kills every credential on this account and no other account', async () => {
    const { env, mine, shared, other } = await seed();
    assert(await env.META.get(`account-terminal:${mine.account_id}`), 'seed did not mark a paired terminal');
    const r = await worker.fetch(revokeAllReq({ cookie: mine.cookie }), env, {});
    const body = await r.json();
    assert(r.status === 200 && body.revoked === 2, `response ${r.status} ${JSON.stringify(body)}`);
    assert(!(await works(worker, env, mine.token)), 'first account token still publishes');
    assert(!(await works(worker, env, shared.token)), 'second account token still publishes');
    assert(await works(worker, env, other.token), 'another account was affected');
    assert((await listOf(worker, env, mine.cookie)).length === 0, 'revoked credentials remain listed');
    assert(!(await env.META.get(`account-terminal:${mine.account_id}`)), 'paired marker survived full revoke');
  });

  await t('a credential cannot list or revoke its siblings', async () => {
    const { env, mine, shared } = await seed();
    const list = await worker.fetch(req('/api/me/tokens', { token: shared.token }), env, {});
    assert(list.status === 401, `bearer listing should be refused, got ${list.status}`);
    const id = await idOf(env, mine.token);
    const r = await worker.fetch(revokeReq(id, { token: shared.token }), env, {});
    assert(r.status === 401, `bearer revoke should be refused, got ${r.status}`);
    const all = await worker.fetch(revokeAllReq({ token: shared.token }), env, {});
    assert(all.status === 401, `bearer revoke-all should be refused, got ${all.status}`);
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
      const all = await worker.fetch(revokeAllReq({ cookie: mine.cookie, origin }), env, {});
      assert(all.status === 403, `revoke-all origin ${origin || '(none)'} got ${all.status}`);
    }
    assert(await works(worker, env, shared.token), 'token revoked by a forged post');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
