// JUL-71 teams: private team records, admin/member roles, last-admin guard,
// team-owned docs that keep their human author, and team-wide doc access.
// Runs worker.js in-process with fake bindings (helpers/worker-harness.js).

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

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

  await t('every member edits a team doc; nobody sends it to an agent yet; outsiders cannot', async () => {
    const html = '<!doctype html><html><head><title>plan</title></head><body><h1>plan</h1><p>bob was here</p></body></html>';
    const outsider = await call('/api/doc/versions', { method: 'POST', cookie: dave, body: { slug: 'plan', baseVersion: 1, html } });
    assert(outsider.status === 403 || outsider.status === 401, `outsider save ${outsider.status}`);
    const saved = await call('/api/doc/versions', { method: 'POST', cookie: bob, body: { slug: 'plan', baseVersion: 1, html } });
    assert(saved.status === 200, `member save ${saved.status} ${JSON.stringify(saved.body)}`);
    const meta = JSON.parse(await env.META.get('meta:plan'));
    assert(meta.versions.length === 2 && meta.hosted.account_id === 'acct-alice', 'new version, same author');
    const boot = await (await worker.fetch(req('/d/plan/v/2', { cookie: bob }), env, {})).text();
    assert(/"canEdit":true/.test(boot), 'member gets the editor');

    const agent = (name) => ({ provider: 'raft', server_id: 'srv', agent_sub: name, agent_name: name });
    await env.META.put('account-notify:acct-alice', JSON.stringify([agent('alice-bot')]));
    await env.META.put('account-notify:acct-bob', JSON.stringify([agent('bob-bot')]));
    // Send to agent is off on team docs for now (Julie, 2026-10-03): no
    // member, author included, hands a team doc's comments to an agent.
    for (const who of [bob, alice, carol]) {
      const targets = await call('/api/notify/targets?slug=plan', { cookie: who });
      assert(targets.status === 200 && !targets.body.default && targets.body.reason === 'team_doc', `targets ${JSON.stringify(targets.body)}`);
    }
    const outsiderTargets = await call('/api/notify/targets?slug=plan', { cookie: dave });
    assert(outsiderTargets.status === 403 || outsiderTargets.status === 401, `outsider targets ${outsiderTargets.status}`);
    const steer = await call('/api/notify/handoff', { method: 'POST', cookie: bob, body: { slug: 'plan', comment_ids: ['c1'], recipient: agent('alice-bot') } });
    assert(steer.status === 403 && steer.body.error === 'team_docs_agent_disabled', `team handoff ${steer.status} ${JSON.stringify(steer.body)}`);
    const handoffs = JSON.parse(await env.META.get('handoffs:plan') || '[]');
    assert(!handoffs.length, 'a team handoff was recorded');
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
    const me = await call('/api/me', { cookie: bob });
    assert(me.status === 200, `me ${me.status}`);
    assert(!me.body.docs.some((d) => d.slug === 'bob-notes'), 'team doc left My docs');
    const row = me.body.team_docs.find((d) => d.slug === 'plan');
    assert(row && row.author === 'alice' && !row.former_member && row.can_manage === false, `row ${JSON.stringify(row)}`);
    assert(me.body.teams.length === 1 && me.body.teams[0].role === 'member', 'team summary');
    const html = await (await worker.fetch(req('/me', { cookie: bob }), env, {})).text();
    assert(!html.includes('allowed_users'), 'catalog leaks no access policy');
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

  await t('an invitee who opens a team doc before joining is offered the invite, and Accept lets them in (#711)', async () => {
    const created = await call('/api/teams', { method: 'POST', cookie: alice, body: { name: 'BeFreed', invites: ['Erin@Example.com'] } });
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
    const gate = await call('/d/ads-report', { cookie: erin });
    const html = await gate.r.text();
    assert(gate.status === 403 && html.includes('BeFreed') && html.includes('acceptInvite'), `invitee did not get the invite: ${gate.status}`);
    const stranger = await call('/d/ads-report', { cookie: gina });
    const strangerHtml = await stranger.r.text();
    assert(stranger.status === 403 && !strangerHtml.includes('acceptInvite'), 'someone without an invite was offered one');
    const refused = await call('/api/team/accept', { method: 'POST', cookie: gina, body: { slug: 'ads-report' }, headers: { Origin: 'https://tdoc.dev' } });
    assert(refused.status === 403 && refused.body.error === 'no_invite', `no invite accepted: ${refused.status}`);
    const crossSite = await call('/api/team/accept', { method: 'POST', cookie: erin, body: { slug: 'ads-report' }, headers: { Origin: 'https://evil.example' } });
    assert(crossSite.status === 403, `cross-site accept ${crossSite.status}`);
    const personal = await call('/api/team/accept', { method: 'POST', cookie: erin, body: { slug: 'solo' }, headers: { Origin: 'https://tdoc.dev' } });
    assert(personal.status === 404, `a personal doc's slug reached a team: ${personal.status}`);
    const ok = await call('/api/team/accept', { method: 'POST', cookie: erin, body: { slug: 'ads-report' }, headers: { Origin: 'https://tdoc.dev' } });
    assert(ok.status === 200 && ok.body.next === '/d/ads-report' && ok.body.team.role === 'member', `accept ${ok.status} ${JSON.stringify(ok.body)}`);
    const t2 = JSON.parse(await env.META.get(`team:${bf.id}`) || 'null') || (await call(`/api/team?id=${bf.id}`, { cookie: alice })).body.team;
    assert(!(t2.invites || []).includes('erin@example.com'), 'the invite was not cleared');
    const open = await call('/d/ads-report', { cookie: erin });
    // The bare doc URL redirects to its latest version once readable.
    assert(open.status === 200 || (open.status === 302 && /\/d\/ads-report\/v\/1/.test(open.r.headers.get('Location') || '')),
      `after accepting, the doc is still gated: ${open.status} ${open.r.headers.get('Location')}`);
  });

  await t('the CLI token can list its teams and move its own doc into one; nothing more (tdoc-publish --team)', async () => {
    const zed = await issue(worker, env, 'zed');
    const made = await call('/api/teams', { method: 'POST', cookie: zed.cookie, body: { name: 'Daily' } });
    assert(made.status === 200, `create ${made.status}`);
    const daily = made.body.team;
    const up = await call('/api/upload', { method: 'POST', token: zed.token, body: { slug: 'daily-report', version: 1, html: '<p>x</p>' } });
    assert(up.status === 200, `upload ${up.status}`);
    const list = await call('/api/teams', { token: zed.token });
    assert(list.status === 200 && list.body.teams.some((x) => x.id === daily.id), `token cannot list teams: ${list.status}`);
    const moved = await call('/api/team/move', { method: 'POST', token: zed.token, body: { team: daily.id, slugs: ['daily-report'] } });
    assert(moved.status === 200, `token move ${moved.status} ${JSON.stringify(moved.body)}`);
    const meta = JSON.parse(await env.META.get('meta:daily-report'));
    assert(meta.workspace_id === daily.id && meta.access.team === true, 'not in the team');
    const again = await call('/api/team/move', { method: 'POST', token: zed.token, body: { team: daily.id, slugs: ['daily-report'] } });
    assert(again.status === 200, `re-sending --team on the next version failed: ${again.status}`);
    const foreign = await call('/api/team/move', { method: 'POST', token: zed.token, body: { team: team.id, slugs: ['daily-report'] } });
    assert(foreign.status === 404, `moved into a team it is not in: ${foreign.status}`);
    const notMine = await call('/api/team/move', { method: 'POST', token: zed.token, body: { team: daily.id, slugs: ['solo'] } });
    assert(notMine.status === 403, `moved someone else's doc: ${notMine.status}`);
    const create = await call('/api/teams', { method: 'POST', token: zed.token, body: { name: 'Nope' } });
    assert(create.status === 401, `the token created a team: ${create.status}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
