// AppSumo lifetime licenses (#61): a signed webhook records each license,
// /appsumo/activate reads the buyer's key over OAuth, /appsumo/claim puts it on
// one team, and an active license is the Team plan capped at its tier's seats.
// A refund (deactivate) ends it; an upgrade moves the team to the new key.
//
// Drives the real routes through worker.js with fake bindings and stubbed
// appsumo.com / api.licensing.appsumo.com.
//
// Run with: node test/appsumo-licensing.test.js

const crypto = require('crypto');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const CONFIG = {
  TDOC_TEAM_FREE_DOCS: '3', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_MONTHLY: 'price_month', STRIPE_PRICE_YEARLY: 'price_year', STRIPE_WEBHOOK_SECRET: 'whsec_test',
  APPSUMO_API_KEY: 'as_api_key', APPSUMO_CLIENT_ID: 'as_client', APPSUMO_CLIENT_SECRET: 'as_secret',
};
const KEY1 = '11111111-1111-4111-8111-111111111111';
const KEY2 = '22222222-2222-4222-8222-222222222222';
const KEY3 = '33333333-3333-4333-8333-333333333333';

// Fake AppSumo: codes map to license keys; the Licensing API knows tiers.
function stubAppsumo() {
  const codes = new Map();
  const licenses = new Map();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.hostname === 'appsumo.com' && u.pathname === '/openid/token/') {
      const form = new URLSearchParams(init.body || '');
      calls.push({ path: u.pathname, form });
      const key = codes.get(form.get('code'));
      if (!key || form.get('client_secret') !== CONFIG.APPSUMO_CLIENT_SECRET) return reply({ error: 'invalid_grant' }, 400);
      return reply({ access_token: `at_${form.get('code')}`, token_type: 'bearer', expires_in: 3600 });
    }
    if (u.hostname === 'appsumo.com' && u.pathname === '/openid/license_key/') {
      const code = (u.searchParams.get('access_token') || '').replace(/^at_/, '');
      const key = codes.get(code);
      return key ? reply({ license_key: key, status: 'active', scopes: ['read_license'] }) : reply({ error: 'bad token' }, 401);
    }
    if (u.hostname === 'api.licensing.appsumo.com') {
      const key = decodeURIComponent(u.pathname.split('/').pop());
      calls.push({ path: u.pathname, auth: init.headers && init.headers['X-AppSumo-Licensing-Key'] });
      const lic = licenses.get(key);
      return lic ? reply({ license_key: key, ...lic }) : reply({ error: 'not found' }, 404);
    }
    if (u.hostname === 'api.stripe.com') return reply({ error: { message: 'stripe not stubbed' } }, 400);
    return realFetch(input, init);
  };
  return { codes, licenses, calls, restore: () => { globalThis.fetch = realFetch; } };
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('AppSumo lifetime licenses (#61)');
  const origin = { Origin: 'https://tdoc.dev' };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  async function call(env, path, opts) {
    const r = await worker.fetch(req(path, opts), env, ctx);
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text, location: r.headers.get('Location') };
  }
  let clock = Date.now();
  async function hook(env, ev, { apiKey = CONFIG.APPSUMO_API_KEY, ts = Date.now(), sig = null } = {}) {
    clock += 1000;
    const event = { event_timestamp: clock, created_at: 1700000000000, license_status: 'inactive', test: false, ...ev };
    const payload = JSON.stringify(event);
    const signature = sig || crypto.createHmac('sha256', apiKey).update(`${ts}${payload}`).digest('hex');
    const r = await worker.fetch(new Request('https://tdoc.dev/api/appsumo/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Appsumo-Timestamp': String(ts), 'X-Appsumo-Signature': signature }, body: payload,
    }), env, ctx);
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  }
  async function setup() {
    const env = makeEnv(mod.CommentsStore, CONFIG);
    const admin = await issue(worker, env, 'buyer');
    const made = await call(env, '/api/teams', { method: 'POST', cookie: admin.cookie, headers: origin, body: { name: 'Crew' } });
    assert(made.status === 200, `team ${made.status}`);
    return { env, admin, team: made.body.team };
  }
  // Buyer flow: AppSumo redirect with a code, then the claim page.
  async function activate(env, as, code, who) {
    const a = await call(env, `/appsumo/activate?code=${code}`);
    assert(a.status === 302 && /^\/appsumo\/claim\?c=[a-f0-9]+$/.test(a.location), `activate ${a.status} ${a.location} ${a.text.slice(0, 200)}`);
    return call(env, a.location, { cookie: who && who.cookie });
  }
  const plan = async (env, who, team) => (await call(env, `/api/team/billing?id=${team.id}`, { cookie: who.cookie })).body.billing;
  const fill = async (env, who, team, n, from = 0) => {
    for (let i = from; i < from + n; i++) await call(env, '/api/upload', { method: 'POST', token: who.token, body: { slug: `ltd-${i}`, version: 1, html: `<p>${i}</p>` } });
    return call(env, '/api/team/move', { method: 'POST', token: who.token, body: { team: team.id, slugs: Array.from({ length: n }, (_, k) => `ltd-${from + k}`) } });
  };

  await t('without AppSumo keys the webhook and activation are unavailable', async () => {
    const env = makeEnv(mod.CommentsStore, {});
    assert((await hook(env, { license_key: KEY1, event: 'purchase' })).status === 503, 'webhook answered without keys');
    assert((await call(env, '/appsumo/activate?code=x')).status === 503, 'activate answered without keys');
  });

  await t('the webhook checks the HMAC over timestamp + body and a fresh timestamp', async () => {
    const as = stubAppsumo();
    try {
      const { env } = await setup();
      assert((await hook(env, { license_key: KEY1, event: 'purchase' }, { apiKey: 'wrong' })).status === 401, 'wrong key accepted');
      assert((await hook(env, { license_key: KEY1, event: 'purchase' }, { ts: Date.now() - 2 * 60 * 60 * 1000 })).status === 401, 'stale timestamp accepted');
      assert((await hook(env, { license_key: KEY1, event: 'purchase' }, { sig: 'deadbeef' })).status === 401, 'bad signature accepted');
      const test = await hook(env, { license_key: '00000000-aaaa-1111-bbbb-abcdef012345', event: 'purchase', test: true });
      assert(test.status === 200 && test.body.success === true && test.body.event === 'purchase', JSON.stringify(test));
      assert(!env.META.map.has('appsumo-license:00000000-aaaa-1111-bbbb-abcdef012345'), 'a test event was recorded');
    } finally { as.restore(); }
  });

  await t('the OAuth redirect answers AppSumo\'s bare validation GET with 200', async () => {
    const { env } = await setup();
    const r = await call(env, '/appsumo/activate');
    assert(r.status === 200, `validation GET ${r.status}`);
  });

  await t('activate + claim puts an active license on the buyer\'s only team: Team plan, seats capped, no doc limit', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      assert((await hook(env, { license_key: KEY1, event: 'purchase', tier: 2 })).body.success, 'purchase');
      assert((await hook(env, { license_key: KEY1, event: 'activate', tier: 2 })).body.success, 'activate');
      as.codes.set('code1', KEY1);
      const signedOut = await activate(env, as, 'code1', null);
      assert(signedOut.status === 200 && /Sign in/.test(signedOut.text), `claim without a session ${signedOut.status}`);
      const claimUrl = (await call(env, '/appsumo/activate?code=code1')).location;
      const done = await call(env, claimUrl, { cookie: admin.cookie });
      assert(done.status === 302 && done.location.includes(`team=${team.id}`) && done.location.includes('appsumo=applied'), `claim ${done.status} ${done.location} ${done.text.slice(0, 300)}`);
      const p = await plan(env, admin, team);
      assert(p.plan === 'team' && p.lifetime && p.lifetime.seats === 15 && p.lifetime.tier === 2 && p.lifetime.source === 'appsumo', JSON.stringify(p));
      assert((await fill(env, admin, team, 5)).status === 200, 'a lifetime team was held to the free doc limit');
      const co = await call(env, '/api/team/billing', { method: 'POST', cookie: admin.cookie, headers: origin, body: { id: team.id, action: 'checkout' } });
      assert(co.status === 409 && co.body.error === 'already_subscribed', `checkout on a lifetime team ${co.status}`);
      const again = await call(env, claimUrl, { cookie: admin.cookie });
      assert(again.status === 410, `a used claim link still worked: ${again.status}`);
    } finally { as.restore(); }
  });

  await t('a buyer who arrives before the webhook gets the tier from the Licensing API', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      as.codes.set('early', KEY3);
      as.licenses.set(KEY3, { status: 'active', tier: 1 });
      const done = await activate(env, as, 'early', admin);
      assert(done.status === 302, `claim ${done.status} ${done.text.slice(0, 300)}`);
      assert(as.calls.some((c) => c.auth === CONFIG.APPSUMO_API_KEY), 'Licensing API not called with the partner key');
      assert((await plan(env, admin, team)).lifetime.seats === 5, 'tier 1 is not 5 seats');
    } finally { as.restore(); }
  });

  await t('the tier caps members: the 6th person cannot join a 5-seat license', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      await hook(env, { license_key: KEY1, event: 'activate', tier: 1 });
      as.codes.set('c', KEY1);
      assert((await activate(env, as, 'c', admin)).status === 302, 'claim');
      const people = ['p1', 'p2', 'p3', 'p4', 'p5'];
      await call(env, '/api/team', { method: 'PATCH', cookie: admin.cookie, headers: origin, body: { id: team.id, invites: people } });
      for (const login of people.slice(0, 4)) {
        const who = await issue(worker, env, login);
        const r = await call(env, '/api/team/accept-invite', { method: 'POST', cookie: who.cookie, headers: origin, body: { id: team.id } });
        assert(r.status === 200, `${login} could not join: ${r.status} ${JSON.stringify(r.body)}`);
      }
      const sixth = await issue(worker, env, 'p5');
      const r = await call(env, '/api/team/accept-invite', { method: 'POST', cookie: sixth.cookie, headers: origin, body: { id: team.id } });
      assert(r.status >= 400 && r.body.error === 'team_full' && r.body.limit === 5, `6th join ${r.status} ${JSON.stringify(r.body)}`);
    } finally { as.restore(); }
  });

  await t('an upgrade moves the team to the new key, whichever event lands first', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      await hook(env, { license_key: KEY1, event: 'activate', tier: 1 });
      as.codes.set('c', KEY1);
      assert((await activate(env, as, 'c', admin)).status === 302, 'claim');
      // The old key's deactivate can beat the upgrade.
      await hook(env, { license_key: KEY1, event: 'deactivate', tier: 1, license_status: 'deactivated' });
      assert((await plan(env, admin, team)).plan === 'free', 'a deactivated key left the plan on');
      await hook(env, { license_key: KEY2, prev_license_key: KEY1, event: 'upgrade', tier: 3 });
      const p = await plan(env, admin, team);
      assert(p.plan === 'team' && p.lifetime.seats === 40, `after upgrade ${JSON.stringify(p)}`);
      // A late event for the replaced key does not take the team back.
      await hook(env, { license_key: KEY1, event: 'activate', tier: 1 });
      assert((await plan(env, admin, team)).lifetime.seats === 40, 'the old key took the team back');
    } finally { as.restore(); }
  });

  await t('a refund ends the plan, pauses backup, and an older event cannot bring it back', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      const activateAt = clock + 1000;
      await hook(env, { license_key: KEY1, event: 'activate', tier: 2 });
      as.codes.set('c', KEY1);
      assert((await activate(env, as, 'c', admin)).status === 302, 'claim');
      await hook(env, { license_key: KEY1, event: 'deactivate', tier: 2, license_status: 'active', extra: { reason: 'Refunded' } });
      const p = await plan(env, admin, team);
      assert(p.plan === 'free' && !p.lifetime, `after refund ${JSON.stringify(p)}`);
      // A retry of the original activate, delivered late, is older and dropped.
      const late = await hook(env, { license_key: KEY1, event: 'activate', tier: 2, event_timestamp: activateAt - 5000 });
      assert(late.body.success, 'late event not acknowledged');
      assert((await plan(env, admin, team)).plan === 'free', 'a stale activate revived a refunded license');
      const backup = await call(env, '/api/team/backup', { method: 'PUT', cookie: admin.cookie, headers: origin, body: { id: team.id, endpoint: 'https://x.r2.cloudflarestorage.com', bucket: 'b', access_key_id: 'a', secret_access_key: 's' } });
      assert(backup.status === 402, `backup turned on after a refund: ${backup.status}`);
    } finally { as.restore(); }
  });

  await t('a buyer with no team gets one; a claim link belongs to the first account that opens it', async () => {
    const as = stubAppsumo();
    try {
      const env = makeEnv(mod.CommentsStore, CONFIG);
      const fresh = await issue(worker, env, 'newbie');
      const other = await issue(worker, env, 'snoop');
      await hook(env, { license_key: KEY1, event: 'activate', tier: 1 });
      as.codes.set('c', KEY1);
      const claimUrl = (await call(env, '/appsumo/activate?code=c')).location;
      // First account binds the claim; the license is applied to its new team.
      const done = await call(env, claimUrl, { cookie: fresh.cookie });
      assert(done.status === 302 && /team=t_/.test(done.location), `claim ${done.status} ${done.text.slice(0, 300)}`);
      const teams = (await call(env, '/api/teams', { cookie: fresh.cookie })).body.teams;
      assert(teams.length === 1 && /team/i.test(teams[0].name), JSON.stringify(teams));
      // A second license: opened first by the buyer (now with two teams, so
      // it stops at the chooser and stays open), then by someone else.
      await call(env, '/api/teams', { method: 'POST', cookie: fresh.cookie, headers: origin, body: { name: 'Second' } });
      await hook(env, { license_key: KEY2, event: 'activate', tier: 1 });
      as.codes.set('c2', KEY2);
      const claim2 = (await call(env, '/appsumo/activate?code=c2')).location;
      const chooser = await call(env, claim2, { cookie: fresh.cookie });
      assert(chooser.status === 200, `chooser ${chooser.status}`);
      const stolen = await call(env, claim2, { cookie: other.cookie });
      assert(stolen.status === 403, `another account used a bound claim: ${stolen.status}`);
      // Someone else's own claim cannot take a license already on a team.
      const claim3 = (await call(env, '/appsumo/activate?code=c')).location;
      const taken = await call(env, claim3, { cookie: other.cookie });
      assert(taken.status === 409 && /already on/.test(taken.text), `license moved to another account's team: ${taken.status}`);
      assert(!((await call(env, '/api/teams', { cookie: other.cookie })).body.teams || []).length, 'a refused claim still made a team');
    } finally { as.restore(); }
  });

  await t('several teams: the buyer chooses, and a team already paying by card is refused', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      const second = (await call(env, '/api/teams', { method: 'POST', cookie: admin.cookie, headers: origin, body: { name: 'Side' } })).body.team;
      await env.META.put(`team-billing:${second.id}`, JSON.stringify({ status: 'active', subscription: 'sub_1', item: 'si_1', quantity: 1 }));
      await hook(env, { license_key: KEY1, event: 'activate', tier: 1 });
      as.codes.set('c', KEY1);
      const choose = await activate(env, as, 'c', admin);
      assert(choose.status === 200 && choose.text.includes('Crew') && choose.text.includes('Side'), `chooser ${choose.status}`);
      const claimUrl = (await call(env, '/appsumo/activate?code=c')).location;
      const nonce = new URL(`https://x${claimUrl}`).searchParams.get('c');
      await call(env, claimUrl, { cookie: admin.cookie });
      const paid = await call(env, `/appsumo/apply?c=${nonce}&team=${second.id}`, { cookie: admin.cookie });
      assert(paid.status === 409 && /already pays by card/.test(paid.text), `card team ${paid.status}`);
      const ok = await call(env, `/appsumo/apply?c=${nonce}&team=${team.id}`, { cookie: admin.cookie });
      assert(ok.status === 302 && ok.location.includes(team.id), `apply ${ok.status}`);
    } finally { as.restore(); }
  });

  await t('review #1: an activate webhook landing after the claim cannot unhook the team from a later refund', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      as.codes.set('c', KEY1);
      as.licenses.set(KEY1, { status: 'active', tier: 2 });
      assert((await activate(env, as, 'c', admin)).status === 302, 'claim');
      // AppSumo's own activate arrives after the buyer, rewriting the license record.
      await hook(env, { license_key: KEY1, event: 'activate', tier: 2 });
      assert((await plan(env, admin, team)).plan === 'team', 'plan lost after the late webhook');
      await hook(env, { license_key: KEY1, event: 'deactivate', tier: 2 });
      assert((await plan(env, admin, team)).plan === 'free', 'refund missed the team');
    } finally { as.restore(); }
  });

  await t('review #2: one license applied from two tabs at once leaves exactly one team on the plan', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      const second = (await call(env, '/api/teams', { method: 'POST', cookie: admin.cookie, headers: origin, body: { name: 'Side' } })).body.team;
      await hook(env, { license_key: KEY1, event: 'activate', tier: 1 });
      as.codes.set('c', KEY1);
      const claimUrl = (await call(env, '/appsumo/activate?code=c')).location;
      const nonce = new URL(`https://x${claimUrl}`).searchParams.get('c');
      await call(env, claimUrl, { cookie: admin.cookie });
      await Promise.all([
        call(env, `/appsumo/apply?c=${nonce}&team=${team.id}`, { cookie: admin.cookie }),
        call(env, `/appsumo/apply?c=${nonce}&team=${second.id}`, { cookie: admin.cookie }),
      ]);
      const plans = [(await plan(env, admin, team)).plan, (await plan(env, admin, second)).plan];
      assert(plans.filter((x) => x === 'team').length === 1, `plans after two tabs: ${plans}`);
    } finally { as.restore(); }
  });

  await t('review #3: an unknown tier never means unlimited seats, and an upgrade to one keeps the old seats', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      await hook(env, { license_key: KEY1, event: 'activate', tier: 1 });
      as.codes.set('c', KEY1);
      assert((await activate(env, as, 'c', admin)).status === 302, 'claim');
      await hook(env, { license_key: KEY2, prev_license_key: KEY1, event: 'upgrade', tier: 9 });
      const p = await plan(env, admin, team);
      assert(p.plan === 'team' && p.lifetime.seats === 5, `an upgrade to an unknown tier should keep the old seats: ${JSON.stringify(p)}`);
      // And a fresh key on an unknown tier cannot be applied at all.
      await hook(env, { license_key: KEY3, event: 'activate', tier: 7 });
      as.codes.set('c3', KEY3);
      const r = await activate(env, as, 'c3', admin);
      assert(r.status === 409, `unknown tier applied: ${r.status}`);
    } finally { as.restore(); }
  });

  await t('review #4: a downgrade below the member count keeps everyone and stops new joins', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      await hook(env, { license_key: KEY1, event: 'activate', tier: 2 });
      as.codes.set('c', KEY1);
      assert((await activate(env, as, 'c', admin)).status === 302, 'claim');
      const people = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
      await call(env, '/api/team', { method: 'PATCH', cookie: admin.cookie, headers: origin, body: { id: team.id, invites: people } });
      for (const login of people.slice(0, 5)) {
        const who = await issue(worker, env, login);
        assert((await call(env, '/api/team/accept-invite', { method: 'POST', cookie: who.cookie, headers: origin, body: { id: team.id } })).status === 200, `${login} join`);
      }
      await hook(env, { license_key: KEY2, prev_license_key: KEY1, event: 'downgrade', tier: 1 });
      const p = await plan(env, admin, team);
      assert(p.plan === 'team' && p.seats === 6 && p.lifetime.seats === 5, `after downgrade ${JSON.stringify(p)}`);
      const late = await issue(worker, env, 'd6');
      const r = await call(env, '/api/team/accept-invite', { method: 'POST', cookie: late.cookie, headers: origin, body: { id: team.id } });
      assert(r.body && r.body.error === 'team_full', `join over the cap ${r.status} ${JSON.stringify(r.body)}`);
    } finally { as.restore(); }
  });

  await t('review #5: applying a license closes a card Checkout the team had open', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      await env.META.put(`team-checkout:${team.id}`, JSON.stringify({ id: 'cs_open', interval: 'month', quantity: 1 }));
      await hook(env, { license_key: KEY1, event: 'activate', tier: 1 });
      as.codes.set('c', KEY1);
      assert((await activate(env, as, 'c', admin)).status === 302, 'claim');
      assert(!env.META.map.has(`team-checkout:${team.id}`), 'open Checkout left in place');
      // If a card plan completes anyway, the admin is told to cancel it.
      await env.META.put(`team-billing:${team.id}`, JSON.stringify({ status: 'active', customer: 'cus_1', subscription: 'sub_1', item: 'si_1', quantity: 1 }));
      const p = await plan(env, admin, team);
      assert(p.double_billed === true && p.has_customer === true, JSON.stringify(p));
    } finally { as.restore(); }
  });

  await t('review #6: a lost activate webhook does not strand the buyer', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      await hook(env, { license_key: KEY1, event: 'purchase', tier: 1 });
      as.licenses.set(KEY1, { status: 'active', tier: 1 });
      as.codes.set('c', KEY1);
      assert((await activate(env, as, 'c', admin)).status === 302, 'buyer stuck on an unconfirmed license');
      assert((await plan(env, admin, team)).plan === 'team', 'plan not on');
    } finally { as.restore(); }
  });

  await t('review #7: a key replaced by an upgrade stays retired after the new key is refunded', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      await hook(env, { license_key: KEY1, event: 'activate', tier: 1 });
      as.codes.set('c', KEY1);
      assert((await activate(env, as, 'c', admin)).status === 302, 'claim');
      await hook(env, { license_key: KEY2, prev_license_key: KEY1, event: 'upgrade', tier: 2 });
      await hook(env, { license_key: KEY2, event: 'deactivate', tier: 2 });
      await hook(env, { license_key: KEY1, event: 'activate', tier: 1 });
      assert((await plan(env, admin, team)).plan === 'free', 'the old key came back after the refund');
      as.codes.set('again', KEY1);
      const r = await activate(env, as, 'again', admin);
      assert(r.status === 409, `the retired key was applied again: ${r.status}`);
    } finally { as.restore(); }
  });

  await t('re-review: a refunded key stays refunded even when a retried activate arrives with a newer timestamp', async () => {
    const as = stubAppsumo();
    try {
      const { env, admin, team } = await setup();
      await hook(env, { license_key: KEY1, event: 'activate', tier: 2 });
      as.codes.set('c', KEY1);
      assert((await activate(env, as, 'c', admin)).status === 302, 'claim');
      await hook(env, { license_key: KEY1, event: 'deactivate', tier: 2 });
      await hook(env, { license_key: KEY1, event: 'activate', tier: 2 });
      await hook(env, { license_key: KEY1, event: 'purchase', tier: 2 });
      assert((await plan(env, admin, team)).plan === 'free', 'a retried activate reopened a refunded license');
      // The Licensing API fallback cannot reopen it either.
      as.licenses.set(KEY1, { status: 'active', tier: 2 });
      as.codes.set('again', KEY1);
      assert((await activate(env, as, 'again', admin)).status === 409, 'the API fallback reopened a refunded license');
    } finally { as.restore(); }
  });

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
