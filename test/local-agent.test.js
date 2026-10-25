// Local agents: a CLI (claude, codex) on the person's own computer, run by
// bin/tdoc-daemon. The worker side is a provider that QUEUES instead of
// pushing, a per-account pending index the daemon polls, and a last-seen
// stamp -- all of it bearer-authed with the account's upload token and
// scoped to that account.
//
// What this pins down:
//   - register / pending / fail take the upload token only, never a session
//   - a handoff to a local agent is "queued", recorded like any other, and
//     shows up in the owner's pending list and nobody else's
//   - ack keeps it pending (a crashed daemon retries), resolve and fail drop it,
//     resend queues it again
//   - the KV write budget: a poll writes nothing; the heartbeat at most once
//     per 10 minutes; registering twice writes nothing
//   - the picker and the Agents page list local agents with last-seen
//
// Run with: node test/local-agent.test.js

const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('local agents (tdoc-daemon)');

  // Count KV writes per key: the free plan allows 1000 a day, so what a poll
  // costs is part of the contract.
  function countWrites(env) {
    const counts = new Map();
    const put = env.META.put.bind(env.META);
    env.META.put = async (k, v, o) => { counts.set(k, (counts.get(k) || 0) + 1); return put(k, v, o); };
    return { total: () => [...counts.values()].reduce((a, b) => a + b, 0), of: (k) => counts.get(k) || 0, reset: () => counts.clear() };
  }

  async function seed(slug = 'local-doc') {
    const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
    const owner = await issue(worker, env, 'owner');
    const up = await worker.fetch(req('/api/upload', {
      method: 'POST', token: owner.token,
      body: { slug, version: 1, html: '<h1>doc</h1><p>a sentence to comment on</p>' },
    }), env, {});
    assert(up.status === 200, `upload ${up.status}`);
    const reader = await putSession(env, 'reader');
    const ids = [];
    for (const text of ['this is confusing', 'and this too']) {
      const posted = await worker.fetch(req('/api/comments', {
        method: 'POST', cookie: reader,
        body: { slug, version: 1, text, anchor: { kind: 'text', text: 'a sentence' } },
      }), env, {});
      assert(posted.status === 200, `comment ${posted.status}`);
      ids.push((await posted.json()).id);
    }
    return { env, owner, reader, slug, ids };
  }
  const call = async (env, path, opts) => {
    const r = await worker.fetch(req(path, opts), env, {});
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  const register = (env, token, body = { device: 'juliesmac', clis: ['claude', 'codex'] }) =>
    call(env, '/api/notify/local/register', { method: 'POST', token, body });
  const pending = (env, token, device = 'juliesmac') =>
    call(env, `/api/notify/local/pending?device=${device}`, { token });
  const comments = async (env, slug, cookie) => (await call(env, `/api/comments?slug=${slug}&version=1`, { cookie })).body;
  const LOCAL_CLAUDE = { provider: 'local', server_id: 'juliesmac', agent_sub: 'juliesmac_claude' };

  await t('register needs the account upload token: no session, no feedback token, no anonymous', async () => {
    const { env, owner } = await seed();
    const anon = await register(env, '');
    assert(anon.status === 401, `anonymous got ${anon.status}`);
    const r = await worker.fetch(req('/api/notify/local/register', { method: 'POST', cookie: owner.cookie, body: { device: 'x', clis: ['claude'] } }), env, {});
    assert(r.status === 401, `a browser session got ${r.status}`);
    const p = await worker.fetch(req('/api/notify/local/pending', { cookie: owner.cookie }), env, {});
    assert(p.status === 401, `pending with a session got ${p.status}`);
  });

  await t('register validates the device name and the CLI list', async () => {
    const { env, owner } = await seed();
    for (const body of [
      { device: 'Bad Name!', clis: ['claude'] },
      { device: '', clis: ['claude'] },
      { device: 'ok', clis: [] },
      { device: 'ok', clis: ['rm -rf'] },
      { device: 'ok', clis: ['a', 'b', 'c', 'd', 'e'].map((x) => x + '!') },
    ]) {
      const r = await register(env, owner.token, body);
      assert(r.status === 400, `${JSON.stringify(body)} accepted: ${r.status}`);
    }
    const r = await register(env, owner.token, { device: 'JuliesMac', clis: ['Claude', 'codex', 'claude'] });
    assert(r.status === 200 && r.body.ok, JSON.stringify(r.body));
    assert(r.body.device === 'juliesmac', 'device is lowercased');
    assert(r.body.targets.length === 2 && r.body.targets[0].agent_sub === 'juliesmac_claude', JSON.stringify(r.body.targets));
    assert(r.body.targets[0].agent_name === 'claude on juliesmac', r.body.targets[0].agent_name);
  });

  await t('registered CLIs appear on the Agents page as one connector per device, with last-seen', async () => {
    const { env, owner } = await seed();
    await register(env, owner.token);
    const list = (await call(env, '/api/me/connectors', { cookie: owner.cookie })).body;
    const local = list.connectors.filter((c) => c.kind === 'local');
    assert(local.length === 1 && local[0].device === 'juliesmac', JSON.stringify(list.connectors));
    assert(local[0].agents.map((a) => a.cli).join(',') === 'claude,codex', JSON.stringify(local[0].agents));
    assert(local[0].last_seen && local[0].agents[0].status === 'active', 'just registered: seen now, active');
    assert(list.available.some((a) => a.id === 'local' && a.ready), 'local is an available connector');
    assert(list.default && list.default.provider === 'local', 'the first agent an account has is its default');
  });

  await t('the picker offers local agents with their last-seen, and a daemon not heard from is inactive', async () => {
    const { env, owner, slug } = await seed();
    await register(env, owner.token);
    let targets = (await call(env, `/api/notify/targets?slug=${slug}`, { cookie: owner.cookie })).body;
    assert(targets.default && targets.default.provider === 'local' && targets.default.status === 'active', JSON.stringify(targets.default));
    assert(targets.default.last_seen, 'last_seen rides on the target');
    // 31 minutes of silence from the daemon.
    await env.META.put('local-agents-seen:' + owner.account_id, JSON.stringify({ juliesmac: new Date(Date.now() - 31 * 60000).toISOString() }));
    targets = (await call(env, `/api/notify/targets?slug=${slug}`, { cookie: owner.cookie })).body;
    assert(targets.default.status === 'inactive', `expected inactive, got ${targets.default.status}`);
  });

  await t('a handoff to a local agent is queued, not delivered, and lands in the owner pending list only', async () => {
    const { env, owner, reader, slug, ids } = await seed();
    await register(env, owner.token);
    const r = await call(env, '/api/notify/handoff', { method: 'POST', cookie: owner.cookie, body: { slug, comment_ids: ids, recipient: LOCAL_CLAUDE, instruction: 'tighten the intro' } });
    assert(r.status === 200 && r.body.ok, JSON.stringify(r.body));
    assert(r.body.delivery.status === 'queued' && !r.body.delivery.error, JSON.stringify(r.body.delivery));
    const [c] = await comments(env, slug, reader);
    assert(c.handoff_status === 'sent' && c.handoff_to.provider === 'local' && c.handoff_to.agent_name === 'claude on juliesmac', JSON.stringify(c.handoff_to));
    assert(c.handoff_delivery.status === 'queued', 'the card sees queued');

    const mine = await pending(env, owner.token);
    assert(mine.status === 200 && mine.body.pending.length === 1, JSON.stringify(mine.body));
    const h = mine.body.pending[0];
    assert(h.slug === slug && h.handoff_id === r.body.handoff_id, JSON.stringify(h));
    assert(h.comment_ids.length === 2 && h.instruction === 'tighten the intro', JSON.stringify(h));
    assert(h.url === `https://tdoc.dev/d/${slug}` && h.recipient.cli === 'claude' && h.recipient.device === 'juliesmac', JSON.stringify(h));
    assert(h.acked_at === null, 'not acked yet');

    const other = await issue(worker, env, 'other');
    const theirs = await pending(env, other.token);
    assert(theirs.status === 200 && theirs.body.pending.length === 0, 'another account sees nothing');
    const elsewhere = await pending(env, owner.token, 'otherbox');
    assert(elsewhere.body.pending.length === 0, 'a different device on the same account sees nothing');
    const all = await call(env, '/api/notify/local/pending', { token: owner.token });
    assert(all.body.pending.length === 1, 'no device filter lists everything');
  });

  await t('KV write budget: polling writes nothing; the heartbeat lands at most once per 10 minutes; re-registering writes nothing', async () => {
    const { env, owner, slug, ids } = await seed();
    const writes = countWrites(env);
    await register(env, owner.token);
    const seenKey = `local-agents-seen:${owner.account_id}`;
    assert(writes.of(seenKey) === 1, `first register stamps last-seen once, got ${writes.of(seenKey)}`);
    writes.reset();
    await register(env, owner.token);
    assert(writes.total() === 0, `registering again wrote ${writes.total()} keys`);
    await call(env, '/api/notify/handoff', { method: 'POST', cookie: owner.cookie, body: { slug, comment_ids: ids, recipient: LOCAL_CLAUDE } });
    writes.reset();
    for (let i = 0; i < 20; i++) await pending(env, owner.token);
    assert(writes.total() === 0, `20 polls within the heartbeat window wrote ${writes.total()} keys`);
    // Eleven minutes later, one poll writes exactly one key: the stamp.
    await env.META.put(seenKey, JSON.stringify({ juliesmac: new Date(Date.now() - 11 * 60000).toISOString() }));
    writes.reset();
    await pending(env, owner.token);
    await pending(env, owner.token);
    assert(writes.total() === 1 && writes.of(seenKey) === 1, `expected one heartbeat write, got ${writes.total()}`);
  });

  await t('ack keeps the handoff pending (a daemon that dies mid-run retries); resolve drops it', async () => {
    const { env, owner, reader, slug, ids } = await seed();
    await register(env, owner.token);
    const r = await call(env, '/api/notify/handoff', { method: 'POST', cookie: owner.cookie, body: { slug, comment_ids: ids, recipient: LOCAL_CLAUDE } });
    const hid = r.body.handoff_id;
    const ack = await call(env, '/api/notify/ack', { method: 'POST', token: owner.token, body: { slug, handoff_id: hid } });
    assert(ack.status === 200 && ack.body.acked_at, JSON.stringify(ack.body));
    let p = await pending(env, owner.token);
    assert(p.body.pending.length === 1 && p.body.pending[0].acked_at === ack.body.acked_at, 'still pending after ack, and says it was acked');
    let [c] = await comments(env, slug, reader);
    assert(c.handoff_acked_at === ack.body.acked_at, 'the card sees picked up');
    const done = await call(env, '/api/notify/resolve', { method: 'POST', token: owner.token, body: { slug, handoff_id: hid } });
    assert(done.status === 200 && done.body.resolved === 2, JSON.stringify(done.body));
    p = await pending(env, owner.token);
    assert(p.body.pending.length === 0, 'resolved handoffs leave the pending list');
    [c] = await comments(env, slug, reader);
    assert(c.handoff_status === 'resolved', `expected resolved, got ${c.handoff_status}`);
  });

  await t('a partial resolve stays pending until every comment is done', async () => {
    const { env, owner, slug, ids } = await seed();
    await register(env, owner.token);
    const r = await call(env, '/api/notify/handoff', { method: 'POST', cookie: owner.cookie, body: { slug, comment_ids: ids, recipient: LOCAL_CLAUDE } });
    await call(env, '/api/notify/resolve', { method: 'POST', token: owner.token, body: { slug, handoff_id: r.body.handoff_id, comment_ids: [ids[0]] } });
    assert((await pending(env, owner.token)).body.pending.length === 1, 'half done is still pending');
    await call(env, '/api/notify/resolve', { method: 'POST', token: owner.token, body: { slug, handoff_id: r.body.handoff_id, comment_ids: [ids[1]] } });
    assert((await pending(env, owner.token)).body.pending.length === 0, 'all done leaves the list');
  });

  await t('fail records a failed delivery the card can resend; resend queues it for the daemon again', async () => {
    const { env, owner, reader, slug, ids } = await seed();
    await register(env, owner.token);
    const r = await call(env, '/api/notify/handoff', { method: 'POST', cookie: owner.cookie, body: { slug, comment_ids: ids, recipient: LOCAL_CLAUDE } });
    const hid = r.body.handoff_id;
    const f = await call(env, '/api/notify/local/fail', { method: 'POST', token: owner.token, body: { slug, handoff_id: hid, error: 'exit 1' } });
    assert(f.status === 200 && f.body.delivery.status === 'failed' && f.body.delivery.error === 'agent_run_failed', JSON.stringify(f.body));
    assert((await pending(env, owner.token)).body.pending.length === 0, 'a failed run leaves the pending list');
    let [c] = await comments(env, slug, reader);
    assert(c.handoff_delivery.status === 'failed' && c.handoff_delivery.error === 'agent_run_failed', JSON.stringify(c.handoff_delivery));
    const stored = JSON.parse(await env.META.get(`handoffs:${slug}`)).find((h) => h.handoff_id === hid);
    assert(stored.run && stored.run.error === 'exit 1', 'the run detail is kept on the record');
    const again = await call(env, '/api/notify/handoff/resend', { method: 'POST', cookie: owner.cookie, body: { slug, handoff_id: hid } });
    assert(again.status === 200 && again.body.delivery.status === 'queued', JSON.stringify(again.body));
    const p = await pending(env, owner.token);
    assert(p.body.pending.length === 1 && p.body.pending[0].handoff_id === hid, 'resend puts it back for the daemon');
    [c] = await comments(env, slug, reader);
    assert(c.handoff_delivery.status === 'queued', 'the card is back to queued');
    assert(!JSON.parse(await env.META.get(`handoffs:${slug}`)).find((h) => h.handoff_id === hid).run, 'the old run detail is cleared');
  });

  await t('fail is for local handoffs only, and only for the doc owner', async () => {
    const { env, owner, slug, ids } = await seed();
    const raft = { provider: 'raft', server_id: 'S1', agent_sub: 'uuid-a', agent_name: 'xiaocc' };
    const r = await call(env, '/api/notify/handoff', { method: 'POST', cookie: owner.cookie, body: { slug, comment_ids: ids, recipient: raft } });
    const f = await call(env, '/api/notify/local/fail', { method: 'POST', token: owner.token, body: { slug, handoff_id: r.body.handoff_id, error: 'x' } });
    assert(f.status === 400 && f.body.error === 'not_a_local_handoff', JSON.stringify(f.body));
    const other = await issue(worker, env, 'other');
    const g = await call(env, '/api/notify/local/fail', { method: 'POST', token: other.token, body: { slug, handoff_id: r.body.handoff_id, error: 'x' } });
    assert(g.status === 403, `another account got ${g.status}`);
  });

  await t('a reply from the daemon-run CLI wears the local mark and takes the doc seat', async () => {
    const { env, owner, slug, ids } = await seed();
    await register(env, owner.token);
    const r = await worker.fetch(req('/api/agent/reply', {
      method: 'POST', token: owner.token, headers: { 'X-Tdoc-Agent': 'local/juliesmac/juliesmac_codex' },
      body: { slug, parent_id: ids[0], text: 'tightened', status: 'applied', agent_login: 'codex' },
    }), env, {});
    const body = await r.json();
    assert(r.status === 200 && body.author && body.author.provider === 'local', JSON.stringify(body.author));
    // No name of its own: the program and the computer, and whose token it is.
    assert(body.author.cli === 'codex' && !body.author.handle && body.author.location === 'juliesmac', JSON.stringify(body.author));
    assert(body.author.owner && body.author.owner.display === owner.login, JSON.stringify(body.author.owner));
    const targets = (await call(env, `/api/notify/targets?slug=${slug}`, { cookie: owner.cookie })).body;
    assert(targets.default.source === 'doc' && targets.default.cli === 'codex', `seat: ${JSON.stringify(targets.default)}`);
    const unknown = await worker.fetch(req('/api/agent/reply', {
      method: 'POST', token: owner.token, headers: { 'X-Tdoc-Agent': 'local/strangerbox/strangerbox_claude' },
      body: { slug, parent_id: ids[1], text: 'hi', status: 'applied', agent_login: 'claude' },
    }), env, {});
    const u = await unknown.json();
    assert(!(u.author && u.author.provider === 'local'), 'a device nobody registered cannot claim the mark');
  });

  await t('disconnecting a device stops it, starting the daemon again connects it', async () => {
    const { env, owner, slug } = await seed();
    await register(env, owner.token);
    const rm = await worker.fetch(new Request('https://tdoc.dev/api/me/connectors/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: owner.cookie, Origin: 'https://tdoc.dev' },
      body: JSON.stringify({ provider: 'local', server_id: 'juliesmac' }),
    }), env, {});
    const rmb = await rm.json();
    assert(rm.status === 200 && rmb.removed === 2, JSON.stringify(rmb));
    let targets = (await call(env, `/api/notify/targets?slug=${slug}`, { cookie: owner.cookie })).body;
    assert(!targets.default && targets.reason === 'no_agent_bound', JSON.stringify(targets));
    const list = (await call(env, '/api/me/connectors', { cookie: owner.cookie })).body;
    assert(!list.connectors.some((c) => c.kind === 'local'), 'gone from the Agents page');
    const back = await register(env, owner.token);
    assert(back.body.added === 2, 'registering after a disconnect adds them again');
    targets = (await call(env, `/api/notify/targets?slug=${slug}`, { cookie: owner.cookie })).body;
    assert(targets.default && targets.default.provider === 'local', 'and they are offered again');
  });

  // Who may make the owner's computer run. authorizeDocEdit admits more
  // callers than that (a feedback token of the owner's, a team member); a
  // site-mode space hands feedback tokens to visitors. Local is owner-only,
  // through a door tdoc controls.
  const home = { Origin: 'https://tdoc.dev' };
  const site = 'https://app.example.com';
  async function seedSite() {
    const w = await seed('site-doc');
    await register(w.env, w.owner.token);
    const bound = await call(w.env, '/api/feedback/site', { method: 'POST', cookie: w.owner.cookie, headers: home, body: { slug: w.slug, origins: [site], mode: 'public' } });
    assert(bound.status === 200, `bind ${bound.status} ${JSON.stringify(bound.body)}`);
    const visitor = await putSession(w.env, 'visitor');
    const vc = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: visitor, headers: home, body: { origin: site, space: w.slug } });
    assert(vc.status === 200 && vc.body.token, `visitor connect ${vc.status} ${JSON.stringify(vc.body)}`);
    const oc = await call(w.env, '/api/feedback/connect', { method: 'POST', cookie: w.owner.cookie, headers: home, body: { origin: site, space: w.slug } });
    assert(oc.status === 200 && oc.body.token, `owner connect ${oc.status}`);
    return { ...w, visitorToken: vc.body.token, ownerSiteToken: oc.body.token };
  }
  const sendLocal = (env, slug, ids, opts) => call(env, '/api/notify/handoff', { method: 'POST', ...opts, body: { slug, comment_ids: ids, recipient: LOCAL_CLAUDE } });

  await t('a visitor to the owner\'s public site cannot queue work for the owner\'s computer', async () => {
    const { env, slug, ids, visitorToken, owner } = await seedSite();
    const r = await sendLocal(env, slug, ids, { token: visitorToken });
    assert(r.status === 401 || r.status === 403, `visitor got ${r.status}: ${JSON.stringify(r.body)}`);
    const targets = await call(env, `/api/notify/targets?slug=${slug}`, { token: visitorToken });
    assert(targets.status !== 200 || !JSON.stringify(targets.body).includes('"local"'), `visitor sees local agents: ${JSON.stringify(targets.body)}`);
    assert((await pending(env, owner.token)).body.pending.length === 0, 'nothing reached the daemon');
  });

  await t('the owner\'s own site token and per-person feedback token are refused for local, and do not see local in the picker', async () => {
    const { env, slug, ids, ownerSiteToken, owner } = await seedSite();
    const r = await sendLocal(env, slug, ids, { token: ownerSiteToken });
    assert(r.status === 403 && r.body.error === 'local_agent_owner_only', `site token got ${r.status}: ${JSON.stringify(r.body)}`);
    let targets = (await call(env, `/api/notify/targets?slug=${slug}`, { token: ownerSiteToken })).body;
    assert(!targets.default && !(targets.candidates || []).length && targets.reason === 'no_agent_bound', `site token sees: ${JSON.stringify(targets)}`);
    // The per-person feedback token ("use an existing doc") on the same doc.
    const pc = await call(env, '/api/feedback/connect', { method: 'POST', cookie: owner.cookie, headers: home, body: { origin: 'https://other.example.com', slug } });
    assert(pc.status === 200 && pc.body.token, `personal connect ${pc.status} ${JSON.stringify(pc.body)}`);
    const p = await sendLocal(env, slug, ids, { token: pc.body.token });
    assert(p.status === 403 && p.body.error === 'local_agent_owner_only', `personal token got ${p.status}: ${JSON.stringify(p.body)}`);
    // Nothing a page can send picks local by default either.
    const noRecipient = await call(env, '/api/notify/handoff', { method: 'POST', token: pc.body.token, body: { slug, comment_ids: ids } });
    assert(noRecipient.status === 200 && noRecipient.body.delivery.status === 'failed' && noRecipient.body.delivery.error === 'no_recipient', `default routed to local: ${JSON.stringify(noRecipient.body)}`);
    assert((await pending(env, owner.token)).body.pending.length === 0, 'nothing reached the daemon');
  });

  await t('an invited editor who may read and comment, but does not own the doc, is refused', async () => {
    const { env, owner, slug, ids } = await seed('invited-doc');
    await register(env, owner.token);
    const share = await call(env, '/api/doc/access', { method: 'PATCH', cookie: owner.cookie, headers: home, body: { slug, access: { visibility: 'private', commenting: 'invited', allowed_users: ['editor'] } } });
    assert(share.status === 200, `share ${share.status} ${JSON.stringify(share.body)}`);
    const editor = await putSession(env, 'editor');
    const r = await sendLocal(env, slug, ids, { cookie: editor });
    assert(r.status === 401 || r.status === 403, `editor got ${r.status}: ${JSON.stringify(r.body)} (share ${share.status})`);
    const other = await issue(worker, env, 'editor');
    const viaToken = await sendLocal(env, slug, ids, { token: other.token });
    assert(viaToken.status === 403, `editor's own token got ${viaToken.status}`);
    assert((await pending(env, owner.token)).body.pending.length === 0, 'nothing reached the daemon');
  });

  await t('the owner is allowed, signed in or with their upload token, and the handoff records who queued it', async () => {
    const { env, owner, slug, ids } = await seed('owner-doc');
    await register(env, owner.token);
    const viaCookie = await sendLocal(env, slug, [ids[0]], { cookie: owner.cookie });
    assert(viaCookie.status === 200 && viaCookie.body.delivery.status === 'queued', `cookie: ${viaCookie.status} ${JSON.stringify(viaCookie.body)}`);
    const viaToken = await sendLocal(env, slug, [ids[1]], { token: owner.token });
    assert(viaToken.status === 200 && viaToken.body.delivery.status === 'queued', `token: ${viaToken.status} ${JSON.stringify(viaToken.body)}`);
    const p = (await pending(env, owner.token)).body;
    assert(p.pending.length === 2 && p.pending.every((h) => h.by === owner.account_id), `by: ${JSON.stringify(p.pending.map((h) => h.by))}`);
    assert(p.account_ids.includes(owner.account_id), 'the daemon is told which accounts count as itself');
    // A record that claims another sender never reaches a daemon.
    const stored = JSON.parse(await env.META.get(`handoffs:${slug}`));
    await env.META.put(`handoffs:${slug}`, JSON.stringify(stored.map((h, i) => (i === 0 ? { ...h, by: 'acct-forged' } : h))));
    const after = (await pending(env, owner.token)).body;
    assert(after.pending.length === 1 && after.pending[0].by === owner.account_id, 'a forged sender is dropped, not run');
  });

  await t('resend of a local handoff is owner-only too', async () => {
    const { env, owner, slug, ids, ownerSiteToken } = await seedSite();
    const sent = await sendLocal(env, slug, ids, { cookie: owner.cookie });
    const r = await call(env, '/api/notify/handoff/resend', { method: 'POST', token: ownerSiteToken, body: { slug, handoff_id: sent.body.handoff_id } });
    assert(r.status === 403 && r.body.error === 'local_agent_owner_only', `site token resend got ${r.status}`);
    const again = await call(env, '/api/notify/handoff/resend', { method: 'POST', cookie: owner.cookie, body: { slug, handoff_id: sent.body.handoff_id } });
    assert(again.status === 200 && again.body.delivery.status === 'queued', `owner resend ${again.status}`);
  });

  await t('a stale pending entry (handoff gone or finished elsewhere) is pruned on the next poll, once', async () => {
    const { env, owner, slug, ids } = await seed();
    await register(env, owner.token);
    const r = await call(env, '/api/notify/handoff', { method: 'POST', cookie: owner.cookie, body: { slug, comment_ids: ids, recipient: LOCAL_CLAUDE } });
    // The handoff record vanishes underneath the index (a doc deleted, say).
    await env.META.put(`handoffs:${slug}`, '[]');
    const writes = countWrites(env);
    let p = await pending(env, owner.token);
    assert(p.body.pending.length === 0 && writes.of(`local-pending:${owner.account_id}`) === 1, 'pruned with one write');
    writes.reset();
    p = await pending(env, owner.token);
    assert(writes.total() === 0, 'nothing left to prune, nothing written');
    assert(r.body.handoff_id, 'sanity');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
