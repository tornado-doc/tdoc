// The @ list puts agents used on THIS doc first, most recent on top; the rest
// by account-wide recency; tdoc AI last (Julie). The server says when each of
// the viewer's agents was used here (used_here_at); byRelevance orders by it.
//
// What this pins down:
//   - used here outranks used more recently on another doc
//   - replied, published, handed a comment, asked: each counts; a reply never
//     sets last_writer, and most recent use outranks the last editor
//   - order only: `default` and the first editable row (the preselected
//     recipient) stay what they were
//   - a viewer learns only about their own agents' use: same-named agents of
//     another person, and another member's handoff to a team agent, stay out
//
// Run with: node test/agent-used-here.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
const tick = () => new Promise((resolve) => setTimeout(resolve, 3));

(async () => {
  console.log('agents used here');
  const mod = await loadWorker();
  const worker = mod.default;
  const { byRelevance, matchAgentChoices } = await import('../shell/src/document/agent-choices.js');
  const { composerAgents, TDOC_AI } = await import('../shell/src/document/ai-answerer.js');
  const ORIGIN = { Origin: 'https://tdoc.dev' };

  const call = async (env, path, opts) => {
    const r = await worker.fetch(req(path, opts), env, { waitUntil() {}, passThroughOnException() {} });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const HTML = (slug) => `<h1>${slug}</h1><p>a sentence to comment on</p>`;
  const publish = async (env, who, slug, version = 1, agent = null) => {
    const r = await call(env, '/api/upload', { method: 'POST', token: who.token, headers: agent ? { 'X-Tdoc-Agent': agent } : {}, body: { slug, version, html: HTML(slug) } });
    assert(r.status === 200, `upload ${slug}: ${r.text}`);
  };
  const commentOn = async (env, who, slug) => {
    const r = await call(env, '/api/comments', { method: 'POST', cookie: who.cookie, body: { slug, version: 1, text: 'this is confusing', anchor: { kind: 'text', text: 'a sentence' } } });
    assert(r.status === 200, `comment on ${slug}: ${r.text}`);
    return r.body.id;
  };
  const reply = async (env, who, slug, parent, agent) => {
    const r = await call(env, '/api/agent/reply', { method: 'POST', token: who.token, headers: { 'X-Tdoc-Agent': agent }, body: { slug, parent_id: parent, text: `done ${Math.random()}`, status: 'answered', agent_login: 'claude' } });
    assert(r.status === 200, `reply: ${r.text}`);
  };
  const register = (env, who, device, clis = ['claude', 'codex']) => call(env, '/api/notify/local/register', { method: 'POST', token: who.token, body: { device, clis } });
  const targets = async (env, who, slug) => {
    const r = await call(env, `/api/notify/targets?slug=${slug}`, who.token ? { token: who.token } : { cookie: who.cookie });
    assert(r.status === 200, `targets: ${r.text}`);
    return r.body;
  };
  const mine = async (env, who, slug) => {
    const r = await call(env, `/api/docs/${slug}/my-agent`, { cookie: who.cookie });
    assert(r.status === 200, `my-agent: ${r.text}`);
    return r.body;
  };
  const row = (list, sub) => list.find((x) => x.agent_sub === sub);
  const subs = (list) => list.map((x) => x.agent_sub || x.agent_name);
  const rowsOf = (body) => [body.default, ...(body.candidates || [])].filter(Boolean);
  const same = (a, b) => assert(JSON.stringify(a) === JSON.stringify(b), `${JSON.stringify(a)} !== ${JSON.stringify(b)}`);

  // Two docs, three agents: mac_claude, mac_codex, box_claude.
  async function seed() {
    const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
    const owner = await issue(worker, env, 'owner');
    const reader = await issue(worker, env, 'reader');
    await publish(env, owner, 'here');
    await publish(env, owner, 'elsewhere');
    await register(env, owner, 'mac');
    await register(env, owner, 'box', ['claude']);
    return {
      env, owner, reader,
      here: await commentOn(env, owner, 'here'),
      away: await commentOn(env, owner, 'elsewhere'),
    };
  }
  const OWN_LIST = (body) => composerAgents({ canSendToAgent: true, notifyTargets: body });

  await t('used on this doc outranks used more recently on another doc', async () => {
    const { env, owner, here, away } = await seed();
    await reply(env, owner, 'here', here, 'local/mac/mac_claude');
    await tick();
    await reply(env, owner, 'elsewhere', away, 'local/mac/mac_codex');
    const body = await targets(env, owner, 'here');
    // The account-wide recency the server still lists by is the other way round.
    assert(rowsOf(body).findIndex((x) => x.agent_sub === 'mac_codex') !== -1, 'codex not offered');
    const used = row(rowsOf(body), 'mac_claude');
    assert(used.used_here_at, JSON.stringify(used));
    assert(!row(rowsOf(body), 'mac_codex').used_here_at, 'used elsewhere is not used here');
    same(subs(byRelevance(OWN_LIST(body))).slice(0, 2), ['mac_claude', 'mac_codex']);
    const elsewhere = await targets(env, owner, 'elsewhere');
    same(subs(byRelevance(OWN_LIST(elsewhere))).slice(0, 2), ['mac_codex', 'mac_claude']);
  });

  await t('two used here: the most recent first, whichever way they were used', async () => {
    const { env, owner, here } = await seed();
    await reply(env, owner, 'here', here, 'local/mac/mac_codex');
    await tick();
    const next = await commentOn(env, owner, 'here');
    const handed = await call(env, '/api/notify/handoff', { method: 'POST', token: owner.token, body: { slug: 'here', comment_ids: [next], recipient: { provider: 'local', server_id: 'box', device: 'box', cli: 'claude', agent_sub: 'box_claude' } } });
    assert(handed.status === 200 && handed.body.delivery.status !== 'failed', handed.text);
    const body = await targets(env, owner, 'here');
    same(subs(byRelevance(OWN_LIST(body))), ['box_claude', 'mac_codex', 'mac_claude']);
    await tick();
    await reply(env, owner, 'here', next, 'local/mac/mac_codex');
    same(subs(byRelevance(OWN_LIST(await targets(env, owner, 'here')))), ['mac_codex', 'box_claude', 'mac_claude']);
  });

  await t('a reply counts as use and does not make it the last writer', async () => {
    const { env, owner, here } = await seed();
    await reply(env, owner, 'here', here, 'local/box/box_claude');
    const used = row(rowsOf(await targets(env, owner, 'here')), 'box_claude');
    assert(used.used_here_at && !used.last_writer, JSON.stringify(used));
  });

  await t('most recent use outranks the last editor, who keeps the Edited last mark', async () => {
    const { env, owner, here } = await seed();
    await publish(env, owner, 'here', 2, 'local/mac/mac_codex');
    await tick();
    await reply(env, owner, 'here', here, 'local/box/box_claude');
    const body = await targets(env, owner, 'here');
    const rows = rowsOf(body);
    assert(row(rows, 'mac_codex').last_writer && row(rows, 'mac_codex').used_here_at, JSON.stringify(rows));
    assert(!row(rows, 'box_claude').last_writer, JSON.stringify(rows));
    same(subs(byRelevance(OWN_LIST(body))).slice(0, 2), ['box_claude', 'mac_codex']);
  });

  await t('a handoff that failed to deliver is not use', async () => {
    const { env, owner, here } = await seed();
    const meta = JSON.parse(await env.META.get('handoffs:here') || '[]');
    assert(!meta.length, 'seed sent something');
    await env.META.put('handoffs:here', JSON.stringify([{ handoff_id: 'h1', at: new Date().toISOString(), recipient: { provider: 'local', server_id: 'mac', device: 'mac', cli: 'codex', agent_sub: 'mac_codex' }, comment_ids: [here], delivery: { status: 'failed', error: 'x' } }]));
    assert(!row(rowsOf(await targets(env, owner, 'here')), 'mac_codex').used_here_at, 'a failed handoff was counted');
  });

  await t('order only: default and the preselected row do not follow the new order', async () => {
    const { env, owner, here } = await seed();
    const handed = await call(env, '/api/notify/handoff', { method: 'POST', token: owner.token, body: { slug: 'here', comment_ids: [here], recipient: { provider: 'local', server_id: 'box', device: 'box', cli: 'claude', agent_sub: 'box_claude' } } });
    assert(handed.status === 200, handed.text);
    await tick();
    await reply(env, owner, 'here', here, 'local/mac/mac_codex');
    const body = await targets(env, owner, 'here');
    assert(body.default.agent_sub === 'box_claude', `default moved: ${JSON.stringify(body.default)}`);
    const list = OWN_LIST(body);
    // What the feedback space and the widget preselect, and Ask's first row.
    assert(list.find((x) => x.can_edit).agent_sub === 'box_claude' && list[0].agent_sub === 'box_claude', subs(list).join());
    assert(byRelevance(list)[0].agent_sub === 'mac_codex', subs(byRelevance(list)).join());
  });

  await t('feedback space: it is a doc, its widget token sees the same order', async () => {
    const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
    const owner = await issue(worker, env, 'owner');
    // The widget's token offers no local agent: two on a Raft server.
    const raft = (sub) => ({ provider: 'raft', server_id: 'S1', server_slug: 'acme', agent_sub: sub, agent_name: `${sub}-bot`, last_touched: '2026-01-01T00:00:00.000Z' });
    await env.META.put(`account-notify:${owner.account_id}`, JSON.stringify([raft('one'), raft('two')]));
    const connect = await call(env, '/api/feedback/connect', { method: 'POST', cookie: owner.cookie, body: { origin: 'https://app.example.com' } });
    assert(connect.status === 200, connect.text);
    const { slug, token } = connect.body;
    await publish(env, owner, 'elsewhere');
    const away = await commentOn(env, owner, 'elsewhere');
    const posted = await call(env, '/api/comments', { method: 'POST', token, body: { slug, text: 'the button is broken', anchor: { kind: 'product', url: 'https://app.example.com/' } } });
    assert(posted.status === 200, posted.text);
    await reply(env, owner, slug, posted.body.id, 'raft/S1/one');
    await tick();
    await reply(env, owner, 'elsewhere', away, 'raft/S1/two');
    const viaWidget = await call(env, `/api/notify/targets?slug=${slug}`, { token });
    assert(viaWidget.status === 200, viaWidget.text);
    assert(row(rowsOf(viaWidget.body), 'one').used_here_at && !row(rowsOf(viaWidget.body), 'two').used_here_at, viaWidget.text);
    same(subs(byRelevance(OWN_LIST(viaWidget.body))), ['one', 'two']);
    same(subs(byRelevance(OWN_LIST(await targets(env, owner, slug)))), ['one', 'two']);
  });

  await t('a joiner: their own agents by their own use; another person\'s agent of the same name stays out', async () => {
    const { env, owner, reader, here } = await seed();
    // The owner's agent, same computer name and CLI as the reader's, replied.
    await reply(env, owner, 'here', here, 'local/mac/mac_claude');
    await register(env, reader, 'mac');
    let state = await mine(env, reader, 'here');
    assert(!state.agents.some((x) => x.used_here_at), `the owner's use reached the reader: ${JSON.stringify(state.agents)}`);
    const asked = await call(env, '/api/docs/here/my-agent', { method: 'POST', cookie: reader.cookie, headers: ORIGIN, body: { question: 'what is this?', recipient: row(state.agents, 'mac_codex') } });
    assert(asked.status === 200, asked.text);
    state = await mine(env, reader, 'here');
    assert(row(state.agents, 'mac_codex').used_here_at, JSON.stringify(state.agents));
    assert(!row(state.agents, 'mac_claude').used_here_at, 'the reader never used this one here');
    const list = composerAgents({ canSendToAgent: false, mine: { ...state, tdoc_ai: true } });
    assert(byRelevance(list)[0].agent_sub === 'mac_codex', subs(byRelevance(list)).join());
    assert(byRelevance(list).at(-1).tdoc_ai, 'tdoc AI is last');
    // And nothing of the owner's in the answer.
    const raw = (await call(env, '/api/docs/here/my-agent', { cookie: reader.cookie })).text;
    assert(!raw.includes('owner'), `owner named in: ${raw}`);
    // The asker's question stays theirs: the owner's rows do not move for it.
    assert(!row(rowsOf(await targets(env, owner, 'here')), 'mac_codex').used_here_at, 'the reader\'s ask reached the owner');
  });

  await t('a joiner\'s own agents with no use here: account-wide recency', async () => {
    const { env, owner, reader } = await seed();
    await publish(env, reader, 'theirs');
    await register(env, reader, 'mac');
    const theirs = await commentOn(env, reader, 'theirs');
    await reply(env, reader, 'theirs', theirs, 'local/mac/mac_codex');
    await tick();
    await reply(env, reader, 'theirs', theirs, 'local/mac/mac_claude');
    await tick();
    await reply(env, reader, 'theirs', theirs, 'local/mac/mac_codex');
    const state = await mine(env, reader, 'here');
    const list = byRelevance(composerAgents({ mine: state }));
    same(subs(list), ['mac_codex', 'mac_claude']);
    assert(owner, 'seed');
  });

  await t('team doc: a member sees team agents\' visible work and their own, not another member\'s handoff', async () => {
    const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
    const julie = await issue(worker, env, 'julie');
    const bob = await issue(worker, env, 'bob');
    const team = (await call(env, '/api/teams', { method: 'POST', cookie: julie.cookie, headers: ORIGIN, body: { name: 'Crew' } })).body.team;
    const joined = await call(env, '/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: team.invite_url.split('/').pop() } });
    assert(joined.status === 200, joined.text);
    await publish(env, julie, 'report');
    assert((await call(env, '/api/team/move', { method: 'POST', token: julie.token, body: { team: team.id, slugs: ['report'] } })).status === 200, 'move');
    const connect = async (name, device) => {
      const added = await call(env, '/api/team/agents', { method: 'POST', cookie: julie.cookie, headers: ORIGIN, body: { id: team.id, name } });
      const made = await call(env, '/api/team/agents/connect', { method: 'POST', body: { code: added.body.setup_code, device } });
      assert(made.status === 200, made.text);
      await call(env, '/api/notify/local/register', { method: 'POST', token: made.body.token, body: { device, clis: ['claude', 'codex'] } });
      return { token: made.body.token, id: added.body.agent.id };
    };
    const a = await connect('alpha', 'box-a');
    const b = await connect('beta', 'box-b');
    const c = await connect('gamma', 'box-c');
    // A person's own edit leaves it open to the team agents; alpha then writes.
    const report = JSON.parse(await env.META.get('meta:report'));
    await env.META.put('meta:report', JSON.stringify({ ...report, versions: report.versions.map((v) => ({ n: v.n, created: v.created, source: 'browser', author: 'julie' })) }));
    const wrote = await call(env, '/api/upload', { method: 'POST', token: a.token, body: { slug: 'report', version: 2, html: HTML('report') } });
    assert(wrote.status === 200, wrote.text);
    const comment = await commentOn(env, bob, 'report');
    const rowsFor = async (who) => rowsOf(await targets(env, { cookie: who.cookie }, 'report'));
    const agentRows = (rows, id) => rows.filter((x) => x.team_agent && x.team_agent.id === id);
    const hand = (who, recipient, id = comment) => call(env, '/api/notify/handoff', { method: 'POST', cookie: who.cookie, headers: ORIGIN, body: { slug: 'report', comment_ids: [id], recipient } });
    assert(agentRows(await rowsFor(bob), a.id).every((x) => x.used_here_at && x.last_writer), 'the writer of the latest version');

    // Julie hands the comment to beta. Bob did not send it and cannot see it.
    const handed = await hand(julie, agentRows(await rowsFor(julie), b.id)[0]);
    assert(handed.status === 200 && handed.body.delivery.status !== 'failed', handed.text);
    assert(agentRows(await rowsFor(julie), b.id).every((x) => x.used_here_at), 'the admin who sent it should see it');
    assert(agentRows(await rowsFor(bob), b.id).every((x) => !x.used_here_at), 'another member\'s handoff reached bob');
    assert(!(await mine(env, bob, 'report')).team_agents.some((x) => x.team_agent.id === b.id && x.used_here_at), 'and through my-agent');

    // beta replies: every member sees the reply, so it orders for every member,
    // on all of beta's rows (a claude and a codex are one agent).
    await tick();
    const replied = await call(env, '/api/agent/reply', { method: 'POST', token: b.token, body: { slug: 'report', parent_id: comment, text: 'on it', status: 'answered', agent_login: 'claude' } });
    assert(replied.status === 200, replied.text);
    const beta = agentRows(await rowsFor(bob), b.id);
    assert(beta.length === 2 && beta.every((x) => x.used_here_at && !x.last_writer), JSON.stringify(beta));
    const body = await targets(env, { cookie: bob.cookie }, 'report');
    assert(body.default.team_agent.id === a.id, 'the writer stays the default');
    const list = byRelevance(composerAgents({ canSendToAgent: true, notifyTargets: body }));
    same(list.map((x) => x.team_agent.name), ['beta', 'alpha', 'gamma']);
    const state = await mine(env, bob, 'report');
    assert(state.team_agents.filter((x) => x.team_agent.id === b.id).every((x) => x.used_here_at), JSON.stringify(state.team_agents));

    // bob's own send counts for bob.
    await tick();
    const own = await hand(bob, agentRows(await rowsFor(bob), c.id)[0], await commentOn(env, bob, 'report'));
    assert(own.status === 200 && own.body.delivery.status !== 'failed', own.text);
    same(byRelevance(composerAgents({ canSendToAgent: true, notifyTargets: await targets(env, { cookie: bob.cookie }, 'report') })).map((x) => x.team_agent.name), ['gamma', 'beta', 'alpha']);

    // A member's own agent replying: theirs alone, though bob's has the same
    // computer name and CLI.
    await register(env, julie, 'mac');
    await register(env, bob, 'mac');
    const asJulie = await call(env, '/api/agent/reply', { method: 'POST', token: julie.token, headers: { 'X-Tdoc-Agent': 'local/mac/mac_claude' }, body: { slug: 'report', parent_id: await commentOn(env, julie, 'report'), text: 'mine too', status: 'answered', agent_login: 'claude' } });
    assert(asJulie.status === 200 && !asJulie.body.skipped, asJulie.text);
    assert(row((await mine(env, julie, 'report')).agents, 'mac_claude').used_here_at, 'julie\'s own reply');
    assert(!row((await mine(env, bob, 'report')).agents, 'mac_claude').used_here_at, 'julie\'s use reached bob');
  });

  await t('tdoc AI last, and typing a name keeps the top of the order', async () => {
    const rows = [
      { provider: 'local', server_id: 'm', agent_sub: 'old', agent_name: 'cl-old', used_here_at: '2026-01-01T00:00:00.000Z' },
      { provider: 'local', server_id: 'm', agent_sub: 'new', agent_name: 'x cl-new', used_here_at: '2026-02-01T00:00:00.000Z' },
      { provider: 'local', server_id: 'm', agent_sub: 'other', agent_name: 'cl-other', last_touched: '2026-03-01T00:00:00.000Z' },
      { ...TDOC_AI },
    ];
    const order = byRelevance(rows);
    same(subs(order), ['new', 'old', 'other', 'tdoc-ai']);
    // "cl" is a prefix of the older name and a word in the newer one.
    same(subs(matchAgentChoices(order, 'cl', { limit: Infinity })), ['new', 'old', 'other']);
    same(subs(matchAgentChoices(order, 'tdoc', { limit: Infinity })), ['tdoc-ai']);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
