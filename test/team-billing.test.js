// Team plan (#48): members are free and unlimited; a free team holds 20 docs.
// The 21st doc in, or turning on Data backup, needs the Team plan ($8/seat).
//
// Drives the real routes through worker.js with fake bindings and a stubbed
// api.stripe.com, so Checkout, the Customer Portal, the signed webhook and
// seat sync are exercised without a Stripe account.
//
// Run with: node test/team-billing.test.js

const crypto = require('crypto');
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const STRIPE = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_MONTHLY: 'price_month', STRIPE_PRICE_YEARLY: 'price_year', STRIPE_WEBHOOK_SECRET: 'whsec_test' };

// A fake Stripe: records calls, keeps one subscription per id.
function stubStripe() {
  const calls = [];
  const subs = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' ? input : input.url);
    if (u.hostname !== 'api.stripe.com') return realFetch(input, init);
    const form = new URLSearchParams(init.body || '');
    calls.push({ method: init.method || 'GET', path: u.pathname, form, auth: init.headers && init.headers.Authorization });
    const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/v1/checkout/sessions') return reply({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' });
    if (u.pathname === '/v1/billing_portal/sessions') return reply({ id: 'bps_1', url: 'https://billing.stripe.com/p/session_1' });
    const m = u.pathname.match(/^\/v1\/subscriptions\/([^/]+)$/);
    if (m) {
      const sub = subs.get(m[1]);
      if (!sub) return reply({ error: { message: 'No such subscription' } }, 404);
      if ((init.method || 'GET') === 'POST') sub.items.data[0].quantity = Number(form.get('items[0][quantity]'));
      return reply(sub);
    }
    return reply({ error: { message: `unexpected ${u.pathname}` } }, 400);
  };
  return { calls, subs, restore: () => { globalThis.fetch = realFetch; } };
}

function subscription(id, teamId, quantity, status = 'active', interval = 'month') {
  return {
    id, object: 'subscription', customer: 'cus_1', status, cancel_at_period_end: false, metadata: { team_id: teamId },
    items: { data: [{ id: 'si_1', quantity, current_period_end: 1893456000, price: { id: `price_${interval}`, recurring: { interval } } }] },
  };
}

