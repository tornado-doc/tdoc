// A doc that changes workspace leaves behind whoever worked on it. Their agents
// stay on record (meta.notify_agents, a version's publisher_agent, the handoff
// log), and a person who no longer has the doc must get nothing from it: the
// event carries its title, slug, comment ids and instruction.
//
// What this pins down, through the worker's real routes with Raft stubbed at
// the network:
//   - team -> My docs: a member's agent is not offered, not the default, and
//     gets nothing from an unaddressed Send, a stale picker, or Resend
//   - a handoff queued to a member's daemon before the move is not handed out
//   - team -> another team and My docs -> team reach no one left behind
//   - the owner's own agents keep working, and a server they connected stays
//     theirs to pick from (the server is the trust boundary)
//   - version history keeps saying who wrote what
//   - a doc that already carries a stale entry needs no migration
//
// Run with: node test/doc-move-agents.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const RAFT_ENV = { PUBLIC_HOST: 'tdoc.dev', RAFT_CLIENT_ID: 'tdoc-test', RAFT_CLIENT_SECRET: 'sec', RAFT_API_BASE: 'https://api.raft.test' };
const raftAgent = (server, sub, name) => ({ provider: 'raft', server_id: `${server}-id`, server_slug: server, agent_sub: sub, agent_name: name });
const BEN_AGENT = raftAgent('bens-server', 'ben-agent', 'benny');
const ANN_AGENT = raftAgent('anns-server', 'ann-agent', 'annie');
const ORIGIN = { Origin: 'https://tdoc.dev' };

