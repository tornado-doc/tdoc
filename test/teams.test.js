// JUL-71 teams: private team records, admin/member roles, last-admin guard,
// team-owned docs that keep their human author, and team-wide doc access.
// Runs worker.js in-process with fake bindings (helpers/worker-harness.js).

const { loadWorker, makeEnv, req, issue, bootData } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

async function sessionFor(env, login) {
  const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await env.META.put(`session:${id}`, JSON.stringify({
    login, name: login, avatar_url: '', account_id: `acct-${login}`, created: new Date().toISOString(),
  }));
  return `tdoc_sid=${id}`;
}

async function seedDoc(env, slug, owner, access = { visibility: 'private', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] }) {
  const created = '2026-01-01T00:00:00.000Z';
  await env.META.put(`meta:${slug}`, JSON.stringify({
    title: slug, slug, created, versions: [{ n: 1, created }],
    hosted: { account_id: `acct-${owner}`, github_login: owner },
    access,
  }));
  await env.DOCS.put(`docs/${slug}/v1/index.html`, `<h1>${slug}</h1>`);
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (path, opts = {}) => {
    const r = await worker.fetch(req(path, opts), env, {});
    let body = null;
    try { body = await r.clone().json(); } catch {}
    return { status: r.status, body, r };
  };
  console.log('teams (JUL-71)');

  const alice = await sessionFor(env, 'alice');
  const bob = await sessionFor(env, 'bob');
  const carol = await sessionFor(env, 'carol');
  const dave = await sessionFor(env, 'dave');
  await seedDoc(env, 'plan', 'alice');
  await seedDoc(env, 'bob-notes', 'bob');
  await seedDoc(env, 'solo', 'alice');

  let team = null;
  let token = '';

  await t('creating a team makes the creator its only admin; anonymous is refused', async () => {
    const anon = await call('/api/teams', { method: 'POST', body: { name: 'Acme' } });
    assert(anon.status === 401, `anon ${anon.status}`);
    const bad = await call('/api/teams', { method: 'POST', cookie: alice, body: { name: '   ' } });
    assert(bad.status === 400, `blank name ${bad.status}`);
    const res = await call('/api/teams', { method: 'POST', cookie: alice, body: { name: 'Acme', invites: ['bob', 'Carol@Example.com'] } });
    assert(res.status === 200, `create ${res.status} ${JSON.stringify(res.body)}`);
    team = res.body.team;
    assert(team.role === 'admin' && team.members.length === 1 && team.members[0].me, 'creator is admin');
    assert(team.invites.join(',') === 'bob,carol@example.com', `invites ${team.invites}`);
    assert(/\/team\/join\/[a-f0-9]{32}$/.test(team.invite_url), 'admin sees invite link');
    token = team.invite_url.split('/').pop();
  });

  await t('a non-member cannot see the team at all', async () => {
    const res = await call(`/api/team?id=${team.id}`, { cookie: bob });
    assert(res.status === 404, `bob ${res.status}`);
    const list = await call('/api/teams', { cookie: bob });
    assert(list.status === 200 && list.body.teams.length === 0, 'bob has no teams');
  });

  await t('join page: anonymous gets sign-in, a bad token is a dead end', async () => {
    const anon = await call(`/team/join/${token}`);
    assert(anon.status === 200 && (await anon.r.text()).includes('Join Acme'), 'anon sign-in page');
    const dead = await call(`/team/join/${'0'.repeat(32)}`);
    assert(dead.status === 404, `dead ${dead.status}`);
  });

  await t('joining by link adds a member and clears their pending invite', async () => {
    const res = await call('/api/team/join', { method: 'POST', cookie: bob, body: { token } });
    assert(res.status === 200 && res.body.team.role === 'member', `join ${res.status}`);
    await call('/api/team/join', { method: 'POST', cookie: carol, body: { token } });
    const detail = await call(`/api/team?id=${team.id}`, { cookie: bob });
    assert(detail.status === 200 && detail.body.team.members.length === 3, 'three members');
    assert(!detail.body.team.invites.includes('bob'), 'bob invite cleared');
    assert(!detail.body.team.invite_url, 'members do not get the invite link');
    const page = await call(`/team/join/${token}`, { cookie: bob });
    assert(page.status === 302 && page.r.headers.get('Location') === `/me?team=${team.id}`, 'member is sent to the team');
  });

  await t('only the author can move a doc into a team', async () => {
    const notMine = await call('/api/team/move', { method: 'POST', cookie: bob, body: { slugs: ['plan'], team: team.id } });
    assert(notMine.status === 403, `bob moved alice's doc ${notMine.status}`);
    const outsider = await call('/api/team/move', { method: 'POST', cookie: dave, body: { slugs: ['plan'], team: team.id } });
    assert(outsider.status !== 200, 'non-member move refused');
    const ok = await call('/api/team/move', { method: 'POST', cookie: alice, body: { slugs: ['plan'], team: team.id } });
    assert(ok.status === 200, `move ${ok.status}`);
    const okBob = await call('/api/team/move', { method: 'POST', cookie: bob, body: { slugs: ['bob-notes'], team: team.id } });
    assert(okBob.status === 200, `bob move ${okBob.status}`);
    const meta = JSON.parse(await env.META.get('meta:plan'));
    assert(meta.workspace_id === team.id && meta.access.team === true, 'team owns it, team access on');
    assert(meta.hosted.account_id === 'acct-alice', 'author unchanged');
  });

  await t('moving between workspaces clears old personal folder filing', async () => {
    await seedDoc(env, 'folder-trip', 'alice');
    const created = await call('/api/folders', { method: 'POST', cookie: alice, body: { name: 'Old folder' } });
    assert(created.status === 200, `folder ${created.status}`);
    const folder = created.body.folder.id;
    const filed = await call('/api/folders/move', { method: 'POST', cookie: alice, body: { slugs: ['folder-trip'], folder } });
    assert(filed.status === 200, `file ${filed.status}`);
    const intoTeam = await call('/api/team/move', { method: 'POST', cookie: alice, body: { slugs: ['folder-trip'], team: team.id } });
    assert(intoTeam.status === 200, `into team ${intoTeam.status}`);
    const back = await call('/api/team/move', { method: 'POST', cookie: alice, body: { slugs: ['folder-trip'], team: null } });
    assert(back.status === 200, `back ${back.status}`);
    const me = await call('/api/me', { cookie: alice });
    assert(me.body.docs.find((doc) => doc.slug === 'folder-trip')?.folder === '', 'doc returned to the My docs root');
  });

  await t('a member creates a doc straight into the team; outsiders cannot', async () => {
    const outsider = await call('/api/doc/create', { method: 'POST', cookie: dave, body: { team: team.id } });
    assert(outsider.status === 403, `outsider ${outsider.status}`);
    const res = await call('/api/doc/create', { method: 'POST', cookie: bob, body: { team: team.id } });
    assert(res.status === 200 && res.body.slug, `create ${res.status} ${JSON.stringify(res.body)}`);
    const meta = JSON.parse(await env.META.get(`meta:${res.body.slug}`));
    assert(meta.workspace_id === team.id && meta.access.team === true && meta.access.visibility === 'private', 'team-owned, team access');
    assert(meta.hosted.github_login === 'bob', 'creator is the author');
    const asAlice = await call(`/d/${res.body.slug}/v/1`, { cookie: alice });
    assert(asAlice.status === 200, `teammate read ${asAlice.status}`);
    const personal = await call('/api/doc/create', { method: 'POST', cookie: bob, body: {} });
    const pmeta = JSON.parse(await env.META.get(`meta:${personal.body.slug}`));
    assert(!pmeta.workspace_id && !pmeta.access?.team, 'no team means a personal doc');
  });

  await t('team members read a private team doc; outsiders do not', async () => {
    const asBob = await call('/d/plan/v/1', { cookie: bob });
    assert(asBob.status === 200, `bob ${asBob.status}`);
    const asDave = await call('/d/plan/v/1', { cookie: dave });
    assert(asDave.status === 403, `dave ${asDave.status}`);
  });

  await t('every member edits a team doc; only admins can use their own agents; outsiders cannot', async () => {
    const html = '<!doctype html><html><head><title>plan</title></head><body><h1>plan</h1><p>bob was here</p></body></html>';
    const outsider = await call('/api/doc/versions', { method: 'POST', cookie: dave, body: { slug: 'plan', baseVersion: 1, html } });
    assert(outsider.status === 403 || outsider.status === 401, `outsider save ${outsider.status}`);
    const saved = await call('/api/doc/versions', { method: 'POST', cookie: bob, body: { slug: 'plan', baseVersion: 1, html } });
    assert(saved.status === 200, `member save ${saved.status} ${JSON.stringify(saved.body)}`);
    const meta = JSON.parse(await env.META.get('meta:plan'));
    assert(meta.versions.length === 2 && meta.hosted.account_id === 'acct-alice', 'new version, same author');
    const boot = await (await worker.fetch(req('/d/plan/v/2', { cookie: bob }), env, {})).text();
    assert(/"canEdit":true/.test(boot), 'member gets the editor');

    const local = (device) => ({ provider: 'local', server_id: device, agent_sub: `${device}_claude`, device, cli: 'claude', agent_name: `claude on ${device}` });
    const raft = { provider: 'raft', server_id: 'srv', agent_sub: 'alice-bot', agent_name: 'alice-bot' };
    await env.META.put('account-notify:acct-alice', JSON.stringify([local('alice-mac'), raft]));
    await env.META.put('account-notify:acct-bob', JSON.stringify([local('bob-mac')]));
    await env.META.put('local-agents-seen:acct-alice', JSON.stringify({ 'alice-mac': new Date().toISOString() }));
    const memberTargets = await call('/api/notify/targets?slug=plan', { cookie: bob });
    assert(memberTargets.status === 200 && !memberTargets.body.default && memberTargets.body.reason === 'no_team_agent', `member targets ${JSON.stringify(memberTargets.body)}`);
    const adminTargets = await call('/api/notify/targets?slug=plan', { cookie: alice });
    assert(adminTargets.status === 200 && adminTargets.body.default?.provider === 'local' && adminTargets.body.default.server_id === 'alice-mac', `admin targets ${JSON.stringify(adminTargets.body)}`);
    assert((adminTargets.body.candidates || []).some((x) => x.provider === 'raft' && x.agent_sub === 'alice-bot'), 'team picker includes the admin Raft agents');
    // The admin's own connections, so the admin is who they act for.
    assert(adminTargets.body.default.owner?.display === 'alice', `team owner ${JSON.stringify(adminTargets.body.default.owner)}`);
    const outsiderTargets = await call('/api/notify/targets?slug=plan', { cookie: dave });
    assert(outsiderTargets.status === 403 || outsiderTargets.status === 401, `outsider targets ${outsiderTargets.status}`);
    const memberSend = await call('/api/notify/handoff', { method: 'POST', cookie: bob, body: { slug: 'plan', comment_ids: ['c1'], recipient: local('bob-mac') } });
    assert(memberSend.status === 403 && memberSend.body.error === 'team_agent_admin_only', `member handoff ${memberSend.status} ${JSON.stringify(memberSend.body)}`);
    const raftSend = await call('/api/notify/handoff', { method: 'POST', cookie: alice, body: { slug: 'plan', comment_ids: ['c1'], recipient: raft } });
    assert(raftSend.status === 200 && raftSend.body.handoff_id, `raft handoff ${raftSend.status} ${JSON.stringify(raftSend.body)}`);
    const raftRecord = (JSON.parse(await env.META.get('handoffs:plan')) || []).find((h) => h.handoff_id === raftSend.body.handoff_id);
    assert(raftRecord?.by === 'acct-alice' && raftRecord?.recipient?.provider === 'raft', `team Raft handoff stays bound to its admin ${JSON.stringify(raftRecord)}`);
    const sent = await call('/api/notify/handoff', { method: 'POST', cookie: alice, body: { slug: 'plan', comment_ids: ['c1'], recipient: local('alice-mac') } });
    assert(sent.status === 200 && sent.body.delivery.status === 'queued', `admin handoff ${sent.status} ${JSON.stringify(sent.body)}`);
    assert(!JSON.parse(await env.META.get('meta:plan')).notify_agents, 'an admin daemon is not stored as a shared team-doc agent');
    const pending = JSON.parse(await env.META.get('local-pending:acct-alice') || '[]');
    assert(pending.length === 1 && pending[0].handoff_id === sent.body.handoff_id, `admin pending ${JSON.stringify(pending)}`);
    const mint = async (value, accountId) => {
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((b) => b.toString(16).padStart(2, '0')).join('');
      await env.META.put(`hosted-token:${hash}`, JSON.stringify({ account_id: accountId, github_login: accountId.slice(5) }));
    };
    await mint('alice-team-token', 'acct-alice');
    await mint('bob-team-token', 'acct-bob');
    const polled = await call('/api/notify/local/pending?device=alice-mac', { token: 'alice-team-token' });
    assert(polled.status === 200 && polled.body.pending.length === 1, `admin daemon pending ${JSON.stringify(polled.body)}`);
    const memberAck = await call('/api/notify/ack', { method: 'POST', token: 'bob-team-token', body: { slug: 'plan', handoff_id: sent.body.handoff_id } });
    assert(memberAck.status === 403 && memberAck.body.error === 'not_handoff_sender', `member ack ${memberAck.status}`);
    const adminAck = await call('/api/notify/ack', { method: 'POST', token: 'alice-team-token', body: { slug: 'plan', handoff_id: sent.body.handoff_id } });
    assert(adminAck.status === 200 && adminAck.body.acked_at, `admin ack ${adminAck.status}`);
    const done = await call('/api/notify/resolve', { method: 'POST', token: 'alice-team-token', body: { slug: 'plan', handoff_id: sent.body.handoff_id } });
    assert(done.status === 200 && done.body.resolved === 1, `admin resolve ${done.status}`);
    assert(JSON.parse(await env.META.get('local-pending:acct-alice') || '[]').length === 0, 'resolved team handoff leaves the daemon queue');
  });

  await t("a member's agent token publishes a version but cannot change sharing", async () => {
    const token = 'tok-bob-agent';
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.META.put(`hosted-token:${hash}`, JSON.stringify({ account_id: 'acct-bob', github_login: 'bob' }));
    const html = '<!doctype html><html><head><title>plan</title></head><body><h1>plan</h1><p>agent pass</p></body></html>';
    const up = await call('/api/upload', { method: 'POST', token, body: { slug: 'plan', version: 3, html, meta: { access: { visibility: 'unlisted' } } } });
    assert(up.status === 200, `upload ${up.status} ${JSON.stringify(up.body)}`);
    const meta = JSON.parse(await env.META.get('meta:plan'));
    assert(meta.hosted.account_id === 'acct-alice' && meta.access.visibility === 'private' && meta.access.team === true, `author and sharing kept ${JSON.stringify(meta.access)}`);
    const patch = await call('/api/doc/access', { method: 'PATCH', token, body: { slug: 'plan', access: { visibility: 'unlisted' } } });
    assert(patch.status === 403, `member token changed access ${patch.status}`);
    const wipe = await call('/api/comments?slug=plan&all=1', { method: 'DELETE', token });
    assert(wipe.status === 403, `member token wiped comments ${wipe.status}`);
  });

  await t('/api/me lists team docs separately from personal docs', async () => {
    await env.META.put('recents:bob', JSON.stringify({ items: [{ slug: 'plan', at: '2026-10-18T07:00:00.000Z' }] }));
    await env.META.put('stars:bob', JSON.stringify({ items: [{ slug: 'plan', at: '2026-10-18T07:00:00.000Z' }] }));
    const me = await call('/api/me', { cookie: bob });
    assert(me.status === 200, `me ${me.status}`);
    assert(!me.body.docs.some((d) => d.slug === 'bob-notes'), 'team doc left My docs');
    const row = me.body.team_docs.find((d) => d.slug === 'plan');
    assert(row && row.author === 'alice' && !row.former_member && row.can_manage === false, `row ${JSON.stringify(row)}`);
    assert(row.workspace_id === team.id, `team row lost its workspace ${JSON.stringify(row)}`);
    assert(me.body.recent.find((d) => d.slug === 'plan')?.workspace_id === team.id, 'recent row must carry its team workspace');
    assert(me.body.starred.find((d) => d.slug === 'plan')?.workspace_id === team.id, 'starred row must carry its team workspace');
    assert(me.body.teams.length === 1 && me.body.teams[0].role === 'member', 'team summary');
    const html = await (await worker.fetch(req('/me', { cookie: bob }), env, {})).text();
    assert(!html.includes('allowed_users'), 'catalog leaks no access policy');
  });

  await t('team members browse every team comment and reply; outsiders cannot', async () => {
    const first = await call('/api/comments', {
      method: 'POST', cookie: carol,
      body: { slug: 'plan', version: 3, text: 'Sky found a gap in this section', anchor: { kind: 'text', text: 'agent pass' } },
    });
    assert(first.status === 200 && first.body.id, `first comment ${first.status} ${JSON.stringify(first.body)}`);
    const reply = await call('/api/comments', {
      method: 'POST', cookie: bob,
      body: { slug: 'plan', version: 3, parent_id: first.body.id, text: 'I will fix it' },
    });
    assert(reply.status === 200 && reply.body.id, `reply ${reply.status} ${JSON.stringify(reply.body)}`);
    const open = await call('/api/comments', {
      method: 'POST', cookie: bob,
      body: { slug: 'bob-notes', version: 1, text: 'This one is still open', anchor: null },
    });
    assert(open.status === 200, `open comment ${open.status}`);
    const resolved = await call('/api/comments', {
      method: 'PATCH', cookie: carol,
      body: { slug: 'plan', version: 3, id: first.body.id, resolved: true },
    });
    assert(resolved.status === 200, `resolve ${resolved.status}`);

    const feed = await call(`/api/team/comments?id=${team.id}`, { cookie: alice });
    assert(feed.status === 200 && feed.body.docs_total >= 2, `feed ${feed.status} ${JSON.stringify(feed.body)}`);
    const comment = feed.body.items.find((item) => item.id === first.body.id);
    const child = feed.body.items.find((item) => item.id === reply.body.id);
    const stillOpen = feed.body.items.find((item) => item.id === open.body.id);
    assert(comment && comment.kind === 'comment' && comment.resolved && comment.anchor === 'agent pass' && comment.reply_count === 1, `comment row ${JSON.stringify(comment)}`);
    assert(child && child.kind === 'reply' && child.thread_id === first.body.id && child.resolved && child.reply_count === 1, `reply row ${JSON.stringify(child)}`);
    assert(stillOpen && !stillOpen.resolved && stillOpen.title === 'bob-notes' && stillOpen.reply_count === 0, `open row ${JSON.stringify(stillOpen)}`);
    assert(!JSON.stringify(feed.body).includes('allowed_users'), 'feed leaks document access policy');

    const outsider = await call(`/api/team/comments?id=${team.id}`, { cookie: dave });
    assert(outsider.status === 404, `outsider enumerated team ${outsider.status}`);
    const anonymous = await call(`/api/team/comments?id=${team.id}`);
    assert(anonymous.status === 401, `anonymous ${anonymous.status}`);
  });

  await t('only team admins manage a team doc, even against its own author', async () => {
    const member = await call('/api/doc/access', { method: 'PATCH', cookie: bob, body: { slug: 'plan', access: { team: false } } });
    assert(member.status === 403 || member.status === 401, `member ${member.status}`);
    const author = await call('/api/doc/access', { method: 'PATCH', cookie: bob, body: { slug: 'bob-notes', access: { visibility: 'unlisted' } } });
    assert(author.status === 403 || author.status === 401, `member author ${author.status}`);
    const out = await call('/api/team/move', { method: 'POST', cookie: bob, body: { slugs: ['bob-notes'], team: null } });
    assert(out.status === 403, `member author moved it out ${out.status}`);
    const admin = await call('/api/doc/access', { method: 'PATCH', cookie: alice, body: { slug: 'bob-notes', access: { visibility: 'unlisted' } } });
    assert(admin.status === 200, `admin ${admin.status} ${JSON.stringify(admin.body)}`);
    const back = await call('/api/doc/access', { method: 'PATCH', cookie: alice, body: { slug: 'bob-notes', access: { visibility: 'private' } } });
    assert(back.status === 200, `admin ${back.status}`);
    const row = (await call('/api/me', { cookie: bob })).body.team_docs.find((d) => d.slug === 'bob-notes');
    assert(row && row.mine === true && row.can_manage === false, `byline only ${JSON.stringify(row)}`);
    const personal = await call('/api/doc/access', { method: 'PATCH', cookie: alice, body: { slug: 'solo', access: { team: true } } });
    assert(personal.status === 400 && personal.body.error === 'not_team_doc', `personal ${personal.status}`);
  });

  await t('members cannot manage roles; the last admin cannot step down or leave', async () => {
    const byMember = await call('/api/team/role', { method: 'POST', cookie: bob, body: { id: team.id, account_id: 'acct-carol', role: 'admin' } });
    assert(byMember.status === 403, `member promote ${byMember.status}`);
    const kick = await call('/api/team/remove', { method: 'POST', cookie: bob, body: { id: team.id, account_id: 'acct-carol' } });
    assert(kick.status === 403, `member remove ${kick.status}`);
    const demote = await call('/api/team/role', { method: 'POST', cookie: alice, body: { id: team.id, account_id: 'acct-alice', role: 'member' } });
    assert(demote.status === 409 && demote.body.error === 'last_admin', `demote ${demote.status}`);
    const leave = await call('/api/team/remove', { method: 'POST', cookie: alice, body: { id: team.id, account_id: 'acct-alice' } });
    assert(leave.status === 409 && leave.body.error === 'last_admin', `leave ${leave.status}`);
  });

  await t('admins promote and remove; a removed member loses the team', async () => {
    const promote = await call('/api/team/role', { method: 'POST', cookie: alice, body: { id: team.id, account_id: 'acct-bob', role: 'admin' } });
    assert(promote.status === 200, `promote ${promote.status}`);
    const remove = await call('/api/team/remove', { method: 'POST', cookie: bob, body: { id: team.id, account_id: 'acct-carol' } });
    assert(remove.status === 200, `remove ${remove.status}`);
    const gone = await call(`/api/team?id=${team.id}`, { cookie: carol });
    assert(gone.status === 404, `carol still sees team ${gone.status}`);
    const read = await call('/d/plan/v/1', { cookie: carol });
    assert(read.status === 403, `carol read ${read.status}`);
  });

  await t('a leaving author keeps the byline but loses access to the team doc', async () => {
    const leave = await call('/api/team/remove', { method: 'POST', cookie: alice, body: { id: team.id, account_id: 'acct-alice' } });
    assert(leave.status === 200 && leave.body.left, `leave ${leave.status}`);
    const read = await call('/d/plan/v/1', { cookie: alice });
    assert(read.status === 403, `former author read ${read.status}`);
    const patch = await call('/api/doc/access', { method: 'PATCH', cookie: alice, body: { slug: 'plan', access: { visibility: 'unlisted' } } });
    assert(patch.status !== 200, 'former author cannot change access');
    const back = await call('/api/team/move', { method: 'POST', cookie: alice, body: { slugs: ['plan'], team: null } });
    assert(back.status === 403, `former author pulled the doc out ${back.status}`);
    const me = await call('/api/me', { cookie: bob });
    const row = me.body.team_docs.find((d) => d.slug === 'plan');
    assert(row && row.author === 'alice' && row.former_member === true && row.can_manage === true, `row ${JSON.stringify(row)}`);
  });

  await t("an admin moves a team doc back to its author's My docs; team access goes with it", async () => {
    const back = await call('/api/team/move', { method: 'POST', cookie: bob, body: { slugs: ['bob-notes'], team: null } });
    assert(back.status === 200, `back ${back.status}`);
    const meta = JSON.parse(await env.META.get('meta:bob-notes'));
    assert(!meta.workspace_id && !meta.access.team, 'personal again');
    const me = await call('/api/me', { cookie: bob });
    assert(me.body.docs.some((d) => d.slug === 'bob-notes'), 'back in My docs');
  });

  await t('an invitee who opens a team-private doc is offered the invite and is not a member until Accept (#711)', async () => {
    const created = await call('/api/teams', { method: 'POST', cookie: alice, body: { name: 'BeFreed', invites: ['Erin@Example.com', 'hana@example.com'] } });
    assert(created.status === 200, `create ${created.status}`);
    const bf = created.body.team;
    await seedDoc(env, 'ads-report', 'alice');
    const moved = await call('/api/team/move', { method: 'POST', cookie: alice, body: { slugs: ['ads-report'], team: bf.id } });
    assert(moved.status === 200, `move ${moved.status}`);
    const sid = async (email, acct) => {
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
      await env.META.put(`session:${id}`, JSON.stringify({ email, name: email, account_id: acct, created: new Date().toISOString() }));
      return `tdoc_sid=${id}`;
    };
    const erin = await sid('erin@example.com', 'acct-erin');
    const gina = await sid('gina@example.com', 'acct-gina');
    const hana = await sid('hana@example.com', 'acct-hana');
    // Every way into the doc stops at the invitation; none of them joins.
    for (const path of ['/d/ads-report', '/d/ads-report/v/1', '/d/ads-report/raw', '/d/ads-report/v/1/raw']) {
      const gate = await call(path, { cookie: erin });
      const html = await gate.r.text();
      assert(gate.status === 403, `${path}: the invitee got ${gate.status}, not the invite`);
      if (!path.endsWith('/raw')) {
        assert(html.includes('You’re invited to BeFreed') && html.includes('"acceptInvite":{"slug":"ads-report"'), `${path}: no invite page`);
      }
    }
    const t1 = JSON.parse(await env.META.get(`team:${bf.id}`));
    assert(!t1.members.some((m) => m.account_id === 'acct-erin') && t1.invites.includes('erin@example.com'), 'opening the doc joined the team');
    const teams = await call('/api/teams', { cookie: erin });
    assert(!(teams.body.teams || []).some((x) => x.id === bf.id), 'the team is in their list before Accept');

    const stranger = await call('/d/ads-report', { cookie: gina });
    const strangerHtml = await stranger.r.text();
    assert(stranger.status === 403 && !strangerHtml.includes('acceptInvite'), 'someone without an invite was offered one');
    const refused = await call('/api/team/accept', { method: 'POST', cookie: gina, body: { slug: 'ads-report' }, headers: { Origin: 'https://tdoc.dev' } });
    assert(refused.status === 403 && refused.body.error === 'no_invite', `no invite accepted: ${refused.status}`);
    const crossSite = await call('/api/team/accept', { method: 'POST', cookie: hana, body: { slug: 'ads-report' }, headers: { Origin: 'https://evil.example' } });
    assert(crossSite.status === 403, `cross-site accept ${crossSite.status}`);
    const personal = await call('/api/team/accept', { method: 'POST', cookie: hana, body: { slug: 'solo' }, headers: { Origin: 'https://tdoc.dev' } });
    assert(personal.status === 404, `a personal doc's slug reached a team: ${personal.status}`);

    // Accept is the one door: it joins, clears the invite and opens the doc.
    const ok = await call('/api/team/accept', { method: 'POST', cookie: erin, body: { slug: 'ads-report' }, headers: { Origin: 'https://tdoc.dev' } });
    assert(ok.status === 200 && ok.body.next === '/d/ads-report' && ok.body.team.role === 'member', `accept ${ok.status} ${JSON.stringify(ok.body)}`);
    const t2 = JSON.parse(await env.META.get(`team:${bf.id}`));
    assert(t2.members.some((m) => m.account_id === 'acct-erin') && !(t2.invites || []).includes('erin@example.com'), 'Accept did not join');
    const open = await call('/d/ads-report', { cookie: erin });
    const openHtml = await open.r.text();
    assert(open.status === 200 && openHtml.includes('__TDOC_SHELL__') && !('joinedTeam' in (bootData(openHtml, '__TDOC_SHELL__') || {})), `after Accept the doc did not open: ${open.status}`);
    // The other invitee is untouched by all of the above.
    const t3 = JSON.parse(await env.META.get(`team:${bf.id}`));
    assert(t3.invites.includes('hana@example.com') && !t3.members.some((m) => m.account_id === 'acct-hana'), 'hana changed');
  });

  await t('an invitee who can read a team doc anyway (link or allowlist) reads it and stays invited; nobody joins on view', async () => {
    const made = await call('/api/teams', { method: 'POST', cookie: alice, body: { name: 'Readers', invites: ['Jo@Example.com', 'kit'] } });
    assert(made.status === 200, `create ${made.status}`);
    const rt = made.body.team;
    await seedDoc(env, 'open-memo', 'alice', { visibility: 'unlisted', commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] });
    await seedDoc(env, 'listed-memo', 'alice', { visibility: 'private', commenting: 'signed_in', history_visibility: 'owner', allowed_users: ['jo@example.com'] });
    const mv = await call('/api/team/move', { method: 'POST', cookie: alice, body: { slugs: ['open-memo', 'listed-memo'], team: rt.id } });
    assert(mv.status === 200, `move ${mv.status}`);
    const lm = JSON.parse(await env.META.get('meta:listed-memo'));
    assert(lm.workspace_id === rt.id && lm.access.visibility === 'private' && lm.access.allowed_users.includes('jo@example.com'), `listed-memo ${JSON.stringify(lm.access)}`);
    const sidOf = async (data) => {
      const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
      await env.META.put(`session:${id}`, JSON.stringify({ ...data, created: new Date().toISOString() }));
      return `tdoc_sid=${id}`;
    };
    const teamKey = `team:${rt.id}`;
    const writes = [];
    const realPut = env.META.put.bind(env.META);
    env.META.put = async (k, v, o) => { writes.push(k); return realPut(k, v, o); };
    const teamWrites = () => writes.filter((k) => k === teamKey || k.startsWith('account-teams:'));
    try {
      const anon = await call('/d/open-memo/v/1');
      assert(anon.status === 200, `anon ${anon.status}`);
      const nobody = await sidOf({ email: 'nobody@example.com', name: 'n', account_id: 'acct-nobody' });
      const n = await call('/d/open-memo/v/1', { cookie: nobody });
      assert(n.status === 200, `not invited ${n.status}`);
      const kit = await issue(worker, env, 'kit');
      const viaToken = await call('/d/open-memo/v/1', { token: kit.token });
      assert(viaToken.status === 200, `bearer ${viaToken.status}`);
      const viaCookie = await call('/d/open-memo', { cookie: kit.cookie });
      assert(viaCookie.status === 200, `invited handle ${viaCookie.status}`);
      const m = await call('/d/open-memo/v/1', { cookie: alice });
      assert(m.status === 200, `member ${m.status}`);
      // Invited by email, readable by link and by the allowlist: served, no join.
      const jo = await sidOf({ email: 'jo@example.com', name: 'Jo', account_id: 'acct-jo' });
      for (const path of ['/d/open-memo', '/d/open-memo/v/1', '/d/listed-memo', '/d/listed-memo/v/1', '/d/listed-memo/raw']) {
        const r = await call(path, { cookie: jo });
        const body = await r.r.text();
        assert(r.status === 200, `${path}: invitee ${r.status}`);
        if (!path.endsWith('/raw')) assert(!('joinedTeam' in (bootData(body, '__TDOC_SHELL__') || {})), `${path}: joined notice`);
      }
      assert(teamWrites().length === 0, `team writes on view: ${teamWrites()}`);
      const after = JSON.parse(await env.META.get(teamKey));
      assert(after.members.length === 1 && after.invites.includes('jo@example.com') && after.invites.includes('kit'), `team changed on view: ${JSON.stringify(after)}`);
      const list = await call('/api/teams', { cookie: jo });
      assert(!(list.body.teams || []).some((x) => x.id === rt.id), 'the team is in their list');
    } finally {
      env.META.put = realPut;
    }
  });

  await t('the CLI token can list its teams and move its own doc into one, and create a team without invites (tdoc-publish --team)', async () => {
    const zed = await issue(worker, env, 'zed');
    const made = await call('/api/teams', { method: 'POST', cookie: zed.cookie, body: { name: 'Daily' } });
    assert(made.status === 200, `create ${made.status}`);
    const daily = made.body.team;
    const up = await call('/api/upload', { method: 'POST', token: zed.token, body: { slug: 'daily-report', version: 1, html: '<p>x</p>' } });
    assert(up.status === 200 && up.body.new_doc === true && up.body.team === null, `upload ${up.status} ${JSON.stringify(up.body)}`);
    const list = await call('/api/teams', { token: zed.token });
    assert(list.status === 200 && list.body.teams.some((x) => x.id === daily.id), `token cannot list teams: ${list.status}`);
    const moved = await call('/api/team/move', { method: 'POST', token: zed.token, body: { team: daily.id, slugs: ['daily-report'] } });
    assert(moved.status === 200, `token move ${moved.status} ${JSON.stringify(moved.body)}`);
    const meta = JSON.parse(await env.META.get('meta:daily-report'));
    assert(meta.workspace_id === daily.id && meta.access.team === true, 'not in the team');
    const v2 = await call('/api/upload', { method: 'POST', token: zed.token, body: { slug: 'daily-report', version: 2, html: '<p>y</p>' } });
    assert(v2.status === 200 && v2.body.new_doc === false && v2.body.team === daily.id, `a later version must report where the doc is: ${JSON.stringify(v2.body)}`);
    const again = await call('/api/team/move', { method: 'POST', token: zed.token, body: { team: daily.id, slugs: ['daily-report'] } });
    assert(again.status === 200, `re-sending --team on the next version failed: ${again.status}`);
    const foreign = await call('/api/team/move', { method: 'POST', token: zed.token, body: { team: team.id, slugs: ['daily-report'] } });
    assert(foreign.status === 404, `moved into a team it is not in: ${foreign.status}`);
    const notMine = await call('/api/team/move', { method: 'POST', token: zed.token, body: { team: daily.id, slugs: ['solo'] } });
    assert(notMine.status === 403, `moved someone else's doc: ${notMine.status}`);
    const invite = await call('/api/teams', { method: 'POST', token: zed.token, body: { name: 'Mail', invites: ['x@example.com'] } });
    assert(invite.status === 403 && invite.body.error === 'invites_browser_only', `the token sent invites: ${invite.status}`);
    const create = await call('/api/teams', { method: 'POST', token: zed.token, body: { name: 'Agents' } });
    assert(create.status === 200 && create.body.team.role === 'admin' && !create.body.team.invite_url, `token create: ${create.status} ${JSON.stringify(create.body)}`);
    const mine = await call('/api/teams', { token: zed.token });
    assert(mine.body.teams.some((x) => x.name === 'Agents'), 'the new team is not listed');
  });

  await t('someone invited by handle sees the invite on My docs and joins with one click', async () => {
    const made = await call('/api/teams', { method: 'POST', cookie: alice, headers: { Origin: 'https://tdoc.dev' }, body: { name: 'Handles', invites: ['dave'] } });
    assert(made.status === 200, `create ${made.status}`);
    const id = made.body.team.id;
    // A team written before the invite index existed: no KV metadata.
    const legacy = { id: 't_0123456789abcdef', name: 'Legacy crew', created: '2026-01-01T00:00:00Z', created_by: 'acct-alice', members: [{ account_id: 'acct-alice', key: 'alice', name: 'alice', role: 'admin', joined: '2026-01-01T00:00:00Z' }], invites: ['dave'] };
    await env.META.put('team:t_0123456789abcdef', JSON.stringify(legacy));
    // ...and before the invite markers: the index forgets it is built, so
    // the next My docs walks the teams again and indexes this one.
    await env.META.delete('tinv:built');
    const boot = async () => bootData(await (await call('/me', { cookie: dave })).r.text(), '__TDOC_APP_BOOT__');
    const before = await boot();
    const ids = (before.team_invites || []).map((x) => x.id).sort();
    assert(ids.includes(id) && ids.includes('t_0123456789abcdef'), `invites on My docs: ${JSON.stringify(before.team_invites)}`);
    const stranger = await call('/api/team/accept-invite', { method: 'POST', cookie: carol, headers: { Origin: 'https://tdoc.dev' }, body: { id } });
    assert(stranger.status === 403, `someone not invited joined: ${stranger.status}`);
    const ok = await call('/api/team/accept-invite', { method: 'POST', cookie: dave, headers: { Origin: 'https://tdoc.dev' }, body: { id } });
    assert(ok.status === 200 && ok.body.team.role === 'member', `${ok.status} ${JSON.stringify(ok.body)}`);
    const after = await boot();
    assert(!(after.team_invites || []).some((x) => x.id === id), 'the joined team is still offered');
    assert((after.teams || []).some((x) => x.id === id), 'the joined team is not in the spaces');
  });

  const emailSession = async (email, acct) => {
    const id = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    await env.META.put(`session:${id}`, JSON.stringify({ email, name: email, account_id: acct, created: new Date().toISOString() }));
    return `tdoc_sid=${id}`;
  };
  const page = async (path, cookie) => {
    const r = await worker.fetch(req(path, cookie ? { cookie } : {}), env, {});
    return { status: r.status, location: r.headers.get('Location'), html: await r.text() };
  };

  let crew = null;
  await t('a team gets a readable handle from its name; a second team with the same name gets the next one', async () => {
    const made = await call('/api/teams', { method: 'POST', cookie: alice, headers: { Origin: 'https://tdoc.dev' }, body: { name: 'Be Freed!', invites: ['claire@befreed.ai', 'frank'] } });
    assert(made.status === 200, `create ${made.status}`);
    crew = made.body.team;
    assert(crew.handle === 'be-freed' && crew.team_url === 'https://tdoc.dev/t/be-freed', `${crew.handle} ${crew.team_url}`);
    assert(await env.META.get('team-handle:be-freed') === crew.id, 'handle index');
    const twin = await call('/api/teams', { method: 'POST', cookie: bob, body: { name: 'be freed' } });
    assert(twin.body.team.handle === 'be-freed-2', `twin ${twin.body.team.handle}`);
    const detail = await call(`/api/team?id=${crew.id}`, { cookie: alice });
    assert(detail.body.team.handle === 'be-freed' && detail.body.team.team_url.endsWith('/t/be-freed'), 'detail carries the link');
  });

  await t('a team from before handles existed gets one the first time a member opens it', async () => {
    const legacy = JSON.parse(await env.META.get('team:t_0123456789abcdef'));
    assert(!legacy.handle, 'precondition');
    const detail = await call('/api/team?id=t_0123456789abcdef', { cookie: alice });
    assert(detail.status === 200 && detail.body.team.handle === 'legacy-crew', `handle ${JSON.stringify(detail.body.team)}`);
    const saved = JSON.parse(await env.META.get('team:t_0123456789abcdef'));
    assert(saved.handle === 'legacy-crew' && await env.META.get('team-handle:legacy-crew') === 't_0123456789abcdef', 'saved with its handle');
    const again = await call('/api/team?id=t_0123456789abcdef', { cookie: alice });
    assert(again.body.team.handle === 'legacy-crew', 'kept');
  });

  await t('/t/<handle>: signed out → sign in and come back; member → the team space; unknown → 404', async () => {
    const anon = await page('/t/be-freed');
    assert(anon.status === 200 && anon.html.includes('Sign in') && anon.html.includes(encodeURIComponent('/t/be-freed')), `anon ${anon.status}`);
    const member = await page('/t/be-freed', alice);
    assert(member.status === 302 && member.location === `/me?team=${crew.id}`, `member ${member.status} ${member.location}`);
    const byId = await page(`/t/${crew.id}`, alice);
    assert(byId.status === 302 && byId.location === `/me?team=${crew.id}`, `by id ${byId.status}`);
    const upper = await page('/t/Be-Freed', alice);
    assert(upper.status === 302, `case ${upper.status}`);
    const none = await page('/t/nobody-here', alice);
    assert(none.status === 404, `unknown ${none.status}`);
    const bad = await page('/t/t_ffffffffffffffff', alice);
    assert(bad.status === 404, `unknown id ${bad.status}`);
  });

  await t('/t/<handle>: someone invited by address gets a Join button, and joining sends them to the team', async () => {
    const claire = await emailSession('Claire@BeFreed.ai', 'acct-claire');
    const open = await page('/t/be-freed', claire);
    assert(open.status === 200, `invitee ${open.status}`);
    const boot = bootData(open.html, '__TDOC_APP_BOOT__');
    assert(boot.page === 'team-join' && boot.team.id === crew.id && !boot.token, `boot ${JSON.stringify(boot)}`);
    assert(boot.identity.label === 'claire@befreed.ai' && boot.switch_href.includes('prompt=login'), `identity ${JSON.stringify(boot.identity)}`);
    const joined = await call('/api/team/accept-invite', { method: 'POST', cookie: claire, headers: { Origin: 'https://tdoc.dev' }, body: { id: crew.id } });
    assert(joined.status === 200 && joined.body.team.role === 'member', `join ${joined.status}`);
    const after = await page('/t/be-freed', claire);
    assert(after.status === 302 && after.location === `/me?team=${crew.id}`, `after ${after.status}`);
  });

  await t('/t/<handle>: an account that was not invited is told so, by name, with a way to switch', async () => {
    const gina = await emailSession('gina@example.com', 'acct-gina');
    const open = await page('/t/be-freed', gina);
    assert(open.status === 200, `stranger ${open.status}`);
    const boot = bootData(open.html, '__TDOC_APP_BOOT__');
    assert(boot.page === 'status' && boot.title.includes('Be Freed!') && boot.message.includes('gina@example.com'), `boot ${JSON.stringify(boot)}`);
    assert((boot.actions || []).some((a) => a.href.includes('prompt=login')), 'no account switch offered');
    assert(!open.html.includes('acct-') && !open.html.includes('claire'), 'the page leaks members or invites');
    const handleUser = await page('/t/be-freed', carol);
    const b2 = bootData(handleUser.html, '__TDOC_APP_BOOT__');
    assert(b2.message.includes('@carol'), `handle named: ${b2.message}`);
  });

  await t('/me?team=<id> for someone not in the team goes to the team link instead of being ignored', async () => {
    const hank = await emailSession('hank@example.com', 'acct-hank');
    const r = await page(`/me?team=${crew.id}`, hank);
    assert(r.status === 302 && r.location === `/t/${crew.id}`, `${r.status} ${r.location}`);
    const anon = await page(`/me?team=${crew.id}`);
    assert(anon.status === 302 && anon.location === `/t/${crew.id}`, `anon ${anon.status} ${anon.location}`);
    const mine = await page(`/me?team=${crew.id}`, alice);
    assert(mine.status === 200, `member ${mine.status}`);
    // The record says member but the account's team index fell behind:
    // the page opens on the team and the index is repaired.
    await env.META.put('account-teams:acct-alice', JSON.stringify([]));
    const drift = await page(`/me?team=${crew.id}`, alice);
    assert(drift.status === 200 && bootData(drift.html, '__TDOC_APP_BOOT__').teams.some((x) => x.id === crew.id), `drift ${drift.status}`);
    assert(JSON.parse(await env.META.get('account-teams:acct-alice')).includes(crew.id), 'index not repaired');
  });

  await t('the invite index: a list too long for KV metadata and legacy teams whose save fails are still found', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `person-${String(i).padStart(2, '0')}-with-a-long-address@example-company.com`);
    const made = await call('/api/teams', { method: 'POST', cookie: alice, body: { name: 'Big', invites: [...many, 'last@example.com'] } });
    assert(made.status === 200, `create ${made.status}`);
    const idx = env.META.metadata.get(`team:${made.body.team.id}`);
    assert(idx && idx.p === 1 && !idx.i.includes('last@example.com'), `index should be partial: ${JSON.stringify(idx).length}`);
    const last = await emailSession('last@example.com', 'acct-last');
    const boot = bootData((await page('/me', last)).html, '__TDOC_APP_BOOT__');
    assert((boot.team_invites || []).some((x) => x.id === made.body.team.id), `not found: ${JSON.stringify(boot.team_invites)}`);
    // Twelve legacy teams, every re-save refused (a free-plan write cap):
    // the first ten used to be read, the rest skipped on every request.
    const ids = [];
    for (let i = 0; i < 12; i++) {
      const id = `t_${String(i).padStart(16, '0')}`;
      ids.push(id);
      await env.META.put(`team:${id}`, JSON.stringify({ id, name: `Old ${i}`, created: '2026-01-01T00:00:00Z', created_by: 'acct-alice', members: [{ account_id: 'acct-alice', key: 'alice', name: 'alice', role: 'admin', joined: '2026-01-01T00:00:00Z' }], invites: ['ivy@example.com'] }));
      env.META.failPutOnce.add(`team:${id}`);
    }
    // Legacy means before the invite index too: forget it is built.
    await env.META.delete('tinv:built');
    const ivy = await emailSession('ivy@example.com', 'acct-ivy');
    const seen = (bootData((await page('/me', ivy)).html, '__TDOC_APP_BOOT__').team_invites || []).map((x) => x.id);
    assert(ids.every((id) => seen.includes(id)), `missing: ${ids.filter((id) => !seen.includes(id))}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
