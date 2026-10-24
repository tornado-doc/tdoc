// Team agents (tdoc.dev/d/tdoc-agent-access-model): an agent that belongs to a
// team, not to a person. A team admin adds it in team settings -> Agents and
// gets a one-time setup command; the machine trades it for a token that
// reaches that one team's docs. Every member may hand it a comment on a team
// doc; nobody else may, and never from another team's doc. It survives the
// admin who added it leaving, and is revoked by removing it or by the team
// going away. Its replies and versions say "<name> · <team> team agent".
//
// Run with: node test/team-agent.test.js

const { loadWorker, makeEnv, req, putSession, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('team agents');
  const origin = { Origin: 'https://tdoc.dev' };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  async function call(path, opts) {
    const r = await worker.fetch(req(path, opts), env, ctx);
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  }

  // julie admins BeFreed and abby; bob is a member of both; dave is in
  // neither; erin was invited to one BeFreed doc but is not a member.
  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  const dave = await issue(worker, env, 'dave');
  const erin = await putSession(env, 'erin');
  const mkTeam = async (name) => (await call('/api/teams', { method: 'POST', cookie: julie.cookie, headers: origin, body: { name } })).body.team;
  const befreed = await mkTeam('BeFreed');
  const abby = await mkTeam('abby');
  for (const team of [befreed, abby]) {
    const joined = await call('/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: team.invite_url.split('/').pop() } });
    assert(joined.status === 200, `bob joins ${team.name}: ${joined.text}`);
  }
  const html = (slug, v = 1) => `<h1>${slug}</h1><p>${slug} v${v}: a sentence to comment on</p>`;
  const upload = (token, slug, extra = {}) => call('/api/upload', {
    method: 'POST', token,
    body: { slug, version: extra.version || 1, html: html(slug, extra.version || 1), meta: { title: slug, access: extra.access || { visibility: 'private', allowed_users: extra.allowed || [] } } },
  });
  for (const [slug, team, allowed] of [['befreed-report', befreed, ['erin']], ['abby-secret', abby, []]]) {
    assert((await upload(julie.token, slug, { allowed })).status === 200, `upload ${slug}`);
    assert((await call('/api/team/move', { method: 'POST', token: julie.token, body: { team: team.id, slugs: [slug] } })).status === 200, `move ${slug}`);
  }
  assert((await upload(julie.token, 'julie-notes')).status === 200, 'julie personal doc');
  assert((await upload(bob.token, 'bob-notes')).status === 200, 'bob personal doc');
  const comment = async (cookie, slug, text) => {
    const r = await call('/api/comments', { method: 'POST', cookie, body: { slug, version: 1, text, anchor: { kind: 'text', text: 'a sentence' } } });
    assert(r.status === 200, `comment on ${slug}: ${r.status} ${r.text}`);
    return r.body.id;
  };
  const reportComment = await comment(bob.cookie, 'befreed-report', 'add last week for comparison');
  const abbyComment = await comment(bob.cookie, 'abby-secret', 'is this number right?');
  const agentsOf = (team) => JSON.parse(env.META.map.get(`team:${team.id}`)).agents || [];

  let added = null;
  await t('adding is a team admin\'s, in the browser: not a member, not a token, not cross-site', async () => {
    const member = await call('/api/team/agents', { method: 'POST', cookie: bob.cookie, headers: origin, body: { id: befreed.id, name: 'vid3o' } });
    assert(member.status === 403 && member.body.error === 'admin_required', `member: ${member.status} ${member.text}`);
    const token = await call('/api/team/agents', { method: 'POST', token: julie.token, headers: origin, body: { id: befreed.id, name: 'vid3o' } });
    assert(token.status === 401 || token.status === 403, `admin token: ${token.status}`);
    const cross = await call('/api/team/agents', { method: 'POST', cookie: julie.cookie, headers: { Origin: 'https://evil.example' }, body: { id: befreed.id, name: 'vid3o' } });
    assert(cross.status === 403, `cross-site: ${cross.status}`);
    const outsider = await call('/api/team/agents', { method: 'POST', cookie: dave.cookie, headers: origin, body: { id: befreed.id, name: 'vid3o' } });
    assert(outsider.status === 404, `outsider: ${outsider.status}`);
    assert(!agentsOf(befreed).length, 'nothing was added');
  });

  await t('the admin gets one setup command; the list is visible to members, without secrets', async () => {
    const r = await call('/api/team/agents', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id: befreed.id, name: 'vid3o' } });
    assert(r.status === 200 && /^tdts_[a-f0-9]{48}$/.test(r.body.setup_code), r.text);
    assert(r.body.command.includes(`connect-team ${r.body.setup_code} --base https://tdoc.dev`), r.body.command);
    assert(r.body.agent.name === 'vid3o' && r.body.agent.connected === false, JSON.stringify(r.body.agent));
    added = r.body;
    const list = await call(`/api/team/agents?id=${befreed.id}`, { cookie: bob.cookie });
    assert(list.status === 200 && list.body.can_manage === false && list.body.agents.length === 1, list.text);
    assert(!list.text.includes('setup') && !list.text.includes('token_hash') && !list.text.includes('tdts_'), `list leaks: ${list.text}`);
    const nope = await call(`/api/team/agents?id=${befreed.id}`, { cookie: dave.cookie });
    assert(nope.status === 404, `outsider list: ${nope.status}`);
  });

  let agentToken = null;
  await t('the machine trades the code, once, for a token of the team\'s agent', async () => {
    const bad = await call('/api/team/agents/connect', { method: 'POST', body: { code: 'tdts_nope' } });
    assert(bad.status === 400, `bad code: ${bad.status}`);
    const r = await call('/api/team/agents/connect', { method: 'POST', body: { code: added.setup_code, device: 'befreed-box' } });
    assert(r.status === 200 && /^tdoc_/.test(r.body.token), r.text);
    assert(r.body.agent.display === 'vid3o · BeFreed team agent' && r.body.team.id === befreed.id, r.text);
    agentToken = r.body.token;
    const again = await call('/api/team/agents/connect', { method: 'POST', body: { code: added.setup_code } });
    assert(again.status === 404, `second use: ${again.status}`);
    const who = await call('/api/hosted/whoami', { token: agentToken });
    assert(who.status === 200 && who.body.team_agent.name === 'vid3o' && JSON.stringify(who.body.workspaces) === JSON.stringify([befreed.id]), who.text);
    // It is the team's, not julie's: her Settings -> Agents does not list it.
    const mine = await call('/api/me/tokens', { cookie: julie.cookie });
    assert(!mine.text.includes('vid3o'), `julie's token list shows the team agent: ${mine.text.slice(0, 300)}`);
  });

  await t('reach: its team\'s docs, nothing personal, no other team', async () => {
    assert((await call('/d/befreed-report/raw', { token: agentToken })).status === 200, 'team doc unreadable');
    for (const slug of ['abby-secret', 'julie-notes', 'bob-notes']) {
      const raw = await call(`/d/${slug}/raw`, { token: agentToken });
      assert(raw.status >= 400 && !raw.text.includes(`${slug} v1`), `${slug} leaked: ${raw.status}`);
      const c = await call(`/api/comments?slug=${slug}`, { token: agentToken });
      assert(c.status >= 400, `${slug} comments: ${c.status}`);
    }
    const teams = await call('/api/teams', { token: agentToken });
    assert(teams.status === 200 && teams.body.teams.length === 1 && teams.body.teams[0].id === befreed.id, teams.text);
    const over = await upload(agentToken, 'abby-secret', { version: 2 });
    assert(over.status === 403, `wrote into abby: ${over.status}`);
    const bobs = await upload(agentToken, 'bob-notes', { version: 2 });
    assert(bobs.status === 403, `wrote over bob's doc: ${bobs.status}`);
  });

  await t('it cannot mint or widen tokens, share, delete, move, invite or manage agents', async () => {
    const refused = [
      ['/api/hosted/token/scoped', { method: 'POST', body: { team: befreed.id } }],
      ['/api/hosted/token/scoped', { method: 'POST', body: { workspaces: [befreed.id] } }],
      ['/api/hosted/token', { method: 'POST', body: {} }],
      ['/api/doc/access', { method: 'PATCH', body: { slug: 'befreed-report', access: { visibility: 'public' } } }],
      ['/api/doc', { method: 'DELETE', body: { slug: 'befreed-report' } }],
      ['/api/team/move', { method: 'POST', body: { team: befreed.id, slugs: ['befreed-report'] } }],
      ['/api/team', { method: 'PATCH', body: { id: befreed.id, invites: ['mallory'] } }],
      ['/api/team/agents', { method: 'POST', body: { id: befreed.id, name: 'twin' } }],
      ['/api/team/billing', { method: 'POST', body: { id: befreed.id } }],
      ['/api/me/tokens', {}],
      ['/api/teams', { method: 'POST', body: { name: 'Sneaky' } }],
    ];
    for (const [path, opts] of refused) {
      const r = await call(path, { token: agentToken, ...opts });
      assert(r.status === 401 || r.status === 403, `${opts.method || 'GET'} ${path} -> ${r.status} ${r.text.slice(0, 160)}`);
    }
    const meta = JSON.parse(env.META.map.get('meta:befreed-report'));
    assert(meta.access.visibility === 'private' && meta.workspace_id === befreed.id, 'doc changed');
    assert(agentsOf(befreed).length === 1, 'agent list changed');
  });

  await t('a new doc it publishes lands in its team, authored by the agent, not a person', async () => {
    const r = await upload(agentToken, 'daily-report');
    assert(r.status === 200, r.text);
    const meta = JSON.parse(env.META.map.get('meta:daily-report'));
    assert(meta.workspace_id === befreed.id, `filed in ${meta.workspace_id}`);
    assert(meta.hosted.team_agent && meta.hosted.team_agent.name === 'vid3o' && !meta.hosted.github_login && !meta.hosted.owner_key, JSON.stringify(meta.hosted));
    assert((await call('/d/daily-report/raw', { cookie: bob.cookie })).status === 200, 'members cannot read it');
  });

  const register = () => call('/api/notify/local/register', { method: 'POST', token: agentToken, body: { device: 'befreed-box', clis: ['claude'] } });
  const pendingFor = (token) => call('/api/notify/local/pending?device=befreed-box', { token });
  let target = null;
  await t('every member sees "Send to team agent" on a team doc once its daemon checked in', async () => {
    const before = await call('/api/notify/targets?slug=befreed-report', { cookie: bob.cookie });
    assert(before.status === 200 && !before.body.default && before.body.reason === 'no_team_agent', `before register: ${before.text}`);
    assert((await register()).status === 200, 'register');
    const r = await call('/api/notify/targets?slug=befreed-report', { cookie: bob.cookie });
    target = r.body.default;
    assert(r.status === 200 && target && target.provider === 'local' && target.team_agent.name === 'vid3o', r.text);
    assert(target.owner.display === 'BeFreed team agent' && target.status === 'active', JSON.stringify(target));
    const admin = await call('/api/notify/targets?slug=befreed-report', { cookie: julie.cookie });
    assert(admin.body.default && admin.body.default.team_agent, `admin default: ${admin.text}`);
  });

  await t('outsiders and readers who are not members cannot call it', async () => {
    for (const [who, cookie] of [['dave', dave.cookie], ['erin', erin]]) {
      const targets = await call('/api/notify/targets?slug=befreed-report', { cookie });
      assert(targets.status !== 200 || !JSON.stringify(targets.body).includes('vid3o'), `${who} sees the agent: ${targets.text}`);
      const sent = await call('/api/notify/handoff', { method: 'POST', cookie, body: { slug: 'befreed-report', comment_ids: [reportComment], recipient: target } });
      assert(sent.status === 401 || sent.status === 403, `${who} sent: ${sent.status} ${sent.text}`);
    }
    assert(!(await pendingFor(agentToken)).body.pending.length, 'something reached the agent');
  });

  await t('never from another team\'s doc, even for a member of both', async () => {
    const targets = await call('/api/notify/targets?slug=abby-secret', { cookie: bob.cookie });
    assert(!JSON.stringify(targets.body).includes('vid3o'), `abby doc offers the BeFreed agent: ${targets.text}`);
    const sent = await call('/api/notify/handoff', { method: 'POST', cookie: bob.cookie, body: { slug: 'abby-secret', comment_ids: [abbyComment], recipient: target } });
    assert(sent.status === 403, `abby handoff: ${sent.status} ${sent.text}`);
    const byAdmin = await call('/api/notify/handoff', { method: 'POST', cookie: julie.cookie, body: { slug: 'abby-secret', comment_ids: [abbyComment], recipient: target } });
    const records = JSON.parse(env.META.map.get('handoffs:abby-secret') || '[]');
    assert(!records.some((h) => h.team_agent || h.by === target.team_agent.id), `abby handoff went to the agent: ${byAdmin.text}`);
    assert(!(await pendingFor(agentToken)).body.pending.length, 'the agent got abby work');
    // Nor can the agent answer on abby's doc.
    const reply = await call('/api/agent/reply', { method: 'POST', token: agentToken, body: { slug: 'abby-secret', parent_id: abbyComment, text: 'hi', status: 'answered' } });
    assert(reply.status === 403, `agent replied on abby: ${reply.status}`);
  });

  let handoffId = null;
  await t('a member sends a comment; it reaches only the agent\'s queue, marked with who sent it', async () => {
    const sent = await call('/api/notify/handoff', { method: 'POST', cookie: bob.cookie, body: { slug: 'befreed-report', comment_ids: [reportComment], recipient: target } });
    assert(sent.status === 200 && sent.body.delivery.status === 'queued', sent.text);
    handoffId = sent.body.handoff_id;
    const rec = JSON.parse(env.META.map.get('handoffs:befreed-report')).find((h) => h.handoff_id === handoffId);
    assert(rec.by === target.team_agent.id && rec.sent_by === bob.account_id && rec.team_agent.name === 'vid3o', JSON.stringify(rec));
    const queue = await pendingFor(agentToken);
    assert(queue.status === 200 && queue.body.pending.length === 1 && queue.body.pending[0].handoff_id === handoffId, queue.text);
    for (const person of [julie, bob]) {
      const theirs = await call('/api/notify/local/pending', { token: person.token });
      assert(!theirs.text.includes(handoffId), `${person.login}'s daemon would run it`);
    }
    const c = (await call('/api/comments?slug=befreed-report&version=1', { cookie: bob.cookie })).body.find((x) => x.id === reportComment);
    assert(c.handoff_to.agent_name === 'vid3o' && c.handoff_to.team_agent, JSON.stringify(c.handoff_to));
  });

  await t('its reply posts as a normal comment, attributed to the team agent; ack and resolve work', async () => {
    assert((await call('/api/notify/ack', { method: 'POST', token: agentToken, body: { slug: 'befreed-report', handoff_id: handoffId } })).status === 200, 'ack');
    const reply = await call('/api/agent/reply', {
      method: 'POST', token: agentToken,
      headers: { 'X-Tdoc-Agent': 'local/befreed-box/befreed-box_claude' },
      body: { slug: 'befreed-report', parent_id: reportComment, text: 'Added last week next to this week.', status: 'applied', agent_login: 'claude' },
    });
    assert(reply.status === 200, reply.text);
    assert(reply.body.author.owner.display === 'BeFreed team agent' && reply.body.author.team_agent.name === 'vid3o', JSON.stringify(reply.body.author));
    assert(!JSON.stringify(reply.body.author).includes('julie'), `reply names a person: ${JSON.stringify(reply.body.author)}`);
    // Everyone who can see the doc sees it: erin is only invited.
    const seen = await call('/api/comments?slug=befreed-report&version=1', { cookie: erin });
    assert(seen.status === 200 && seen.text.includes('Added last week next to this week.'), `erin: ${seen.status}`);
    assert((await call('/api/notify/resolve', { method: 'POST', token: agentToken, body: { slug: 'befreed-report', handoff_id: handoffId } })).status === 200, 'resolve');
    assert(!(await pendingFor(agentToken)).body.pending.length, 'still pending after resolve');
  });

  await t('its edits are attributed to it on the version', async () => {
    const r = await upload(agentToken, 'befreed-report', { version: 2 });
    assert(r.status === 200, r.text);
    const meta = JSON.parse(env.META.map.get('meta:befreed-report'));
    const v2 = meta.versions.find((v) => v.n === 2);
    assert(v2 && v2.team_agent && v2.team_agent.name === 'vid3o', JSON.stringify(v2));
    assert(meta.hosted.github_login === 'julie', 'a teammate\'s version moved the byline');
  });

  // Review #817 (4): a person's narrowed connection that registered a
  // computer became that person's default Send to agent target everywhere.
  await t('a person\'s narrowed connection cannot run a daemon (register, poll, fail): only a team agent can', async () => {
    const scoped = (await call('/api/hosted/token/scoped', { method: 'POST', token: julie.token, body: { team: abby.id } })).body.token;
    for (const [path, opts] of [
      ['/api/notify/local/register', { method: 'POST', body: { device: 'third-party', clis: ['claude'] } }],
      ['/api/notify/local/pending', {}],
      ['/api/notify/local/fail', { method: 'POST', body: { slug: 'abby-secret', handoff_id: 'h_x' } }],
    ]) {
      const r = await call(path, { token: scoped, ...opts });
      assert(r.status === 403, `${path}: ${r.status} ${r.text.slice(0, 120)}`);
    }
    const targets = await call('/api/notify/targets?slug=julie-notes', { cookie: julie.cookie });
    assert(!targets.text.includes('third-party'), `registered anyway: ${targets.text}`);
  });

  await t('it survives the admin who added it leaving the team', async () => {
    const detail = (await call(`/api/team?id=${befreed.id}`, { cookie: julie.cookie })).body.team;
    const bobId = detail.members.find((m) => m.key === 'bob').account_id;
    const julieId = detail.members.find((m) => m.key === 'julie').account_id;
    assert((await call('/api/team/role', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id: befreed.id, account_id: bobId, role: 'admin' } })).status === 200, 'promote bob');
    const left = await call('/api/team/remove', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id: befreed.id, account_id: julieId } });
    assert(left.status === 200 && left.body.left, left.text);
    assert((await call('/api/hosted/whoami', { token: agentToken })).status === 200, 'token died with julie');
    assert((await call('/d/befreed-report/raw', { token: agentToken })).status === 200, 'lost its team');
    const targets = await call('/api/notify/targets?slug=befreed-report', { cookie: bob.cookie });
    assert(targets.body.default && targets.body.default.team_agent, 'no longer offered');
    // And julie, gone, cannot remove it.
    const r = await call('/api/team/agents', { method: 'DELETE', cookie: julie.cookie, headers: origin, body: { id: befreed.id, agent: target.team_agent.id } });
    assert(r.status === 404, `ex-admin removed it: ${r.status}`);
  });

  await t('a team admin removes it: the token stops at once, and its queue and registrations go', async () => {
    const member = await call('/api/team/agents', { method: 'DELETE', cookie: (await putSession(env, 'nobody')), headers: origin, body: { id: befreed.id, agent: target.team_agent.id } });
    assert(member.status === 404, `stranger: ${member.status}`);
    const r = await call('/api/team/agents', { method: 'DELETE', cookie: bob.cookie, headers: origin, body: { id: befreed.id, agent: target.team_agent.id } });
    assert(r.status === 200 && r.body.agents.length === 0, r.text);
    for (const [path, opts] of [['/api/hosted/whoami', {}], ['/api/notify/local/pending', {}], ['/d/befreed-report/raw', {}], ['/api/agent/reply', { method: 'POST', body: { slug: 'befreed-report', parent_id: reportComment, text: 'late', status: 'answered' } }]]) {
      const res = await call(path, { token: agentToken, ...opts });
      assert(res.status === 401 || res.status === 403 || res.status === 404, `${path} after revoke: ${res.status}`);
    }
    // The docs it wrote stay with the team (and their author index with them).
    const left = [...env.META.map.keys()].filter((k) => k.includes(target.team_agent.id) && /^(account-notify|local-pending|local-agents-seen):/.test(k));
    assert(![...env.META.map.entries()].some(([k, v]) => k.startsWith('hosted-token:') && v.includes(target.team_agent.id)), 'its token record is still stored');
    assert(!left.length, `keys left behind: ${left}`);
    const targets = await call('/api/notify/targets?slug=befreed-report', { cookie: bob.cookie });
    // bob is an admin now, so it is his own (empty) connections that speak.
    assert(!targets.body.default && !targets.text.includes('vid3o'), targets.text);
  });

  // The machine's half for real: bin/tdoc-daemon against this worker over
  // HTTP, with a stand-in `claude` that answers through the real
  // bin/tdoc-agent-reply (the model is the only thing faked).
  await t('tdoc-daemon connect-team: refuses a personal machine, then connects, runs and replies as the team agent', async () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const http = require('http');
    const { spawn } = require('child_process');
    const server = http.createServer(async (inReq, res) => {
      const chunks = [];
      for await (const c of inReq) chunks.push(c);
      const r = await worker.fetch(new Request(`https://tdoc.dev${inReq.url}`, {
        method: inReq.method, headers: { ...inReq.headers, host: 'tdoc.dev' },
        body: chunks.length && !['GET', 'HEAD'].includes(inReq.method) ? Buffer.concat(chunks) : undefined,
      }), env, ctx);
      res.statusCode = r.status;
      res.setHeader('content-type', r.headers.get('content-type') || 'application/json');
      res.end(Buffer.from(await r.arrayBuffer()));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const world = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-team-agent-'));
    const HOME = path.join(world, 'home');
    const FAKEBIN = path.join(world, 'bin');
    fs.mkdirSync(path.join(HOME, '.tdoc'), { recursive: true });
    fs.mkdirSync(FAKEBIN, { recursive: true });
    fs.writeFileSync(path.join(FAKEBIN, 'claude'), `#!/usr/bin/env bash
set -eu
prompt="$(cat)"
slug="$(printf '%s' "$prompt" | sed -n 's/.*for the slug "\\([^"]*\\)".*/\\1/p' | head -1)"
ids="$(printf '%s' "$prompt" | sed -n 's/^This handoff covers comment ids: \\([^ .,]*\\).*/\\1/p' | head -1)"
bash "$TDOC_SKILL_DIR/bin/tdoc-agent-reply" --slug "$slug" --parent "$ids" --text "Done by the team box." --status applied --login claude >/dev/null
`);
    fs.chmodSync(path.join(FAKEBIN, 'claude'), 0o755);
    const run = (args) => new Promise((resolve) => {
      const child = spawn('bash', [path.join(__dirname, '..', 'bin', 'tdoc-daemon'), ...args], {
        env: { ...process.env, HOME, PATH: `${FAKEBIN}${path.delimiter}${process.env.PATH}`, TDOC_DIR: path.join(world, 'tdocs'), TDOC_DAEMON_DIR: path.join(HOME, '.tdoc', 'daemon'), TDOC_DAEMON_OS: 'linux' },
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => resolve({ code, out }));
    });
    try {
      const add = await call('/api/team/agents', { method: 'POST', cookie: bob.cookie, headers: origin, body: { id: befreed.id, name: 'box' } });
      assert(add.status === 200, add.text);
      const config = path.join(HOME, '.tdoc', 'published.json');
      fs.writeFileSync(config, JSON.stringify({ platform: 'hosted', base, upload_token: bob.token, github_login: 'bob' }));
      const refused = await run(['connect-team', add.body.setup_code, '--base', base, '--no-start']);
      assert(refused.code !== 0 && /without personal data/.test(refused.out), refused.out);
      assert(JSON.parse(fs.readFileSync(config, 'utf8')).upload_token === bob.token, 'the personal sign-in was replaced');
      fs.unlinkSync(config);
      const ok = await run(['connect-team', add.body.setup_code, '--base', base, '--no-start']);
      assert(ok.code === 0 && ok.out.includes('box · BeFreed team agent'), ok.out);
      const saved = JSON.parse(fs.readFileSync(config, 'utf8'));
      assert(saved.team_agent.team === befreed.id && /^tdoc_/.test(saved.upload_token) && (fs.statSync(config).mode & 0o777) === 0o600, JSON.stringify(saved));
      // First poll registers the machine; then a member sends it a comment.
      const first = await run(['once', '--cli', 'claude', '--device', 'team-box']);
      assert(first.code === 0, first.out);
      const targets = await call('/api/notify/targets?slug=befreed-report', { cookie: bob.cookie });
      const box = [targets.body.default, ...(targets.body.candidates || [])].find((x) => x && x.team_agent && x.team_agent.name === 'box');
      assert(box, targets.text);
      const fresh = await comment(bob.cookie, 'befreed-report', 'one more chart please');
      const sent = await call('/api/notify/handoff', { method: 'POST', cookie: bob.cookie, body: { slug: 'befreed-report', comment_ids: [fresh], recipient: box } });
      assert(sent.status === 200, sent.text);
      const polled = await run(['once', '--cli', 'claude', '--device', 'team-box']);
      assert(polled.code === 0 && /done h_/.test(polled.out), polled.out);
      const thread = (await call('/api/comments?slug=befreed-report&version=1', { cookie: bob.cookie })).body.find((x) => x.id === fresh);
      const reply = JSON.stringify(thread);
      assert(reply.includes('Done by the team box.') && reply.includes('BeFreed team agent') && thread.handoff_status === 'resolved', reply.slice(0, 600));
    } finally {
      server.close();
      fs.rmSync(world, { recursive: true, force: true });
    }
  });

  await t('deleting the team revokes its agents', async () => {
    const add = await call('/api/team/agents', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id: abby.id, name: 'abby-bot' } });
    const tok = (await call('/api/team/agents/connect', { method: 'POST', body: { code: add.body.setup_code } })).body.token;
    assert((await call('/api/hosted/whoami', { token: tok })).status === 200, 'connected');
    await env.META.delete(`team:${abby.id}`);
    assert((await call('/api/hosted/whoami', { token: tok })).status === 401, 'token outlived its team');
  });

  // ---- Review #817: races, sharing, same-named computers, identity ----
  {
    const env2 = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
    const call2 = async (path, opts) => {
      const r = await worker.fetch(req(path, opts), env2, ctx);
      const text = await r.text();
      let body = null; try { body = JSON.parse(text); } catch {}
      return { status: r.status, body, text };
    };
    const ann = await issue(worker, env2, 'ann');
    const ben = await issue(worker, env2, 'ben');
    const cat = await issue(worker, env2, 'cat');
    const crew = (await call2('/api/teams', { method: 'POST', cookie: ann.cookie, headers: origin, body: { name: 'Crew' } })).body.team;
    for (const u of [ben, cat]) await call2('/api/team/join', { method: 'POST', cookie: u.cookie, body: { token: crew.invite_url.split('/').pop() } });
    await call2('/api/upload', { method: 'POST', token: ann.token, body: { slug: 'crew-doc', version: 1, html: html('crew-doc'), meta: { title: 'crew-doc', access: { visibility: 'private' } } } });
    await call2('/api/team/move', { method: 'POST', token: ann.token, body: { team: crew.id, slugs: ['crew-doc'] } });
    const teamNow = () => JSON.parse(env2.META.map.get(`team:${crew.id}`));
    const add = async (name) => (await call2('/api/team/agents', { method: 'POST', cookie: ann.cookie, headers: origin, body: { id: crew.id, name } })).body;
    const connect = (code, device = 'box') => call2('/api/team/agents/connect', { method: 'POST', body: { code, device } });
    const works = async (r) => !!(r.body && r.body.token) && (await call2('/api/hosted/whoami', { token: r.body.token })).status === 200;

    // Runs `during` the moment connect writes the token record: before the
    // fix that was between reading the team and saving it, so a save from a
    // stale copy undid whatever `during` changed.
    const duringTokenWrite = (during) => {
      const put = env2.META.put.bind(env2.META);
      let fired = false;
      env2.META.put = async (k, v, o) => {
        if (!fired && k.startsWith('hosted-token:') && String(v).includes('team_agent')) { fired = true; await during(); }
        return put(k, v, o);
      };
      return () => { env2.META.put = put; };
    };

    await t('(1) connecting at the same moment a member is removed does not bring the member back', async () => {
      const a = await add('racer');
      const catId = teamNow().members.find((m) => m.key === 'cat').account_id;
      let rm = null;
      const restore = duringTokenWrite(async () => {
        rm = await call2('/api/team/remove', { method: 'POST', cookie: ann.cookie, headers: origin, body: { id: crew.id, account_id: catId } });
      });
      const cn = await connect(a.setup_code);
      restore();
      assert(rm && rm.status === 200, rm && rm.text);
      assert(!teamNow().members.some((m) => m.key === 'cat'), `cat restored (connect ${cn.status})`);
      const up = await call2('/api/upload', { method: 'POST', token: cat.token, body: { slug: 'crew-doc', version: 2, html: html('crew-doc', 2), meta: { title: 'crew-doc' } } });
      assert(up.status === 403, `removed member still writes: ${up.status}`);
    });

    await t('(1) connecting at the same moment the agent is removed leaves it removed, token dead', async () => {
      const a = await add('doomed');
      const id = teamNow().agents.find((x) => x.name === 'doomed').id;
      let del = null;
      const restore = duringTokenWrite(async () => {
        del = await call2('/api/team/agents', { method: 'DELETE', cookie: ann.cookie, headers: origin, body: { id: crew.id, agent: id } });
      });
      const cn = await connect(a.setup_code);
      restore();
      assert(del && del.status === 200, del && del.text);
      assert(!teamNow().agents.some((x) => x.id === id), `agent resurrected (connect ${cn.status})`);
      assert(!(await works(cn)), 'its token works');
    });

    await t('(1) one setup code, two machines at once: exactly one gets a working token', async () => {
      const a = await add('twice');
      const [r1, r2] = await Promise.all([connect(a.setup_code, 'm1'), connect(a.setup_code, 'm2')]);
      const ok = [await works(r1), await works(r2)];
      assert(ok.filter(Boolean).length === 1, `working tokens: ${ok} (${r1.status}, ${r2.status})`);
      const loser = ok[0] ? r2 : r1;
      assert(loser.status === 404 || loser.status === 409, `loser: ${loser.status} ${loser.text}`);
    });

    await t('(1) a redeem whose save lost to another machine\'s gets 409 and no token', async () => {
      const a = await add('raced');
      const put = env2.META.put.bind(env2.META);
      let fired = false;
      env2.META.put = async (k, v, o) => {
        await put(k, v, o);
        // Another machine's save lands right after this one.
        if (!fired && k === `team:${crew.id}` && String(v).includes('"name":"raced"') && String(v).includes('token_hash')) {
          fired = true;
          const team = JSON.parse(v);
          team.agents = team.agents.map((x) => (x.name === 'raced' ? { ...x, token_hash: 'f'.repeat(64) } : x));
          await put(k, JSON.stringify(team), o);
        }
      };
      const r = await connect(a.setup_code);
      env2.META.put = put;
      assert(r.status === 409 && !r.body.token, `${r.status} ${r.text}`);
      assert(![...env2.META.map.entries()].some(([k, v]) => k.startsWith('hosted-token:') && v.includes(a.agent.id)), 'a token record was written for the loser');
    });

    // Fresh slots for the rest.
    for (const a of teamAgents(teamNow())) await call2('/api/team/agents', { method: 'DELETE', cookie: ann.cookie, headers: origin, body: { id: crew.id, agent: a.id } });
    function teamAgents(team) { return team.agents || []; }
    const one = await add('one');
    const tokOne = (await connect(one.setup_code, 'box')).body.token;
    const two = await add('two');
    const tokTwo = (await connect(two.setup_code, 'box')).body.token;

    await t('(2) a team agent cannot publish a new doc wider than its team, nor widen one by publishing', async () => {
      const r = await call2('/api/upload', { method: 'POST', token: tokOne, body: { slug: 'agent-public', version: 1, html: html('agent-public'), meta: { title: 'x', access: { visibility: 'public', allowed_users: ['mallory'] } } } });
      assert(r.status === 200, r.text);
      const meta = JSON.parse(env2.META.map.get('meta:agent-public'));
      assert(meta.access.visibility === 'private' && meta.access.team === true && !(meta.access.allowed_users || []).length, JSON.stringify(meta.access));
      assert((await call2('/d/agent-public/raw', {})).status !== 200, 'anyone reads it');
      const v2 = await call2('/api/upload', { method: 'POST', token: tokOne, body: { slug: 'crew-doc', version: 2, html: html('crew-doc', 2), meta: { title: 'crew-doc', access: { visibility: 'public' } } } });
      assert(v2.status === 200, v2.text);
      assert(JSON.parse(env2.META.map.get('meta:crew-doc')).access.visibility === 'private', 'publish widened an existing team doc');
    });

    await t('(3) two team agents on computers of the same name: the handoff goes to the one picked', async () => {
      for (const tok of [tokOne, tokTwo]) await call2('/api/notify/local/register', { method: 'POST', token: tok, body: { device: 'box', clis: ['claude'] } });
      const targets = await call2('/api/notify/targets?slug=crew-doc', { cookie: ben.cookie });
      const all = [targets.body.default, ...(targets.body.candidates || [])].filter(Boolean);
      const pick = all.find((x) => x.team_agent && x.team_agent.name === 'two');
      assert(pick && all.length === 2, targets.text);
      const c = (await call2('/api/comments', { method: 'POST', cookie: ben.cookie, body: { slug: 'crew-doc', version: 1, text: 'for two', anchor: { kind: 'text', text: 'a sentence' } } })).body.id;
      const sent = await call2('/api/notify/handoff', { method: 'POST', cookie: ben.cookie, body: { slug: 'crew-doc', comment_ids: [c], recipient: pick } });
      assert(sent.status === 200, sent.text);
      const q1 = (await call2('/api/notify/local/pending?device=box', { token: tokOne })).body.pending.length;
      const q2 = (await call2('/api/notify/local/pending?device=box', { token: tokTwo })).body.pending.length;
      assert(q1 === 0 && q2 === 1, `queues one=${q1} two=${q2}`);
    });

    await t('(5) a team agent cannot sign a reply as someone else', async () => {
      const c = (await call2('/api/comments', { method: 'POST', cookie: ben.cookie, body: { slug: 'crew-doc', version: 1, text: 'who answers', anchor: { kind: 'text', text: 'a sentence' } } })).body.id;
      const r = await call2('/api/agent/reply', { method: 'POST', token: tokOne, body: { slug: 'crew-doc', parent_id: c, text: 'done', agent_login: 'ben', agent_name: 'Ben', agent_avatar_url: 'https://github.com/ben.png' } });
      assert(r.status === 200, r.text);
      const a = r.body.author;
      assert(a.login === `team-agent:${one.agent.id}` && a.name === 'one' && a.kind === 'agent' && !/ben/i.test(JSON.stringify(a)), JSON.stringify(a));
    });

    await t('(6) a setup command that expired unused frees its slot and leaves no waiting row', async () => {
      const a = await add('never');
      const t2 = teamNow();
      t2.agents = t2.agents.map((x) => (x.id === a.agent.id ? { ...x, setup_expires: new Date(Date.now() - 1000).toISOString() } : x));
      await env2.META.put(`team:${crew.id}`, JSON.stringify(t2));
      const list = await call2(`/api/team/agents?id=${crew.id}`, { cookie: ann.cookie });
      assert(!list.text.includes('never'), list.text);
      assert(!teamNow().agents.some((x) => x.id === a.agent.id), 'still stored');
      assert((await connect(a.setup_code)).status === 404, 'expired code still connects');
    });

    await t('(7) --team names its own team; the person-shaped catalog and team feed are refused, not 401', async () => {
      const r = await call2('/api/upload', { method: 'POST', token: tokOne, body: { slug: 'hinted', version: 1, team: 'Crew', html: html('hinted'), meta: { title: 'hinted' } } });
      assert(r.status === 200 && JSON.parse(env2.META.map.get('meta:hinted')).workspace_id === crew.id, `${r.status} ${r.text}`);
      for (const path of ['/api/me', `/api/team/comments?id=${crew.id}`]) {
        const res = await call2(path, { token: tokOne });
        assert(res.status === 403 && res.body.error === 'token_scope', `${path}: ${res.status} ${res.text.slice(0, 120)}`);
      }
    });

    await t('(8) connect-team: https only (http just for this machine); replacing any sign-in needs --replace', async () => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const { spawnSync } = require('child_process');
      const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-connect-team-'));
      fs.mkdirSync(path.join(HOME, '.tdoc'), { recursive: true });
      const code = `tdts_${'a'.repeat(48)}`;
      const run = (...args) => spawnSync('bash', [path.join(__dirname, '..', 'bin', 'tdoc-daemon'), 'connect-team', code, ...args, '--no-start'], { encoding: 'utf8', env: { ...process.env, HOME } });
      try {
        const plain = run('--base', 'http://tdoc.example.com');
        assert(plain.status !== 0 && /https/.test(plain.stderr), plain.stderr);
        const config = path.join(HOME, '.tdoc', 'published.json');
        fs.writeFileSync(config, JSON.stringify({ platform: 'hosted', base: 'https://tdoc.dev', upload_token: 'tdoc_x', team_agent: { name: 'old', team_name: 'Crew' } }));
        const again = run('--base', 'https://tdoc.dev');
        assert(again.status !== 0 && /old · Crew team agent.*--replace/.test(again.stderr), again.stderr);
        assert(JSON.parse(fs.readFileSync(config, 'utf8')).upload_token === 'tdoc_x', 'config replaced');
      } finally { fs.rmSync(HOME, { recursive: true, force: true }); }
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