function signed(event, secret = STRIPE.STRIPE_WEBHOOK_SECRET, t = Math.floor(Date.now() / 1000)) {
  const payload = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
  return { payload, header: `t=${t},v1=${sig}` };
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('team plan billing (#48)');

  const origin = { Origin: 'https://tdoc.dev' };
  async function call(env, path, opts) {
    const r = await worker.fetch(req(path, opts), env, { waitUntil() {}, passThroughOnException() {} });
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  }
  async function setup(extra = STRIPE) {
    const env = makeEnv(mod.CommentsStore, extra);
    const admin = await issue(worker, env, 'boss');
    const made = await call(env, '/api/teams', { method: 'POST', cookie: admin.cookie, headers: origin, body: { name: 'Crew' } });
    assert(made.status === 200, `team ${made.status} ${JSON.stringify(made.body)}`);
    const team = made.body.team;
    const join = async (login) => {
      const who = await issue(worker, env, login);
      return { who, r: await call(env, '/api/team/accept-invite', { method: 'POST', cookie: who.cookie, headers: origin, body: { id: team.id } }) };
    };
    // Invite people by handle so accept-invite is allowed.
    const invite = (logins) => call(env, '/api/team', { method: 'PATCH', cookie: admin.cookie, headers: origin, body: { id: team.id, invites: logins } });
    const fill = async (n, from = 0) => {
      for (let i = from; i < from + n; i++) {
        const slug = `doc-${i}`;
        const up = await call(env, '/api/upload', { method: 'POST', token: admin.token, body: { slug, version: 1, html: `<p>${slug}</p>` } });
        assert(up.status === 200, `upload ${slug} ${up.status} ${JSON.stringify(up.body)}`);
      }
      return call(env, '/api/team/move', { method: 'POST', token: admin.token, body: { team: team.id, slugs: Array.from({ length: n }, (_, k) => `doc-${from + k}`) } });
    };
    return { env, admin, team, join, invite, fill };
  }
  const webhook = (env, event, opts = {}) => {
    const s = signed(event, opts.secret);
    return worker.fetch(new Request('https://tdoc.dev/api/stripe/webhook', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Stripe-Signature': opts.header || s.header }, body: s.payload,
    }), env, { waitUntil() {} });
  };

  await t('without Stripe configured nothing changes: a 21st doc moves in and the plan reads unavailable', async () => {
    const { env, admin, team, fill } = await setup({});
    assert((await fill(21)).status === 200, 'unconfigured move refused');
    const plan = await call(env, `/api/team/billing?id=${team.id}`, { cookie: admin.cookie });
    assert(plan.status === 200 && plan.body.billing.configured === false, JSON.stringify(plan.body));
    const co = await call(env, '/api/team/billing', { method: 'POST', cookie: admin.cookie, headers: origin, body: { id: team.id, action: 'checkout' } });
    assert(co.status === 503, `checkout without Stripe ${co.status}`);
  });

  await t('a free team: unlimited members, 20 docs; the 21st doc in is refused, existing docs still publish', async () => {
    const stripe = stubStripe();
    try {
      const { env, admin, team, join, invite, fill } = await setup();
      const people = ['b1', 'b2', 'b3', 'b4', 'b5'];
      await invite(people);
      for (const login of people) assert((await join(login)).r.status === 200, `${login} could not join a free team`);
      assert((await fill(20)).status === 200, '20 docs refused');
      const plan = (await call(env, `/api/team/billing?id=${team.id}`, { cookie: admin.cookie })).body.billing;
      assert(plan.docs === 20 && plan.free_docs === 20 && plan.at_limit === true && plan.seats === 6, JSON.stringify(plan));
      const over = await fill(1, 20);
      assert(over.status === 402 && over.body.error === 'team_plan_required' && /upgrade/i.test(over.body.message), `${over.status} ${JSON.stringify(over.body)}`);
      const v2 = await call(env, '/api/upload', { method: 'POST', token: admin.token, body: { slug: 'doc-0', version: 2, html: '<p>edited</p>' } });
      assert(v2.status === 200, `a new version of an existing team doc was refused: ${v2.status}`);
      // A whole My docs folder moving in is counted the same way, before any write.
      await call(env, '/api/upload', { method: 'POST', token: admin.token, body: { slug: 'in-folder', version: 1, html: '<p>f</p>' } });
      const folder = (await call(env, '/api/folders', { method: 'POST', token: admin.token, body: { name: 'Research' } })).body.folder;
      await call(env, '/api/folders/move', { method: 'POST', token: admin.token, body: { slugs: ['in-folder'], folder: folder.id } });
      const folderMove = await call(env, '/api/folders/move-to-team', { method: 'POST', token: admin.token, body: { folder: folder.id, team: team.id } });
      assert(folderMove.status === 402 && folderMove.body.error === 'team_plan_required', `folder move ${folderMove.status} ${JSON.stringify(folderMove.body)}`);
      const stayed = await call(env, '/api/folders', { token: admin.token });
      assert(stayed.body.folders.some((f) => f.id === folder.id), 'the refused folder left My docs');
      const blank = await call(env, '/api/doc/create', { method: 'POST', cookie: admin.cookie, headers: origin, body: { team: team.id } });
      assert(blank.status === 402 && blank.body.error === 'team_plan_required', `create in team ${blank.status}`);
      const backup = await call(env, '/api/team/backup', { method: 'PUT', cookie: admin.cookie, headers: origin, body: { id: team.id, endpoint: 'https://acct.r2.cloudflarestorage.com', bucket: 'b-1', region: 'auto', access_key_id: 'AKIA1234', secret_access_key: 'secret-1234' } });
      assert(backup.status === 402 && backup.body.error === 'team_plan_required', `backup on free plan ${backup.status} ${JSON.stringify(backup.body)}`);
      assert(stripe.calls.length === 0, 'the free path never calls Stripe');
      const outsider = await issue(worker, env, 'nobody');
      assert((await call(env, `/api/team/billing?id=${team.id}`, { cookie: outsider.cookie })).status === 404, 'a non-member read the plan');
    } finally { stripe.restore(); }
  });

  await t('only an admin opens Checkout; it bills every member, monthly or yearly, tagged with the team', async () => {
    const stripe = stubStripe();
    try {
      const { env, admin, team, join, invite } = await setup();
      await invite(['c1']);
      const member = (await join('c1')).who;
      const denied = await call(env, '/api/team/billing', { method: 'POST', cookie: member.cookie, headers: origin, body: { id: team.id, action: 'checkout' } });
      assert(denied.status === 403, `member checkout ${denied.status}`);
      const cross = await call(env, '/api/team/billing', { method: 'POST', cookie: admin.cookie, headers: { Origin: 'https://evil.example' }, body: { id: team.id, action: 'checkout' } });
      assert(cross.status === 403, `cross-origin checkout ${cross.status}`);
      const co = await call(env, '/api/team/billing', { method: 'POST', cookie: admin.cookie, headers: origin, body: { id: team.id, action: 'checkout', interval: 'year' } });
      assert(co.status === 200 && co.body.url === 'https://checkout.stripe.com/c/cs_1', JSON.stringify(co.body));
      const sent = stripe.calls.find((c) => c.path === '/v1/checkout/sessions').form;
      assert(sent.get('mode') === 'subscription');
      assert(sent.get('line_items[0][price]') === 'price_year' && sent.get('line_items[0][quantity]') === '2', `line item ${sent.toString()}`);
      assert(sent.get('metadata[team_id]') === team.id && sent.get('subscription_data[metadata][team_id]') === team.id);
      assert(sent.get('success_url').includes(`team=${team.id}`) && sent.get('success_url').includes('billing=success'));
      assert(stripe.calls[0].auth === 'Bearer sk_test_x');
    } finally { stripe.restore(); }
  });

  await t('the webhook refuses a bad or stale signature and writes nothing', async () => {
    const stripe = stubStripe();
    try {
      const { env, team } = await setup();
      const event = { type: 'customer.subscription.updated', data: { object: subscription('sub_x', team.id, 9) } };
      assert((await webhook(env, event, { secret: 'whsec_wrong' })).status === 400, 'wrong secret accepted');
      const stale = signed(event, STRIPE.STRIPE_WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 3600);
      assert((await webhook(env, event, { header: stale.header })).status === 400, 'stale timestamp accepted');
      assert(!env.META.map.has(`team-billing:${team.id}`), 'state written from an unsigned event');
    } finally { stripe.restore(); }
  });

  await t('checkout completed activates the plan; docs past 20 move in and seats follow membership', async () => {
    const stripe = stubStripe();
    try {
      const { env, admin, team, join, invite, fill } = await setup();
      await invite(['d1', 'd2', 'd3']);
      await join('d1'); await join('d2');
      stripe.subs.set('sub_1', subscription('sub_1', team.id, 3));
      const event = { type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', client_reference_id: team.id, metadata: { team_id: team.id } } } };
      assert((await webhook(env, event)).status === 200);
      let plan = (await call(env, `/api/team/billing?id=${team.id}`, { cookie: admin.cookie })).body.billing;
      assert(plan.plan === 'team' && plan.status === 'active' && plan.interval === 'month' && plan.quantity === 3 && plan.at_limit === false, JSON.stringify(plan));
      // Redelivery is harmless: same state, no Stripe write.
      const before = env.META.map.get(`team-billing:${team.id}`);
      const posts = stripe.calls.filter((c) => c.method === 'POST').length;
      assert((await webhook(env, event)).status === 200);
      assert(JSON.parse(env.META.map.get(`team-billing:${team.id}`)).subscription === JSON.parse(before).subscription);
      assert(stripe.calls.filter((c) => c.method === 'POST').length === posts, 'a redelivered event changed the subscription');
      assert((await fill(21)).status === 200, 'a paid team could not hold 21 docs');
      const fourth = await join('d3');
      assert(fourth.r.status === 200, `paid join ${fourth.r.status}`);
      const update = stripe.calls.filter((c) => c.method === 'POST' && c.path === '/v1/subscriptions/sub_1').pop();
      assert(update && update.form.get('items[0][id]') === 'si_1' && update.form.get('items[0][quantity]') === '4', 'seat count not synced on join');
      assert(update.form.get('proration_behavior') === 'create_prorations');
      plan = (await call(env, `/api/team/billing?id=${team.id}`, { cookie: admin.cookie })).body.billing;
      assert(plan.quantity === 4 && plan.seats === 4, JSON.stringify(plan));
      const removed = await call(env, '/api/team/remove', { method: 'POST', cookie: admin.cookie, headers: origin, body: { id: team.id, account_id: fourth.who.account_id } });
      assert(removed.status === 200, `remove ${removed.status}`);
      const down = stripe.calls.filter((c) => c.method === 'POST' && c.path === '/v1/subscriptions/sub_1').pop();
      assert(down.form.get('items[0][quantity]') === '3', 'seat count not synced on removal');
      const portal = await call(env, '/api/team/billing', { method: 'POST', cookie: admin.cookie, headers: origin, body: { id: team.id, action: 'portal' } });
      assert(portal.status === 200 && portal.body.url.startsWith('https://billing.stripe.com/'), JSON.stringify(portal.body));
      assert(stripe.calls.find((c) => c.path === '/v1/billing_portal/sessions').form.get('customer') === 'cus_1');
      const again = await call(env, '/api/team/billing', { method: 'POST', cookie: admin.cookie, headers: origin, body: { id: team.id, action: 'checkout' } });
      assert(again.status === 409, 'a paid team could open a second subscription');
    } finally { stripe.restore(); }
  });

  await t('a canceled subscription ends the plan: the next doc past 20 is refused, existing ones stay', async () => {
    const stripe = stubStripe();
    try {
      const { env, admin, team, fill } = await setup();
      stripe.subs.set('sub_2', subscription('sub_2', team.id, 1));
      await webhook(env, { type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_2', metadata: { team_id: team.id } } } });
      assert((await fill(21)).status === 200);
      assert((await webhook(env, { type: 'customer.subscription.deleted', data: { object: subscription('sub_2', team.id, 1, 'canceled') } })).status === 200);
      assert((await fill(1, 21)).status === 402, 'canceled plan still adds docs');
      const v2 = await call(env, '/api/upload', { method: 'POST', token: admin.token, body: { slug: 'doc-3', version: 2, html: '<p>still editable</p>' } });
      assert(v2.status === 200, 'existing doc no longer editable after cancel');
    } finally { stripe.restore(); }
  });

  await t('an event for a team tdoc does not know is acknowledged and ignored', async () => {
    const stripe = stubStripe();
    try {
      const { env } = await setup();
      const r = await webhook(env, { type: 'customer.subscription.updated', data: { object: subscription('sub_9', 't_missing', 2) } });
      const body = await r.json();
      assert(r.status === 200 && body.ignored === true, JSON.stringify(body));
    } finally { stripe.restore(); }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