(async () => {
  console.log('agents left behind when a doc changes workspace');
  const mod = await loadWorker();
  const worker = mod.default;
  const realFetch = globalThis.fetch;

  // Every Raft request the worker makes, by the server it addresses.
  let raftCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (!url.startsWith('https://api.raft.test')) return realFetch(input, init);
    const body = init && init.body ? JSON.parse(init.body) : null;
    raftCalls.push({ url, body });
    if (url.endsWith('/api/oauth/requests/agent')) return Response.json({ requestId: 'rq', agent: { serverId: 'x' } });
    if (url.endsWith('/api/oauth/token')) return Response.json({ access_token: 'at' });
    if (url.endsWith('/api/oauth/agent-events')) return Response.json({ id: 'ev', status: 'queued' });
    return Response.json({ agents: [] });
  };
  const addressed = () => raftCalls.filter((c) => c.url.endsWith('/api/oauth/requests/agent')).map((c) => c.body.serverSlug);
  const events = () => raftCalls.filter((c) => c.url.endsWith('/api/oauth/agent-events')).map((c) => c.body);

  async function world() {
    raftCalls = [];
    const env = makeEnv(mod.CommentsStore, RAFT_ENV);
    const call = async (path, opts) => {
      const r = await worker.fetch(req(path, opts), env, { waitUntil() {}, passThroughOnException() {} });
      const text = await r.text();
      let body = null; try { body = JSON.parse(text); } catch {}
      return { status: r.status, body, text };
    };
    const ann = await issue(worker, env, 'ann');
    const ben = await issue(worker, env, 'ben');
    // Linked the way a person links one: a code from signing in with Raft,
    // redeemed with their upload token.
    const link = async (who, agent) => {
      const code = `code-${who.account_id}-${agent.agent_sub}`;
      await env.META.put(`raft-link:${code}`, JSON.stringify(agent));
      const r = await call('/api/notify/link', { method: 'POST', token: who.token, body: { link_code: code } });
      assert(r.status === 200, `link: ${r.text}`);
    };
    await link(ben, BEN_AGENT);
    await link(ann, ANN_AGENT);
    // Ann runs the team: only an admin moves a doc out of one. Ben is a member,
    // whose agent may work on its docs.
    const team = (await call('/api/teams', { method: 'POST', cookie: ann.cookie, headers: ORIGIN, body: { name: 'Acme' } })).body.team;
    const joined = await call('/api/team/join', { method: 'POST', cookie: ben.cookie, body: { token: team.invite_url.split('/').pop() } });
    assert(joined.status === 200, `join: ${joined.text}`);
    // An admin may also send a team doc to their own agents.
    const promoteBen = async () => {
      const stored = JSON.parse(await env.META.get(`team:${team.id}`));
      stored.members.find((m) => m.account_id === ben.account_id).role = 'admin';
      await env.META.put(`team:${team.id}`, JSON.stringify(stored));
    };
    const upload = async (who, slug, version, headers = {}) => {
      const r = await call('/api/upload', { method: 'POST', token: who.token, headers, body: { slug, version, html: `<h1>${slug}</h1><p>a sentence to comment on</p>`, meta: { title: `Ann private ${slug}` } } });
      assert(r.status === 200, `upload ${slug} v${version}: ${r.text}`);
    };
    const comment = async (who, slug) => {
      const r = await call('/api/comments', { method: 'POST', cookie: who.cookie, headers: ORIGIN, body: { slug, version: 1, text: 'please look', anchor: { kind: 'text', text: 'a sentence' } } });
      assert(r.status === 200, `comment: ${r.text}`);
      return r.body.id;
    };
    const move = async (who, slug, teamId) => {
      const r = await call('/api/team/move', { method: 'POST', cookie: who.cookie, headers: ORIGIN, body: { team: teamId, slugs: [slug] } });
      assert(r.status === 200, `move: ${r.text}`);
    };
    const meta = async (slug) => JSON.parse(await env.META.get(`meta:${slug}`));
    const claim = (agent) => ({ 'X-Tdoc-Raft-Agent': `${agent.server_id}/${agent.agent_sub}` });
    const targets = async (who, slug) => {
      const r = await call(`/api/notify/targets?slug=${slug}`, { cookie: who.cookie });
      assert(r.status === 200, `targets: ${r.text}`);
      return r.body;
    };
    const rows = (body) => [body.default, ...(body.candidates || []), body.fallback].filter(Boolean);
    const send = (who, slug, ids, recipient) => call('/api/notify/handoff', { method: 'POST', cookie: who.cookie, headers: ORIGIN, body: { slug, comment_ids: ids, ...(recipient ? { recipient } : {}) } });

    // Ann's doc, moved into the team; written last by a person, so that a
    // member's agent may work on it.
    async function teamDoc(slug) {
      await upload(ann, slug, 1);
      await move(ann, slug, team.id);
      const m = await meta(slug);
      const last = m.versions[m.versions.length - 1];
      delete last.by;
      last.source = 'browser';
      last.author = 'ann';
      await env.META.put(`meta:${slug}`, JSON.stringify(m));
    }
    // Ben's agent does the work on it: publishes a version, answers a comment.
    async function benWorksOn(slug) {
      await upload(ben, slug, 2, claim(BEN_AGENT));
      const c = await comment(ben, slug);
      const r = await call('/api/agent/reply', { method: 'POST', token: ben.token, headers: claim(BEN_AGENT), body: { slug, parent_id: c, text: 'on it', status: 'answered', agent_login: 'claude' } });
      assert(r.status === 200, `ben's reply: ${r.text}`);
    }
    return { env, call, ann, ben, team, link, upload, comment, move, meta, claim, targets, rows, send, teamDoc, benWorksOn, promoteBen };
  }

  await t('the setup is the reported one: on the team doc Ben\'s agent is on record', async () => {
    const w = await world();
    await w.teamDoc('plan');
    await w.benWorksOn('plan');
    const m = await w.meta('plan');
    assert(m.notify_agents.some((a) => a.agent_sub === BEN_AGENT.agent_sub), 'in notify_agents');
    assert(m.versions.at(-1).publisher_agent.agent_sub === BEN_AGENT.agent_sub && m.versions.at(-1).by === w.ben.account_id, 'on the version');
  });

  await t('team -> My docs: Ann\'s next Send reaches nobody of Ben\'s', async () => {
    const w = await world();
    await w.teamDoc('plan');
    await w.benWorksOn('plan');
    await w.move(w.ann, 'plan', null);
    const c = await w.comment(w.ann, 'plan');
    raftCalls = [];
    const r = await w.send(w.ann, 'plan', [c]);
    assert(r.status === 200, r.text);
    assert(!addressed().includes('bens-server'), `Ben's server was addressed; event: ${JSON.stringify(events())}`);
    assert(!events().length, `nothing is preselected, so nothing is sent: ${JSON.stringify(events())}`);
  });

  await t('team -> My docs: Ben\'s agent is neither the default nor offered; Ann\'s own is', async () => {
    const w = await world();
    await w.teamDoc('plan');
    await w.benWorksOn('plan');
    await w.move(w.ann, 'plan', null);
    const body = await w.targets(w.ann, 'plan');
    assert(!w.rows(body).some((t) => t.agent_sub === BEN_AGENT.agent_sub), `offered: ${JSON.stringify(body)}`);
    assert(w.rows(body).some((t) => t.agent_sub === ANN_AGENT.agent_sub), `Ann's own agent is still there: ${JSON.stringify(body)}`);
    const mine = await w.call('/api/docs/plan/my-agent', { cookie: w.ann.cookie });
    assert(!(mine.body.agents || []).some((t) => t.agent_sub === BEN_AGENT.agent_sub), `@ list: ${mine.text}`);
  });

  await t('team -> My docs: a picker opened before the move cannot send to Ben', async () => {
    const w = await world();
    await w.teamDoc('plan');
    await w.benWorksOn('plan');
    await w.move(w.ann, 'plan', null);
    const c = await w.comment(w.ann, 'plan');
    raftCalls = [];
    const r = await w.send(w.ann, 'plan', [c], BEN_AGENT);
    assert(r.status === 409 && r.body.error === 'agent_left_doc', `${r.status} ${r.text}`);
    assert(!addressed().length, `addressed ${addressed()}`);
  });

  await t('team -> My docs: Resend does not reach an agent the team sent to', async () => {
    const w = await world();
    await w.teamDoc('plan');
    await w.promoteBen();
    await w.benWorksOn('plan');
    const c = await w.comment(w.ben, 'plan');
    const sent = await w.send(w.ben, 'plan', [c], BEN_AGENT);
    assert(sent.status === 200 && sent.body.delivery.status === 'delivered', sent.text);
    await w.move(w.ann, 'plan', null);
    raftCalls = [];
    const r = await w.call('/api/notify/handoff/resend', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { slug: 'plan', handoff_id: sent.body.handoff_id } });
    assert(r.status === 409 && r.body.error === 'agent_left_doc', `${r.status} ${r.text}`);
    assert(!addressed().length, `addressed ${addressed()}`);
  });

  await t('team -> My docs: a handoff queued to a member\'s daemon is not handed out after the move', async () => {
    const w = await world();
    await w.teamDoc('plan');
    await w.promoteBen();
    const reg = await w.call('/api/notify/local/register', { method: 'POST', token: w.ben.token, body: { device: 'benbox', clis: ['claude'] } });
    assert(reg.status === 200, reg.text);
    const local = { provider: 'local', device: 'benbox', cli: 'claude', server_id: 'benbox', agent_sub: 'benbox_claude' };
    await w.upload(w.ben, 'plan', 2, { 'X-Tdoc-Agent': 'local/benbox/benbox_claude' });
    const c = await w.comment(w.ben, 'plan');
    const sent = await w.send(w.ben, 'plan', [c], local);
    assert(sent.status === 200, sent.text);
    const before = await w.call('/api/notify/local/pending', { token: w.ben.token });
    assert(before.body.pending.some((p) => p.slug === 'plan'), `queued while it was the team's: ${before.text}`);
    await w.move(w.ann, 'plan', null);
    const after = await w.call('/api/notify/local/pending', { token: w.ben.token });
    assert(after.status === 200 && !after.body.pending.some((p) => p.slug === 'plan'), `still handed out: ${after.text}`);
    const seen = await w.call('/api/notify/handoffs?slug=plan', { cookie: w.ann.cookie });
    const card = seen.body.handoffs.find((h) => h.handoff_id === sent.body.handoff_id);
    assert(card && card.delivery.status === 'failed' && card.delivery.error === 'access_lost', `Ann's card: ${seen.text}`);
  });

  await t('team -> another team: Ben\'s agent is not offered and gets nothing', async () => {
    const w = await world();
    await w.teamDoc('plan');
    await w.benWorksOn('plan');
    const other = (await w.call('/api/teams', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { name: 'Other' } })).body.team;
    await w.move(w.ann, 'plan', other.id);
    const body = await w.targets(w.ann, 'plan');
    assert(!w.rows(body).some((t) => t.agent_sub === BEN_AGENT.agent_sub), `offered: ${JSON.stringify(body)}`);
    const c = await w.comment(w.ann, 'plan');
    raftCalls = [];
    await w.send(w.ann, 'plan', [c]);
    const named = await w.send(w.ann, 'plan', [c], BEN_AGENT);
    assert(named.status !== 200 || named.body.delivery.error === 'no_recipient', `named Ben's agent: ${named.status} ${named.text}`);
    assert(!addressed().includes('bens-server'), `addressed ${addressed()}`);
  });

  await t('My docs -> team: a member gets no way to Ann\'s own agent', async () => {
    const w = await world();
    await w.upload(w.ann, 'mine', 1, w.claim(ANN_AGENT));
    assert((await w.meta('mine')).notify_agents.some((a) => a.agent_sub === ANN_AGENT.agent_sub), 'Ann\'s agent is on her doc');
    await w.move(w.ann, 'mine', w.team.id);
    const body = await w.call('/api/notify/targets?slug=mine', { cookie: w.ben.cookie });
    assert(!w.rows(body.body).some((t) => t.agent_sub === ANN_AGENT.agent_sub), `offered to Ben: ${body.text}`);
    await w.promoteBen();
    const c = await w.comment(w.ben, 'mine');
    raftCalls = [];
    await w.send(w.ben, 'mine', [c]);
    await w.send(w.ben, 'mine', [c], ANN_AGENT);
    assert(!addressed().includes('anns-server'), `addressed ${addressed()}`);
  });

  await t('an admin moving a member\'s team doc out: it is the member\'s, and the admin\'s agent is gone from it', async () => {
    const w = await world();
    await w.upload(w.ben, 'bens', 1, w.claim(BEN_AGENT));
    const m = await w.call('/api/team/move', { method: 'POST', token: w.ben.token, body: { team: w.team.id, slugs: ['bens'] } });
    assert(m.status === 200, m.text);
    const stored = await w.meta('bens');
    stored.versions.at(-1).source = 'browser';
    delete stored.versions.at(-1).by;
    await w.env.META.put('meta:bens', JSON.stringify(stored));
    await w.upload(w.ann, 'bens', 2, w.claim(ANN_AGENT));
    await w.move(w.ann, 'bens', null);
    const body = await w.targets(w.ben, 'bens');
    assert(!w.rows(body).some((t) => t.agent_sub === ANN_AGENT.agent_sub), `offered to Ben: ${JSON.stringify(body)}`);
    assert(w.rows(body).some((t) => t.agent_sub === BEN_AGENT.agent_sub), `Ben's own agent is offered: ${JSON.stringify(body)}`);
    const c = await w.comment(w.ben, 'bens');
    raftCalls = [];
    await w.send(w.ben, 'bens', [c]);
    assert(!addressed().length, `nothing preselected, nothing sent: ${addressed()}`);
    const r = await w.send(w.ben, 'bens', [c], BEN_AGENT);
    assert(r.body.delivery.status === 'delivered' && addressed().join() === 'bens-server', `${r.text} ${addressed()}`);
  });

  await t('there and back: Ann\'s own agent still follows her doc', async () => {
    const w = await world();
    await w.upload(w.ann, 'mine', 1, w.claim(ANN_AGENT));
    await w.move(w.ann, 'mine', w.team.id);
    await w.move(w.ann, 'mine', null);
    const body = await w.targets(w.ann, 'mine');
    assert(body.default && body.default.agent_sub === ANN_AGENT.agent_sub, `default: ${JSON.stringify(body)}`);
    const c = await w.comment(w.ann, 'mine');
    raftCalls = [];
    const r = await w.send(w.ann, 'mine', [c]);
    assert(r.body.delivery.status === 'delivered' && addressed().join() === 'anns-server', `${r.text} ${addressed()}`);
    assert(events()[0].payload.slug === 'mine', JSON.stringify(events()));
  });

  await t('a server Ann connected herself stays hers to pick from, but its agent is no default of Ben\'s work', async () => {
    const w = await world();
    await w.teamDoc('plan');
    await w.benWorksOn('plan');
    await w.link(w.ann, { ...BEN_AGENT, agent_sub: 'ann-on-bens-server', agent_name: 'annie2' });
    await w.move(w.ann, 'plan', null);
    const body = await w.targets(w.ann, 'plan');
    assert(!body.default || body.default.agent_sub !== BEN_AGENT.agent_sub, `default: ${JSON.stringify(body.default)}`);
    assert(w.rows(body).some((t) => t.agent_sub === BEN_AGENT.agent_sub), 'on a server she connected, she may pick it');
    const c = await w.comment(w.ann, 'plan');
    raftCalls = [];
    const r = await w.send(w.ann, 'plan', [c], BEN_AGENT);
    assert(r.status === 200 && r.body.delivery.status === 'delivered', r.text);
  });

  await t('Ben\'s work does not count as Ann\'s agent having been used here', async () => {
    const w = await world();
    await w.teamDoc('plan');
    // Two people's computers can share a name, so the target alone reads alike.
    for (const who of [w.ann, w.ben]) {
      const reg = await w.call('/api/notify/local/register', { method: 'POST', token: who.token, body: { device: 'macbook', clis: ['claude'] } });
      assert(reg.status === 200, reg.text);
    }
    await w.upload(w.ben, 'plan', 2, { 'X-Tdoc-Agent': 'local/macbook/macbook_claude' });
    assert((await w.meta('plan')).versions.at(-1).publisher_agent, 'Ben\'s version names his computer');
    await w.move(w.ann, 'plan', null);
    // The doc's record of it stays; this is about what it says to Ann.
    const m = await w.meta('plan');
    m.notify_agents = (m.notify_agents || []).filter((a) => a.provider !== 'local');
    await w.env.META.put('meta:plan', JSON.stringify(m));
    const body = await w.targets(w.ann, 'plan');
    const own = w.rows(body).find((t) => t.agent_sub === 'macbook_claude');
    assert(own && !own.used_here_at, `used_here_at from Ben's version: ${JSON.stringify(own)}`);
    assert(!own.last_writer, `last_writer from Ben's version: ${JSON.stringify(own)}`);
  });

  await t('version history keeps who wrote what; the move writes nothing new about agents', async () => {
    const w = await world();
    await w.teamDoc('plan');
    await w.benWorksOn('plan');
    const before = await w.meta('plan');
    await w.move(w.ann, 'plan', null);
    const c = await w.comment(w.ann, 'plan');
    await w.send(w.ann, 'plan', [c]);
    const after = await w.meta('plan');
    assert(JSON.stringify(after.versions) === JSON.stringify(before.versions), 'versions changed');
    const v2 = after.versions.find((v) => Number(v.n) === 2);
    assert(v2.by === w.ben.account_id && v2.publisher_agent.agent_sub === BEN_AGENT.agent_sub, JSON.stringify(v2));
  });

  await t('an old personal doc already carrying a stale entry is covered without a migration', async () => {
    const w = await world();
    await w.upload(w.ann, 'old', 1);
    const m = await w.meta('old');
    m.notify_agents = [{ ...BEN_AGENT, last_touched: new Date().toISOString() }];
    await w.env.META.put('meta:old', JSON.stringify(m));
    const body = await w.targets(w.ann, 'old');
    assert(!w.rows(body).some((t) => t.agent_sub === BEN_AGENT.agent_sub), JSON.stringify(body));
    const c = await w.comment(w.ann, 'old');
    raftCalls = [];
    await w.send(w.ann, 'old', [c]);
    assert(!addressed().includes('bens-server'), `addressed ${addressed()}`);
  });

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
