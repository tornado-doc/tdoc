// The @ list puts agents used on THIS doc first, most recent on top; the rest
// by account-wide recency; tdoc AI last (Julie). The server says when each of
// the viewer's agents was used here (used_here_at); byRelevance orders by it.
//
// What this pins down:
//   - used here outranks used more recently on another doc
//   - replied, published, handed a comment, asked: each counts; a reply never
//     sets last_writer, and most recent use outranks the last editor
//   - one rule: what a composer means by default is the row on top
//     (composerDefault); the server's `default`, the Send to agent dialog's,
//     stays what it was
//   - a typed name: exact and prefix matches ahead of use
//   - a feedback token learns nothing of a private question's timing
//   - cost: nothing read twice, nothing looked up on a poll
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
  const { byRelevance, composerDefault, matchAgentChoices } = await import('../shell/src/document/agent-choices.js');
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

  // What every composer means by default on this list, as each surface asks.
  const onDocPage = (body) => composerDefault(OWN_LIST(body), { evidence: body.default });
  const onFeedback = (body) => composerDefault(OWN_LIST(body), { orTop: true });
  const onTop = (body) => byRelevance(OWN_LIST(body))[0];

  await t('one rule: the last handoff, then a later reply: the replier is on top and is the pick; the server default stays', async () => {
    const { env, owner, here } = await seed();
    const handed = await call(env, '/api/notify/handoff', { method: 'POST', token: owner.token, body: { slug: 'here', comment_ids: [here], recipient: { provider: 'local', server_id: 'box', device: 'box', cli: 'claude', agent_sub: 'box_claude' } } });
    assert(handed.status === 200, handed.text);
    await tick();
    await reply(env, owner, 'here', here, 'local/mac/mac_codex');
    const body = await targets(env, owner, 'here');
    assert(body.default.agent_sub === 'box_claude', `the Send to agent dialog's default moved: ${JSON.stringify(body.default)}`);
    assert(onTop(body).agent_sub === 'mac_codex', subs(byRelevance(OWN_LIST(body))).join());
    assert(onDocPage(body).agent_sub === 'mac_codex' && onFeedback(body).agent_sub === 'mac_codex', 'the pick is not the row on top');
  });

  await t('one rule: published, then another replied: the replier is on top and is the pick; the publisher keeps its mark', async () => {
    const { env, owner, here } = await seed();
    await publish(env, owner, 'here', 2, 'local/mac/mac_codex');
    await tick();
    await reply(env, owner, 'here', here, 'local/box/box_claude');
    const body = await targets(env, owner, 'here');
    assert(body.default.agent_sub === 'mac_codex' && body.default.last_writer, JSON.stringify(body.default));
    assert(onTop(body).agent_sub === 'box_claude' && onDocPage(body).agent_sub === 'box_claude', subs(byRelevance(OWN_LIST(body))).join());
  });

  await t('one rule, the traced case: a feedback space, A replied with no handoff, then B replied elsewhere: no server default, A on top, A the pick', async () => {
    const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
    const owner = await issue(worker, env, 'owner');
    const raft = (sub) => ({ provider: 'raft', server_id: 'S1', server_slug: 'acme', agent_sub: sub, agent_name: `${sub}-bot`, last_touched: '2026-01-01T00:00:00.000Z' });
    await env.META.put(`account-notify:${owner.account_id}`, JSON.stringify([raft('a'), raft('b')]));
    const { slug, token } = (await call(env, '/api/feedback/connect', { method: 'POST', cookie: owner.cookie, body: { origin: 'https://app.example.com' } })).body;
    await publish(env, owner, 'elsewhere');
    const away = await commentOn(env, owner, 'elsewhere');
    const posted = await call(env, '/api/comments', { method: 'POST', token, body: { slug, text: 'broken', anchor: { kind: 'product', url: 'https://app.example.com/' } } });
    await reply(env, owner, slug, posted.body.id, 'raft/S1/a');
    await tick();
    await reply(env, owner, 'elsewhere', away, 'raft/S1/b');
    const body = await targets(env, owner, slug);
    // The list the server still gives is B first; A is what the page shows.
    assert(rowsOf(body)[0].agent_sub === 'b' || body.default?.agent_sub === 'a', JSON.stringify(rowsOf(body)));
    assert(onTop(body).agent_sub === 'a' && onFeedback(body).agent_sub === 'a', `top ${onTop(body).agent_sub}, pick ${onFeedback(body).agent_sub}`);
  });

  await t('one rule, the limits: an answer-only row is never the pick; a doc page with no evidence picks nobody', async () => {
    const raft = (sub, extra) => ({ provider: 'raft', server_id: 'S1', agent_sub: sub, agent_name: sub, ...extra });
    const list = [raft('edit', { can_edit: true, used_here_at: '2026-01-01T00:00:00.000Z' }), raft('ask', { can_edit: false, used_here_at: '2026-02-01T00:00:00.000Z' })];
    assert(byRelevance(list)[0].agent_sub === 'ask' && composerDefault(list).agent_sub === 'edit', 'an answer-only row was picked to edit');
    assert(composerDefault([list[1]]) === null, 'no row may edit');
    const unused = [raft('one', { can_edit: true }), raft('two', { can_edit: true })];
    assert(composerDefault(unused) === null, 'an unrelated agent was picked on a doc page');
    assert(composerDefault(unused, { evidence: unused[0] }).agent_sub === 'one', 'the server\'s evidence, on top, is the pick');
    assert(composerDefault(unused, { orTop: true }).agent_sub === 'one', 'the feedback surfaces offer the top row');
    assert(composerDefault([{ ...TDOC_AI, can_edit: false }], { orTop: true }) === null, 'tdoc AI is never the pick');
  });

  await t('asked on their own doc: the owner\'s question orders the merged row, as my-agent is the one to know', async () => {
    const { env, owner } = await seed();
    const state = await mine(env, owner, 'here');
    const asked = await call(env, '/api/docs/here/my-agent', { method: 'POST', cookie: owner.cookie, headers: ORIGIN, body: { question: 'why?', recipient: row(state.agents, 'mac_codex') } });
    assert(asked.status === 200, asked.text);
    const body = await targets(env, owner, 'here');
    const list = composerAgents({ canSendToAgent: true, notifyTargets: body, mine: await mine(env, owner, 'here') });
    assert(byRelevance(list)[0].agent_sub === 'mac_codex' && byRelevance(list)[0].can_edit, subs(byRelevance(list)).join());
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
    // And nothing of the owner's in the answer: each row names the reader, its
    // own owner (what lets a reply box tell it answered a thread), nobody else.
    const raw = (await call(env, '/api/docs/here/my-agent', { cookie: reader.cookie })).text;
    assert(JSON.parse(raw).agents.every((x) => x.owner && x.owner.key === 'reader'), `someone else's row: ${raw}`);
    assert(!raw.replaceAll('"owner":', '').includes('owner'), `owner named in: ${raw}`);
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

  await t('a typed name: exact and prefix beat use, use breaks ties, tdoc AI stays last', async () => {
    const at = (m) => `2026-0${m}-01T00:00:00.000Z`;
    const rows = [
      { provider: 'raft', server_id: 'm', agent_sub: 'claw', agent_name: 'smarter-claude-claw', used_here_at: at(3) },
      { provider: 'raft', server_id: 'm', agent_sub: 'pre-old', agent_name: 'claude-old', used_here_at: at(1) },
      { provider: 'raft', server_id: 'm', agent_sub: 'pre-new', agent_name: 'claude-new', used_here_at: at(2) },
      { provider: 'raft', server_id: 'm', agent_sub: 'exact', agent_name: 'claude' },
      { ...TDOC_AI },
    ];
    const order = byRelevance(rows);
    same(subs(order), ['claw', 'pre-new', 'pre-old', 'exact', 'tdoc-ai']);
    same(subs(matchAgentChoices(order, '', { limit: Infinity })), subs(order));
    // Enter picks the first of these (mention-field).
    same(subs(matchAgentChoices(order, 'claude', { limit: Infinity })), ['exact', 'pre-new', 'pre-old', 'claw']);
    same(subs(matchAgentChoices(order, 'claude-', { limit: Infinity })), ['pre-new', 'pre-old', 'claw']);
    same(subs(matchAgentChoices(order, 'tdoc', { limit: Infinity })), ['tdoc-ai']);
    const beside = [{ ...TDOC_AI }, { provider: 'raft', server_id: 'm', agent_sub: 'bot', agent_name: 'x tdoc-bot' }];
    same(subs(matchAgentChoices(beside, 'tdoc', { limit: Infinity })), ['bot', 'tdoc-ai']);
  });

  // Serena's space on tdoc itself; Julie joined it; her token reaches her own agents.
  async function joinedSpace() {
    const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
    const serena = await issue(worker, env, 'serena');
    const julie = await issue(worker, env, 'julie');
    const raft = (sub) => ({ provider: 'raft', server_id: 'S1', server_slug: 'acme', agent_sub: sub, agent_name: sub, last_touched: '2026-01-01T00:00:00.000Z' });
    await env.META.put(`account-notify:${julie.account_id}`, JSON.stringify([raft('open'), raft('hidden')]));
    const space = (await call(env, '/api/feedback/connect', { method: 'POST', cookie: serena.cookie, headers: ORIGIN, body: { origin: 'https://tdoc.dev' } })).body;
    const meta = JSON.parse(await env.META.get(`meta:${space.slug}`));
    await env.META.put(`meta:${space.slug}`, JSON.stringify({ ...meta, access: { ...meta.access, allowed_users: ['julie'] } }));
    await call(env, '/api/feedback/join', { method: 'POST', cookie: julie.cookie, headers: ORIGIN, body: { slug: space.slug } });
    const token = (await call(env, '/api/feedback/connect', { method: 'POST', cookie: julie.cookie, headers: ORIGIN, body: { origin: 'https://tdoc.dev' } })).body.token;
    const ask = (id, sub, extra = {}) => ({ ask_id: id, at: '2026-03-01T00:00:00.000Z', by: julie.account_id, question: 'q', recipient: raft(sub), delivery: { status: 'delivered' }, ...extra });
    return { env, julie, slug: space.slug, token, ask };
  }

  await t('a feedback token: a private question\'s timing stays out of used_here_at, the cookie still sees it', async () => {
    const { env, julie, slug, token, ask } = await joinedSpace();
    await env.META.put(`agent-asks:${slug}:${julie.account_id}`, JSON.stringify([ask('private', 'hidden'), ask('thread', 'open', { comment_id: 'c1' })]));
    const viaToken = await call(env, `/api/docs/${slug}/my-agent`, { token, headers: ORIGIN });
    assert(viaToken.status === 200, viaToken.text);
    assert(!viaToken.body.asks.some((a) => a.ask_id === 'private'), 'the token lists a private question');
    assert(!row(viaToken.body.agents, 'hidden').used_here_at, `the token learned of the private question: ${JSON.stringify(viaToken.body.agents)}`);
    assert(row(viaToken.body.agents, 'open').used_here_at, 'a question in a thread is the token\'s to see');
    assert(row((await mine(env, julie, slug)).agents, 'hidden').used_here_at, 'in her own browser it counts');
  });

  await t('cost: a poll looks up no use; a full read reads asks and handoffs once; targets read handoffs once and no group or asks', async () => {
    const { env, owner, here } = await seed();
    await reply(env, owner, 'here', here, 'local/mac/mac_codex');
    const reads = (key) => env.META.gets.filter((k) => k === key).length;
    env.META.gets.length = 0;
    const polled = await call(env, '/api/docs/here/my-agent?poll=1', { cookie: owner.cookie });
    assert(polled.status === 200 && !polled.body.agents.some((x) => x.used_here_at), polled.text);
    assert(reads('handoffs:here') === 0, `a poll read handoffs ${reads('handoffs:here')} times`);
    assert(reads(`agent-asks:here:${owner.account_id}`) === 1, 'a poll still lists the questions');
    env.META.gets.length = 0;
    const full = await call(env, '/api/docs/here/my-agent', { cookie: owner.cookie });
    assert(row(full.body.agents, 'mac_codex').used_here_at, full.text);
    assert(reads('handoffs:here') === 1 && reads(`agent-asks:here:${owner.account_id}`) === 1, `handoffs ${reads('handoffs:here')}, asks ${reads(`agent-asks:here:${owner.account_id}`)}`);
    env.META.gets.length = 0;
    assert(row(rowsOf(await targets(env, owner, 'here')), 'mac_codex').used_here_at, 'targets lost the use');
    assert(reads('handoffs:here') === 1, `targets read handoffs ${reads('handoffs:here')} times`);
    assert(reads(`agent-asks:here:${owner.account_id}`) === 0, 'targets read the asks');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
