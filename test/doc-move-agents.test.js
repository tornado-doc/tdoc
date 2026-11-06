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
  const { composerDefault } = await import('../shell/src/document/agent-choices.js');
  const realFetch = globalThis.fetch;

  // Every Raft request the worker makes, by the server it addresses.
  let raftCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input && input.url ? input.url : input);
    if (new URL(url).host !== 'api.raft.test') return realFetch(input, init);
    const body = init && init.body ? JSON.parse(init.body) : null;
    raftCalls.push({ url, body });
    if (url.endsWith('/api/oauth/requests/agent')) return Response.json({ requestId: 'rq', agent: { serverId: 'x' } });
    if (url.endsWith('/api/oauth/token')) return Response.json({ access_token: 'at' });
    if (url.endsWith('/api/oauth/agent-events')) return Response.json({ id: 'ev', status: 'queued' });
    return Response.json({});
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
    // Ann connects Ben's Raft server. Its directory lists every agent on it.
    async function shareBensServer() {
      await env.META.put(`account-raft-servers:${ann.account_id}`, JSON.stringify([{ server_id: BEN_AGENT.server_id, server_slug: BEN_AGENT.server_slug, installation_id: 'inst' }]));
      await env.META.put(`raft-directory:${BEN_AGENT.server_id}`, JSON.stringify([BEN_AGENT]));
    }
    // A comment on Ann's feedback space, through a token a page could hold.
    async function feedbackComment() {
      const made = await call('/api/feedback/connect', { method: 'POST', cookie: ann.cookie, headers: ORIGIN, body: { origin: 'https://app.example' } });
      assert(made.status === 200 && made.body.token, made.text);
      const { slug, token } = made.body;
      const anchor = { kind: 'product', url: 'https://app.example/', selector: '#x', tag: 'div', text: 'x' };
      const c = await call('/api/comments', { method: 'POST', token, body: { slug, version: 1, text: 'fix', anchor } });
      assert(c.status === 200, c.text);
      return { slug, token, commentId: c.body.id };
    }
    // A team doc Ben's daemon has work queued on.
    async function benQueuesToHisDaemon(slug) {
      await teamDoc(slug);
      await promoteBen();
      const reg = await call('/api/notify/local/register', { method: 'POST', token: ben.token, body: { device: 'benbox', clis: ['claude'] } });
      assert(reg.status === 200, reg.text);
      await upload(ben, slug, 2, { 'X-Tdoc-Agent': 'local/benbox/benbox_claude' });
      const c = await comment(ben, slug);
      const sent = await send(ben, slug, [c], { provider: 'local', device: 'benbox', cli: 'claude', server_id: 'benbox', agent_sub: 'benbox_claude' });
      assert(sent.status === 200, sent.text);
      return sent;
    }
    return { env, call, ann, ben, team, link, upload, comment, move, meta, claim, targets, rows, send, teamDoc, benWorksOn, promoteBen, shareBensServer, feedbackComment, benQueuesToHisDaemon };
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

  await t('a Resend from before handoffs named their sender is covered too', async () => {
    const w = await world();
    await w.teamDoc('plan');
    await w.promoteBen();
    await w.upload(w.ben, 'plan', 2, w.claim(BEN_AGENT));
    const c = await w.comment(w.ben, 'plan');
    const sent = await w.send(w.ben, 'plan', [c], BEN_AGENT);
    assert(sent.status === 200, sent.text);
    await w.move(w.ann, 'plan', null);
    // No other record mentions the agent, and the handoff names no sender.
    const m = await w.meta('plan');
    delete m.notify_agents;
    for (const v of m.versions) { delete v.by; delete v.publisher_agent; }
    await w.env.META.put('meta:plan', JSON.stringify(m));
    const list = JSON.parse(await w.env.META.get('handoffs:plan'));
    for (const h of list) delete h.by;
    await w.env.META.put('handoffs:plan', JSON.stringify(list));
    raftCalls = [];
    const r = await w.call('/api/notify/handoff/resend', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { slug: 'plan', handoff_id: sent.body.handoff_id } });
    assert(r.status === 409 && r.body.error === 'agent_left_doc', `${r.status} ${r.text}`);
    assert(!addressed().length, `addressed ${addressed()}`);
  });

  await t('a team that cannot be read for one poll fails nothing queued', async () => {
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
    const realGet = w.env.META.get.bind(w.env.META);
    let reads = 0;
    w.env.META.get = async (key, ...rest) => {
      if (key === `team:${w.team.id}` && !reads++) throw new Error('KV hiccup');
      return realGet(key, ...rest);
    };
    await w.call('/api/notify/local/pending', { token: w.ben.token });
    w.env.META.get = realGet;
    assert(reads > 0, 'the poll read the team');
    const after = await w.call('/api/notify/local/pending', { token: w.ben.token });
    assert(after.body.pending.some((p) => p.handoff_id === sent.body.handoff_id), `lost: ${after.text}`);
    const list = JSON.parse(await realGet('handoffs:plan'));
    assert(list.find((h) => h.handoff_id === sent.body.handoff_id).delivery.status !== 'failed', 'marked failed');
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
    // Raft's directory of that server lists every agent on it, whoever's.
    await w.env.META.put(`account-raft-servers:${w.ann.account_id}`, JSON.stringify([{ server_id: BEN_AGENT.server_id, server_slug: BEN_AGENT.server_slug, installation_id: 'inst' }]));
    await w.env.META.put(`raft-directory:${BEN_AGENT.server_id}`, JSON.stringify([BEN_AGENT]));
    await w.move(w.ann, 'plan', null);
    const body = await w.targets(w.ann, 'plan');
    assert(!body.default || body.default.agent_sub !== BEN_AGENT.agent_sub, `default: ${JSON.stringify(body.default)}`);
    // The row the composer means by default is its own reading of these rows.
    const row = w.rows(body).find((t) => t.agent_sub === BEN_AGENT.agent_sub);
    assert(row && row.source === 'directory', `on a server she connected, an ordinary row she may pick: ${JSON.stringify(row)}`);
    assert(!row.used_here_at && !row.last_writer && !row.last_touched, `no claim on her: ${JSON.stringify(row)}`);
    const top = composerDefault(w.rows(body).map((t) => ({ ...t, can_edit: true })), { evidence: body.default });
    assert(!top || top.agent_sub !== BEN_AGENT.agent_sub, `composer default: ${JSON.stringify(top)}`);
    const orTop = composerDefault(w.rows(body).map((t) => ({ ...t, can_edit: true })), { orTop: true });
    assert(orTop && orTop.agent_sub !== BEN_AGENT.agent_sub, `feedback surface default: ${JSON.stringify(orTop)}`);
    const c = await w.comment(w.ann, 'plan');
    raftCalls = [];
    const r = await w.send(w.ann, 'plan', [c], BEN_AGENT);
    assert(r.status === 200 && r.body.delivery.status === 'delivered', r.text);
  });

  await t('a handoff from before they named a sender recommends nobody on a shared server', async () => {
    const w = await world();
    await w.teamDoc('plan');
    await w.promoteBen();
    await w.upload(w.ben, 'plan', 2, w.claim(BEN_AGENT));
    const c = await w.comment(w.ben, 'plan');
    const sent = await w.send(w.ben, 'plan', [c], BEN_AGENT);
    assert(sent.status === 200, sent.text);
    await w.link(w.ann, { ...BEN_AGENT, agent_sub: 'ann-on-bens-server', agent_name: 'annie2' });
    await w.env.META.put(`account-raft-servers:${w.ann.account_id}`, JSON.stringify([{ server_id: BEN_AGENT.server_id, server_slug: BEN_AGENT.server_slug, installation_id: 'inst' }]));
    await w.env.META.put(`raft-directory:${BEN_AGENT.server_id}`, JSON.stringify([BEN_AGENT]));
    await w.move(w.ann, 'plan', null);
    const list = JSON.parse(await w.env.META.get('handoffs:plan'));
    for (const h of list) delete h.by;
    await w.env.META.put('handoffs:plan', JSON.stringify(list));
    const body = await w.targets(w.ann, 'plan');
    assert(!body.default, `default: ${JSON.stringify(body.default)}`);
    assert(!w.rows(body).find((t) => t.agent_sub === BEN_AGENT.agent_sub).used_here_at, 'used here');
    const d = await w.comment(w.ann, 'plan');
    raftCalls = [];
    await w.send(w.ann, 'plan', [d]);
    assert(!addressed().length, `addressed ${addressed()}`);
  });

  await t('Ann\'s own agent pushed off her account list still follows the doc it published', async () => {
    const w = await world();
    await w.upload(w.ann, 'mine', 1, w.claim(ANN_AGENT));
    // Nine newer connections: the list keeps eight.
    for (let i = 0; i < 9; i++) await w.link(w.ann, raftAgent(`srv${i}`, `a${i}`, `n${i}`));
    const stored = JSON.parse(await w.env.META.get(`account-notify:${w.ann.account_id}`));
    assert(!stored.some((t) => t.agent_sub === ANN_AGENT.agent_sub), 'off the list');
    const body = await w.targets(w.ann, 'mine');
    assert(body.default && body.default.agent_sub === ANN_AGENT.agent_sub, `default: ${JSON.stringify(body.default)}`);
    const c = await w.comment(w.ann, 'mine');
    raftCalls = [];
    const r = await w.send(w.ann, 'mine', [c]);
    assert(r.body.delivery.status === 'delivered' && addressed().join() === 'anns-server', `${r.text} ${addressed()}`);
    const again = await w.call('/api/notify/handoff/resend', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { slug: 'mine', handoff_id: r.body.handoff_id } });
    assert(again.status === 200, again.text);
  });

  await t('a server Ann disconnected gets nothing, though her own version names its agent', async () => {
    const w = await world();
    await w.upload(w.ann, 'mine', 1, w.claim(ANN_AGENT));
    const c = await w.comment(w.ann, 'mine');
    const sent = await w.send(w.ann, 'mine', [c]);
    assert(sent.body.delivery.status === 'delivered', sent.text);
    const off = await w.call('/api/me/connectors/remove', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { provider: 'raft', server_id: ANN_AGENT.server_id } });
    assert(off.status === 200, off.text);
    raftCalls = [];
    const again = await w.call('/api/notify/handoff/resend', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { slug: 'mine', handoff_id: sent.body.handoff_id } });
    assert(again.status === 409 && again.body.error === 'agent_left_doc', `Resend ${again.status} ${again.text}`);
    const picked = await w.send(w.ann, 'mine', [c], ANN_AGENT);
    assert(picked.status === 409 && picked.body.error === 'agent_left_doc', `stale picker ${picked.status} ${picked.text}`);
    const body = await w.targets(w.ann, 'mine');
    assert(!w.rows(body).some((t) => t.agent_sub === ANN_AGENT.agent_sub), `offered: ${JSON.stringify(body)}`);
    assert(!addressed().length, `addressed ${addressed()}`);
  });

  await t('a stale picker cannot reach a disconnected agent only Ann\'s own records mention', async () => {
    const w = await world();
    await w.upload(w.ann, 'mine', 1, w.claim(ANN_AGENT));
    const m = await w.meta('mine');
    delete m.notify_agents;
    await w.env.META.put('meta:mine', JSON.stringify(m));
    await w.call('/api/me/connectors/remove', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { provider: 'raft', server_id: ANN_AGENT.server_id } });
    const c = await w.comment(w.ann, 'mine');
    raftCalls = [];
    const picked = await w.send(w.ann, 'mine', [c], ANN_AGENT);
    assert(picked.status === 409 && picked.body.error === 'agent_left_doc', `${picked.status} ${picked.text}`);
    assert(!addressed().length, `addressed ${addressed()}`);
  });

  await t('Resend of Ann\'s own handoff, after she disconnected and moved the doc into a team, is refused', async () => {
    const w = await world();
    await w.upload(w.ann, 'mine', 1, w.claim(ANN_AGENT));
    const c = await w.comment(w.ann, 'mine');
    const sent = await w.send(w.ann, 'mine', [c]);
    assert(sent.body.delivery.status === 'delivered', sent.text);
    await w.call('/api/me/connectors/remove', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { provider: 'raft', server_id: ANN_AGENT.server_id } });
    await w.move(w.ann, 'mine', w.team.id);
    raftCalls = [];
    const again = await w.call('/api/notify/handoff/resend', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { slug: 'mine', handoff_id: sent.body.handoff_id } });
    assert(again.status === 409 && again.body.error === 'agent_left_doc', `${again.status} ${again.text}`);
    assert(!addressed().length, `addressed ${addressed()}`);
  });

  await t('on a shared server, pressing Resend on a team-era card does not make Ben\'s agent Ann\'s', async () => {
    const w = await world();
    await w.teamDoc('plan');
    await w.promoteBen();
    await w.upload(w.ben, 'plan', 2, w.claim(BEN_AGENT));
    const c = await w.comment(w.ben, 'plan');
    const sent = await w.send(w.ben, 'plan', [c], BEN_AGENT);
    assert(sent.status === 200, sent.text);
    await w.link(w.ann, { ...BEN_AGENT, agent_sub: 'ann-on-bens-server', agent_name: 'annie2' });
    await w.move(w.ann, 'plan', null);
    const again = await w.call('/api/notify/handoff/resend', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { slug: 'plan', handoff_id: sent.body.handoff_id } });
    assert(again.status === 200, again.text);
    const body = await w.targets(w.ann, 'plan');
    assert(!body.default || body.default.agent_sub !== BEN_AGENT.agent_sub, `default: ${JSON.stringify(body.default)}`);
    const d = await w.comment(w.ann, 'plan');
    raftCalls = [];
    await w.send(w.ann, 'plan', [d]);
    assert(!addressed().includes('bens-server'), `addressed ${addressed()}`);
  });

  await t('team -> another team: a handoff queued to a daemon whose account stayed behind is not handed out', async () => {
    const w = await world();
    await w.teamDoc('plan');
    await w.promoteBen();
    const reg = await w.call('/api/notify/local/register', { method: 'POST', token: w.ben.token, body: { device: 'benbox', clis: ['claude'] } });
    assert(reg.status === 200, reg.text);
    await w.upload(w.ben, 'plan', 2, { 'X-Tdoc-Agent': 'local/benbox/benbox_claude' });
    const c = await w.comment(w.ben, 'plan');
    const sent = await w.send(w.ben, 'plan', [c], { provider: 'local', device: 'benbox', cli: 'claude', server_id: 'benbox', agent_sub: 'benbox_claude' });
    assert(sent.status === 200, sent.text);
    const other = (await w.call('/api/teams', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { name: 'Other' } })).body.team;
    await w.move(w.ann, 'plan', other.id);
    const after = await w.call('/api/notify/local/pending', { token: w.ben.token });
    assert(after.status === 200 && !after.body.pending.some((p) => p.slug === 'plan'), `still handed out: ${after.text}`);
  });

  await t('a feedback token send reaches the agent, records no sender, and is not told an account id', async () => {
    const w = await world();
    const { slug, token, commentId } = await w.feedbackComment();
    const sent = await w.call('/api/notify/handoff', { method: 'POST', token, body: { slug, comment_ids: [commentId], recipient: ANN_AGENT } });
    assert(sent.status === 200 && sent.body.delivery.status === 'delivered', sent.text);
    assert(!('by' in JSON.parse(await w.env.META.get(`handoffs:${slug}`))[0]), 'stored sender');
    const list = await w.call(`/api/notify/handoffs?slug=${slug}`, { token });
    assert(list.status === 200 && list.body.handoffs.length === 1 && !('by' in list.body.handoffs[0]), list.text);
    // Her own linked agent is still hers, so it is still the doc's default.
    const body = await w.targets(w.ann, slug);
    assert(body.default && body.default.agent_sub === ANN_AGENT.agent_sub, `default: ${JSON.stringify(body)}`);
  });

  await t('a feedback token send to a directory row does not make the agent the owner\'s', async () => {
    const w = await world();
    await w.env.META.delete(`account-notify:${w.ann.account_id}`);
    await w.shareBensServer();
    const { slug, token, commentId } = await w.feedbackComment();
    raftCalls = [];
    const sent = await w.call('/api/notify/handoff', { method: 'POST', token, body: { slug, comment_ids: [commentId], recipient: BEN_AGENT } });
    assert(sent.status === 200 && sent.body.delivery.status === 'delivered', sent.text);
    assert(addressed().join() === 'bens-server', `the handoff itself still goes: ${addressed()}`);
    const stored = JSON.parse(await w.env.META.get(`handoffs:${slug}`))[0];
    assert(!stored.by, `no sender: ${JSON.stringify(stored)}`);
    const list = JSON.parse((await w.env.META.get(`account-notify:${w.ann.account_id}`)) || '[]');
    assert(!list.some((t) => t.agent_sub === BEN_AGENT.agent_sub), `on her account list: ${JSON.stringify(list)}`);
    const body = await w.targets(w.ann, slug);
    assert(!body.default, `default: ${JSON.stringify(body.default)}`);
    const row = w.rows(body).find((t) => t.agent_sub === BEN_AGENT.agent_sub);
    assert(row && row.source === 'directory' && !row.used_here_at, `an ordinary row: ${JSON.stringify(row)}`);
    // The proper test of proof: with the server gone, the record says nothing.
    await w.env.META.put(`account-raft-servers:${w.ann.account_id}`, '[]');
    const picked = await w.send(w.ann, slug, [stored.comment_ids[0]], BEN_AGENT);
    assert(picked.status === 409 && picked.body.error === 'agent_left_doc', `${picked.status} ${picked.text}`);
  });

  await t('a feedback token cannot connect again an agent the owner took back', async () => {
    const w = await world();
    await w.env.META.delete(`account-notify:${w.ann.account_id}`);
    await w.shareBensServer();
    await w.env.META.put(`account-notify-removed:${w.ann.account_id}`, JSON.stringify([`raft:${BEN_AGENT.server_id}:${BEN_AGENT.agent_sub}`]));
    const before = await w.env.META.get(`account-notify-removed:${w.ann.account_id}`);
    const { slug, token, commentId } = await w.feedbackComment();
    await w.call('/api/notify/handoff', { method: 'POST', token, body: { slug, comment_ids: [commentId], recipient: BEN_AGENT } });
    assert(await w.env.META.get(`account-notify-removed:${w.ann.account_id}`) === before, 'the removal stands');
  });

  await t('a feedback token send to the owner\'s linked agent still counts as using it', async () => {
    const w = await world();
    await w.link(w.ann, raftAgent('anns-other', 'ann-other', 'annie3'));
    const { slug, token, commentId } = await w.feedbackComment();
    await w.call('/api/notify/handoff', { method: 'POST', token, body: { slug, comment_ids: [commentId], recipient: ANN_AGENT } });
    const list = JSON.parse(await w.env.META.get(`account-notify:${w.ann.account_id}`));
    assert(list[0].agent_sub === ANN_AGENT.agent_sub && list.length === 2, `order: ${JSON.stringify(list)}`);
  });

  await t('sole-author rule: a directory row this doc\'s records name is no default of the owner\'s, and not labelled hers', async () => {
    const w = await world();
    await w.env.META.delete(`account-notify:${w.ann.account_id}`);
    await w.shareBensServer();
    // Published with no agent claim, so the only evidence is "her agent wrote it".
    await w.upload(w.ann, 'plan', 1);
    await w.move(w.ann, 'plan', w.team.id);
    const c0 = await w.comment(w.ben, 'plan');
    const rep = await w.call('/api/agent/reply', { method: 'POST', token: w.ben.token, headers: w.claim(BEN_AGENT), body: { slug: 'plan', parent_id: c0, text: 'on it', status: 'answered', agent_login: 'claude' } });
    assert(rep.status === 200, rep.text);
    await w.move(w.ann, 'plan', null);
    const body = await w.targets(w.ann, 'plan');
    assert(!body.default, `default: ${JSON.stringify(body.default)}`);
    const row = w.rows(body).find((t) => t.agent_sub === BEN_AGENT.agent_sub);
    assert(row && row.source === 'directory', `stays offered on a shared server: ${JSON.stringify(body)}`);
    assert(!row.owner, `called Ann's: ${JSON.stringify(row.owner)}`);
    assert(!('not_owner_agent' in row), 'an internal mark stays internal');
    assert(row.scope === 'personal', `still scoped: ${JSON.stringify(row)}`);
    const c = await w.comment(w.ann, 'plan');
    raftCalls = [];
    const un = await w.send(w.ann, 'plan', [c]);
    assert(un.status === 200 && un.body.delivery.error === 'no_recipient', un.text);
    assert(!addressed().length && !events().length, `delivered: ${JSON.stringify(events())}`);
    // The shared-server rule is unchanged: she can still pick it.
    const picked = await w.send(w.ann, 'plan', [c], BEN_AGENT);
    assert(picked.status === 200 && picked.body.delivery.status === 'delivered', picked.text);
  });

  await t('sole-author rule: an owner\'s only agent, an unlinked directory row no record names, keeps the default', async () => {
    const w = await world();
    await w.env.META.delete(`account-notify:${w.ann.account_id}`);
    await w.shareBensServer();
    await w.upload(w.ann, 'plan', 1);
    const body = await w.targets(w.ann, 'plan');
    assert(body.default && body.default.agent_sub === BEN_AGENT.agent_sub && body.default.source === 'directory', `default: ${JSON.stringify(body)}`);
    assert(body.default.owner && body.default.owner.display === 'ann', `owner: ${JSON.stringify(body.default.owner)}`);
  });

  await t('a meta read that throws during a poll hands out nothing, keeps the entry, then fails it when it can read', async () => {
    const w = await world();
    const sent = await w.benQueuesToHisDaemon('plan');
    await w.move(w.ann, 'plan', null);
    const realGet = w.env.META.get.bind(w.env.META);
    let reads = 0;
    w.env.META.get = async (key, ...rest) => {
      if (key === 'meta:plan') { reads++; throw new Error('KV hiccup'); }
      return realGet(key, ...rest);
    };
    const during = await w.call('/api/notify/local/pending', { token: w.ben.token });
    w.env.META.get = realGet;
    assert(reads > 0, 'the poll read the doc');
    assert(during.status === 200 && !during.body.pending.length, `handed out: ${during.text}`);
    const index = JSON.parse(await realGet(`local-pending:${w.ben.account_id}`));
    assert(index.some((e) => e.handoff_id === sent.body.handoff_id), 'kept for the next poll');
    const held = JSON.parse(await realGet('handoffs:plan')).find((h) => h.handoff_id === sent.body.handoff_id);
    assert(held.delivery.status !== 'failed', `a failed read says nothing: ${JSON.stringify(held.delivery)}`);
    const next = await w.call('/api/notify/local/pending', { token: w.ben.token });
    assert(!next.body.pending.length, `next poll: ${next.text}`);
    const after = JSON.parse(await realGet('handoffs:plan')).find((h) => h.handoff_id === sent.body.handoff_id);
    assert(after.delivery.error === 'access_lost', `card: ${JSON.stringify(after.delivery)}`);
  });

  await t('a meta record that will not parse hands out nothing either', async () => {
    const w = await world();
    const sent = await w.benQueuesToHisDaemon('plan');
    const raw = await w.env.META.get('meta:plan');
    await w.env.META.put('meta:plan', '{not json');
    const during = await w.call('/api/notify/local/pending', { token: w.ben.token });
    await w.env.META.put('meta:plan', raw);
    assert(!during.body.pending.length, `handed out: ${during.text}`);
    const next = await w.call('/api/notify/local/pending', { token: w.ben.token });
    assert(next.body.pending.some((p) => p.handoff_id === sent.body.handoff_id), `kept: ${next.text}`);
  });

  await t('a doc whose record is genuinely gone is not treated as a failed read', async () => {
    const w = await world();
    const sent = await w.benQueuesToHisDaemon('plan');
    await w.env.META.delete('meta:plan');
    const r = await w.call('/api/notify/local/pending', { token: w.ben.token });
    assert(r.status === 200 && r.body.pending.some((p) => p.handoff_id === sent.body.handoff_id), `as before: ${r.text}`);
    const held = JSON.parse(await w.env.META.get('handoffs:plan')).find((h) => h.handoff_id === sent.body.handoff_id);
    assert(held.delivery.status !== 'failed', `not failed: ${JSON.stringify(held.delivery)}`);
  });

  await t('a stale tab cannot send to a server the owner disconnected, though no record names the agent', async () => {
    const w = await world();
    await w.shareBensServer();
    await w.upload(w.ann, 'mine', 1);
    const before = await w.targets(w.ann, 'mine');
    assert(w.rows(before).some((t) => t.agent_sub === BEN_AGENT.agent_sub), 'the tab saw it');
    const off = await w.call('/api/me/connectors/remove', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { provider: 'raft', server_id: BEN_AGENT.server_id } });
    assert(off.status === 200, off.text);
    const c = await w.comment(w.ann, 'mine');
    raftCalls = [];
    const r = await w.send(w.ann, 'mine', [c], BEN_AGENT);
    assert(r.status === 409 && r.body.error === 'agent_left_doc', `${r.status} ${r.text}`);
    assert(!addressed().length && !events().length, `delivered: ${JSON.stringify(events())}`);
  });

  await t('a team agent\'s handoff is marked access_lost when its doc leaves the team, and is not handed out', async () => {
    const w = await world();
    const added = (await w.call('/api/team/agents', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { id: w.team.id, name: 'bot' } })).body;
    const conn = (await w.call('/api/team/agents/connect', { method: 'POST', body: { code: added.setup_code, device: 'botbox' } })).body;
    await w.call('/api/notify/local/register', { method: 'POST', token: conn.token, body: { device: 'botbox', clis: ['claude'] } });
    await w.teamDoc('plan');
    const up = await w.call('/api/upload', { method: 'POST', token: conn.token, body: { slug: 'plan', version: 2, html: '<h1>x</h1><p>a sentence to comment on</p>' } });
    assert(up.status === 200, up.text);
    const body = await w.targets(w.ben, 'plan');
    const row = body.default || body.candidates[0];
    assert(row && row.team_agent, `the team's agent: ${JSON.stringify(body)}`);
    const c = await w.comment(w.ben, 'plan');
    const sent = await w.send(w.ben, 'plan', [c], row);
    assert(sent.status === 200, sent.text);
    const before = await w.call('/api/notify/local/pending', { token: conn.token });
    assert(before.body.pending.length === 1, `queued: ${before.text}`);
    await w.move(w.ann, 'plan', null);
    const after = await w.call('/api/notify/local/pending', { token: conn.token });
    assert(after.status === 200 && !after.body.pending.length, `handed out: ${after.text}`);
    const seen = await w.call('/api/notify/handoffs?slug=plan', { cookie: w.ann.cookie });
    const card = seen.body.handoffs.find((h) => h.handoff_id === sent.body.handoff_id);
    assert(card && card.delivery.status === 'failed' && card.delivery.error === 'access_lost', `Ann's card: ${seen.text}`);
    assert(!JSON.parse(await w.env.META.get(`local-pending:${conn.account_id}`)).length, 'off the queue');
  });

  await t('a failed read during a team agent\'s poll keeps its handoff too', async () => {
    const w = await world();
    const added = (await w.call('/api/team/agents', { method: 'POST', cookie: w.ann.cookie, headers: ORIGIN, body: { id: w.team.id, name: 'bot' } })).body;
    const conn = (await w.call('/api/team/agents/connect', { method: 'POST', body: { code: added.setup_code, device: 'botbox' } })).body;
    await w.call('/api/notify/local/register', { method: 'POST', token: conn.token, body: { device: 'botbox', clis: ['claude'] } });
    await w.teamDoc('plan');
    await w.call('/api/upload', { method: 'POST', token: conn.token, body: { slug: 'plan', version: 2, html: '<h1>x</h1><p>a sentence to comment on</p>' } });
    const body = await w.targets(w.ben, 'plan');
    const c = await w.comment(w.ben, 'plan');
    const sent = await w.send(w.ben, 'plan', [c], body.default || body.candidates[0]);
    await w.move(w.ann, 'plan', null);
    const realGet = w.env.META.get.bind(w.env.META);
    w.env.META.get = async (key, ...rest) => { if (key === 'meta:plan') throw new Error('KV hiccup'); return realGet(key, ...rest); };
    const during = await w.call('/api/notify/local/pending', { token: conn.token });
    w.env.META.get = realGet;
    assert(!during.body.pending.length, `handed out: ${during.text}`);
    assert(JSON.parse(await realGet('handoffs:plan')).find((h) => h.handoff_id === sent.body.handoff_id).delivery.status !== 'failed', 'marked failed');
    assert(JSON.parse(await realGet(`local-pending:${conn.account_id}`)).some((e) => e.handoff_id === sent.body.handoff_id), 'kept');
  });

  await t('an agent Ann picked with Send and pushed off her list still follows that doc', async () => {
    const w = await world();
    await w.upload(w.ann, 'mine', 1);
    // With a second agent to choose from, sending to this one is picking it.
    await w.link(w.ann, raftAgent('anns-other', 'ann-other', 'annie3'));
    const c = await w.comment(w.ann, 'mine');
    const sent = await w.send(w.ann, 'mine', [c], ANN_AGENT);
    assert(sent.body.delivery.status === 'delivered', sent.text);
    assert(JSON.parse(await w.env.META.get('handoffs:mine'))[0].by === w.ann.account_id, 'a personal handoff names its sender');
    for (let i = 0; i < 9; i++) await w.link(w.ann, raftAgent(`srv${i}`, `a${i}`, `n${i}`));
    const stored = JSON.parse(await w.env.META.get(`account-notify:${w.ann.account_id}`));
    assert(!stored.some((t) => t.agent_sub === ANN_AGENT.agent_sub), 'off the list');
    const body = await w.targets(w.ann, 'mine');
    assert(body.default && body.default.agent_sub === ANN_AGENT.agent_sub, `default: ${JSON.stringify(body.default)}`);
    const d = await w.comment(w.ann, 'mine');
    raftCalls = [];
    const r = await w.send(w.ann, 'mine', [d]);
    assert(r.body.delivery.status === 'delivered' && addressed().join() === 'anns-server', `${r.text} ${addressed()}`);
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
    // Known gap, order only and on her own computer: an entry in notify_agents
    // does not say whose it is, so Ben's and Ann's macbook_claude are one entry.
    // Taken out here so this pins what versions and handoffs can tell apart.
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
