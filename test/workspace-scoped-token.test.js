// Workspace-level agent access (tdoc.dev/d/tdoc-agent-access-model). An agent
// connection is its person plus the workspaces ticked for it: My docs and/or
// any of their teams. All ticked is an account-level token, as before; some
// ticked is a token that reaches only those. The person can change the
// workspaces or remove the connection in Settings > Agents, and the next
// request already runs under the change.
//
// team-scoped-token.test.js keeps the one-team (#792) cases.
//
// Run with: node test/workspace-scoped-token.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('workspace-scoped agent connections');
  const origin = { Origin: 'https://tdoc.dev' };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  async function call(env, path, opts) {
    const r = await worker.fetch(req(path, opts), env, ctx);
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  }

  const env = makeEnv(mod.CommentsStore, {});
  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  const mkTeam = async (name) => (await call(env, '/api/teams', { method: 'POST', cookie: julie.cookie, headers: origin, body: { name } })).body.team;
  const abby = await mkTeam('abby');
  const befreed = await mkTeam('BeFreed');
  const upload = (token, slug, extra = {}) =>
    call(env, '/api/upload', { method: 'POST', token, body: { slug, version: extra.version || 1, html: `<p>${slug} v${extra.version || 1}</p>`, meta: { title: slug, access: extra.access || { visibility: 'private' } }, ...(extra.team ? { team: extra.team } : {}), ...(extra.team_default ? { team_default: extra.team_default } : {}) } });
  const readable = async (token, slug) => (await call(env, `/d/${slug}/raw`, { token })).status === 200;
  const metaOf = (slug) => JSON.parse(env.META.map.get(`meta:${slug}`));
  assert((await upload(julie.token, 'abby-secret')).status === 200, 'abby doc');
  assert((await upload(julie.token, 'befreed-report')).status === 200, 'befreed doc');
  assert((await upload(julie.token, 'my-notes')).status === 200, 'personal doc');
  assert((await upload(bob.token, 'bobs-draft', { access: { visibility: 'private', allowed_users: ['julie'] } })).status === 200, 'bob doc');
  assert(await readable(julie.token, 'bobs-draft'), 'julie is invited to bob\'s doc');
  for (const [team, slug] of [[abby, 'abby-secret'], [befreed, 'befreed-report']]) {
    assert((await call(env, '/api/team/move', { method: 'POST', token: julie.token, body: { team: team.id, slugs: [slug] } })).status === 200, `move ${slug}`);
  }

  // The browser half of a connection: the CLI starts, the person allows it
  // on /activate with some workspaces ticked, the CLI collects its token.
  async function connect(workspaces) {
    // The pairing routes' per-session rate limits are not under test here.
    for (const k of [...env.META.map.keys()]) if (k.startsWith('rl:')) env.META.map.delete(k);
    const start = (await call(env, '/api/cli/pair/start', { method: 'POST', body: { label: 'test', device: 'julies-mac', client: 'Claude Code' } })).body;
    const look = await call(env, '/api/cli/pair/lookup', { method: 'POST', cookie: julie.cookie, headers: origin, body: { user_code: start.user_code } });
    const ok = await call(env, '/api/cli/pair/approve', { method: 'POST', cookie: julie.cookie, headers: origin, body: { user_code: start.user_code, ...(workspaces ? { workspaces } : {}) } });
    if (ok.status !== 200) return { look, approve: ok };
    const polled = await call(env, '/api/cli/pair/poll', { method: 'POST', body: { user_code: start.user_code, pair_secret: start.pair_secret } });
    return { look, approve: ok, token: polled.body.token, poll: polled.body };
  }
  const tokens = async () => (await call(env, '/api/me/tokens', { cookie: julie.cookie })).body;
  const idOf = async (device) => (await tokens()).tokens.find((x) => x.device === device).id;

  let meOnly = null;
  await t('the Allow page lists My docs and each of the person\'s teams', async () => {
    const { look } = await connect(null);
    const ids = look.body.workspaces.map((w) => w.id);
    assert(look.status === 200 && ids[0] === 'me' && ids.includes(abby.id) && ids.includes(befreed.id) && ids.length === 3, look.text);
    assert(look.body.workspaces[0].name === 'My docs', look.text);
  });

  await t('all ticked (or none sent) is an account-level token, as before', async () => {
    const all = await connect(['me', abby.id, befreed.id]);
    assert(all.poll.workspaces === null, JSON.stringify(all.poll));
    const who = await call(env, '/api/hosted/whoami', { token: all.token });
    assert(who.body.workspaces === null, who.text);
    assert(await readable(all.token, 'abby-secret') && await readable(all.token, 'my-notes'), 'account token lost reach');
  });

  await t('none ticked, or a team the person is not in, is refused', async () => {
    assert((await connect([])).approve.status === 400, 'empty scope approved');
    assert((await connect(['me', 't_0000000000000000'])).approve.status === 400, 'foreign team approved');
  });

  await t('My docs only: reads the person\'s own docs, no team doc, no doc someone else shared', async () => {
    const c = await connect(['me']);
    meOnly = c.token;
    assert(JSON.stringify(c.poll.workspaces) === '["me"]', JSON.stringify(c.poll));
    assert(await readable(meOnly, 'my-notes'), 'own personal doc unreadable');
    for (const slug of ['abby-secret', 'befreed-report', 'bobs-draft']) {
      const r = await call(env, `/d/${slug}/raw`, { token: meOnly });
      assert(r.status >= 400 && !r.text.includes(`${slug} v1`), `${slug} leaked: ${r.status}`);
      const comments = await call(env, `/api/comments?slug=${slug}`, { token: meOnly });
      assert(comments.status >= 400, `${slug} comments: ${comments.status}`);
    }
  });

  await t('My docs only: its catalog has the person\'s docs and no team', async () => {
    const me = await call(env, '/api/me', { token: meOnly });
    const all = JSON.stringify(me.body);
    assert(me.status === 200 && me.body.docs.some((d) => d.slug === 'my-notes'), me.text.slice(0, 300));
    assert(!all.includes('abby-secret') && !all.includes('befreed-report') && !all.includes(abby.id) && !all.includes(befreed.id), `catalog leaked: ${all.slice(0, 400)}`);
    const teams = await call(env, '/api/teams', { token: meOnly });
    assert(teams.status === 200 && teams.body.teams.length === 0, teams.text);
  });

  await t('My docs only: publishes to My docs, never into or over a team doc', async () => {
    assert((await upload(meOnly, 'agent-note')).status === 200, 'new personal doc refused');
    assert(!metaOf('agent-note').workspace_id, 'filed into a team');
    assert((await upload(meOnly, 'my-notes', { version: 2 })).status === 200, 'new version of own doc refused');
    const over = await upload(meOnly, 'abby-secret', { version: 2 });
    assert(over.status === 403 && over.body.error === 'token_scope' && /Settings → Agents/.test(over.body.message), `${over.status} ${over.text}`);
    const into = await upload(meOnly, 'into-team', { team: befreed.id });
    assert(into.status === 403 && into.body.error === 'token_scope' && !env.META.map.has('meta:into-team'), `${into.status} ${into.text}`);
    const bobs = await upload(meOnly, 'bobs-draft', { version: 2 });
    assert(bobs.status === 403, `bob's doc: ${bobs.status}`);
  });

  await t('My docs only: team routes are refused, personal folders work', async () => {
    const refused = [
      ['/api/team/move', { method: 'POST', body: { team: befreed.id, slugs: ['agent-note'] } }],
      ['/api/team/comments?id=' + abby.id, {}],
      ['/api/folders?team=' + abby.id, {}],
      ['/api/folders/move-to-team', { method: 'POST', body: { team: abby.id, folder: 'f_x' } }],
      ['/api/hosted/token/scoped', { method: 'POST', body: { workspaces: ['me', abby.id] } }],
      ['/api/me/tokens', {}],
    ];
    for (const [path, opts] of refused) {
      const r = await call(env, path, { token: meOnly, ...opts });
      assert(r.status === 403 || r.status === 404, `${opts.method || 'GET'} ${path} -> ${r.status} ${r.text.slice(0, 160)}`);
    }
    const made = await call(env, '/api/folders', { method: 'POST', token: meOnly, body: { name: 'Agent notes' } });
    assert(made.status === 200, `personal folder: ${made.status} ${made.text}`);
    const filed = await call(env, '/api/folders/move', { method: 'POST', token: meOnly, body: { slugs: ['agent-note'], folder: made.body.folder.id } });
    assert(filed.status === 200, `file: ${filed.status} ${filed.text}`);
  });

  let twoTeams = null;
  await t('two teams, no My docs: reads both teams, nothing personal', async () => {
    const c = await connect([abby.id, befreed.id]);
    twoTeams = c.token;
    assert(await readable(twoTeams, 'abby-secret') && await readable(twoTeams, 'befreed-report'), 'team doc unreadable');
    assert(!(await readable(twoTeams, 'my-notes')) && !(await readable(twoTeams, 'bobs-draft')), 'personal doc readable');
    const me = await call(env, '/api/me', { token: twoTeams });
    assert(me.body.docs.length === 0 && me.body.teams.length === 2, me.text.slice(0, 300));
  });

  await t('two teams: a new doc must say which team, and lands there', async () => {
    const guess = await upload(twoTeams, 'which-team');
    assert(guess.status === 409 && guess.body.error === 'team_required' && !env.META.map.has('meta:which-team'), `${guess.status} ${guess.text}`);
    const named = await upload(twoTeams, 'which-team', { team: 'BeFreed' });
    assert(named.status === 200 && named.body.team === befreed.id && metaOf('which-team').workspace_id === befreed.id, named.text);
    const moveOut = await call(env, '/api/team/move', { method: 'POST', token: twoTeams, body: { team: null, slugs: ['which-team'] } });
    assert(moveOut.status === 403, `moved into My docs: ${moveOut.status}`);
    const across = await call(env, '/api/team/move', { method: 'POST', token: twoTeams, body: { team: abby.id, slugs: ['which-team'] } });
    assert(across.status === 200, `between its own teams: ${across.status} ${across.text}`);
  });

  await t('My docs + one team: new docs go to My docs unless the team is named', async () => {
    const c = await connect(['me', befreed.id]);
    assert((await upload(c.token, 'mixed-personal')).status === 200 && !metaOf('mixed-personal').workspace_id, 'not personal');
    const r = await upload(c.token, 'mixed-team', { team: befreed.id });
    assert(r.status === 200 && metaOf('mixed-team').workspace_id === befreed.id, r.text);
    assert(!(await readable(c.token, 'abby-secret')), 'abby readable');
    const move = await call(env, '/api/team/move', { method: 'POST', token: c.token, body: { team: befreed.id, slugs: ['mixed-personal'] } });
    assert(move.status === 200, `My docs -> its team: ${move.status} ${move.text}`);
  });

  await t('Settings > Agents lists each connection with its workspaces', async () => {
    const list = await tokens();
    assert(list.workspaces.length === 3 && list.workspaces[0].id === 'me', JSON.stringify(list.workspaces));
    const scoped = list.tokens.filter((x) => Array.isArray(x.workspaces));
    assert(scoped.some((x) => JSON.stringify(x.workspaces) === '["me"]' && x.device === 'julies-mac' && x.client === 'Claude Code'), JSON.stringify(list.tokens));
    assert(list.tokens.some((x) => x.workspaces === null), 'account-level connection missing');
  });

  await t('changing a connection\'s workspaces takes effect on its next request', async () => {
    const id = await idOf('julies-mac');
    const meOnlyId = (await tokens()).tokens.find((x) => JSON.stringify(x.workspaces) === '["me"]').id;
    assert(id && meOnlyId, 'no ids');
    const widen = await call(env, '/api/me/tokens/workspaces', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id: meOnlyId, workspaces: ['me', abby.id] } });
    assert(widen.status === 200 && JSON.stringify(widen.body.workspaces) === JSON.stringify(['me', abby.id]), widen.text);
    assert(await readable(meOnly, 'abby-secret'), 'abby still unreadable after adding it');
    const narrow = await call(env, '/api/me/tokens/workspaces', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id: meOnlyId, workspaces: [befreed.id] } });
    assert(narrow.status === 200, narrow.text);
    assert(!(await readable(meOnly, 'abby-secret')) && !(await readable(meOnly, 'my-notes')), 'old workspaces still reachable');
    assert(await readable(meOnly, 'befreed-report'), 'new workspace unreachable');
    const all = await call(env, '/api/me/tokens/workspaces', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id: meOnlyId, workspaces: ['me', abby.id, befreed.id] } });
    assert(all.status === 200 && all.body.workspaces === null, all.text);
    assert(!JSON.parse(env.META.map.get(`hosted-token:${meOnlyId}`)).scope, 'all ticked kept a scope');
    assert(await readable(meOnly, 'abby-secret') && await readable(meOnly, 'my-notes'), 'account level lost reach');
    const back = await call(env, '/api/me/tokens/workspaces', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id: meOnlyId, workspaces: ['me'] } });
    assert(back.status === 200 && !(await readable(meOnly, 'abby-secret')), 'narrowing back failed');
  });

  await t('only the person, in the browser, can change workspaces', async () => {
    const id = (await tokens()).tokens.find((x) => JSON.stringify(x.workspaces) === '["me"]').id;
    const empty = await call(env, '/api/me/tokens/workspaces', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id, workspaces: [] } });
    assert(empty.status === 400, `empty: ${empty.status}`);
    const cross = await call(env, '/api/me/tokens/workspaces', { method: 'POST', cookie: julie.cookie, headers: { Origin: 'https://evil.example' }, body: { id, workspaces: ['me', abby.id] } });
    assert(cross.status === 403, `cross-site: ${cross.status}`);
    const byToken = await call(env, '/api/me/tokens/workspaces', { method: 'POST', token: julie.token, headers: origin, body: { id, workspaces: ['me', abby.id] } });
    assert(byToken.status === 401 || byToken.status === 403, `by token: ${byToken.status}`);
    const byScoped = await call(env, '/api/me/tokens/workspaces', { method: 'POST', token: meOnly, headers: origin, body: { id, workspaces: ['me', abby.id] } });
    assert(byScoped.status === 403, `by the token itself: ${byScoped.status}`);
    const bobs = await call(env, '/api/me/tokens/workspaces', { method: 'POST', cookie: bob.cookie, headers: origin, body: { id, workspaces: ['me'] } });
    assert(bobs.status === 404, `someone else: ${bobs.status}`);
    assert(!(await readable(meOnly, 'abby-secret')), 'a refused change widened it anyway');
  });

  await t('a token\'s use never rewrites its record (a stale write cannot undo a change)', async () => {
    const id = (await tokens()).tokens.find((x) => JSON.stringify(x.workspaces) === '["me"]').id;
    const before = env.META.map.get(`hosted-token:${id}`);
    env.META.map.delete(`token-used:${id}`);
    assert(await readable(meOnly, 'my-notes'), 'unreadable');
    assert(env.META.map.get(`hosted-token:${id}`) === before, 'the record was rewritten on use');
    assert(env.META.map.has(`token-used:${id}`), 'no last-used stamp');
    const row = (await tokens()).tokens.find((x) => x.id === id);
    assert(row.last_used, 'last used not listed');
  });

  await t('removing a connection stops it at once', async () => {
    const id = (await tokens()).tokens.find((x) => JSON.stringify(x.workspaces) === '["me"]').id;
    const r = await call(env, '/api/me/tokens/revoke', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id } });
    assert(r.status === 200, r.text);
    const after = await upload(meOnly, 'after-revoke');
    assert(after.status === 401, `revoked token still publishes: ${after.status}`);
    assert(!(await readable(meOnly, 'my-notes')), 'revoked token still reads');
    assert(!env.META.map.has(`token-used:${id}`), 'last-used stamp left behind');
  });

  await t('a token can mint a narrower one, never a wider one', async () => {
    const mine = await call(env, '/api/hosted/token/scoped', { method: 'POST', token: julie.token, body: { workspaces: ['me'] } });
    assert(mine.status === 200 && JSON.stringify(mine.body.workspaces) === '["me"]', mine.text);
    const wider = await call(env, '/api/hosted/token/scoped', { method: 'POST', token: mine.body.token, body: { workspaces: ['me', abby.id] } });
    assert(wider.status === 403 || wider.status === 404, `widened: ${wider.status} ${wider.text}`);
    const same = await call(env, '/api/hosted/token/scoped', { method: 'POST', token: mine.body.token, body: { workspaces: ['me'] } });
    assert(same.status === 200, `same scope: ${same.status} ${same.text}`);
  });

  // ---- review of #813 ----
  const idFor = (token) => require('crypto').createHash('sha256').update(token).digest('hex');
  await t('review: a team-only token cannot touch My docs folders by naming its team in the other half of the request', async () => {
    const made = await call(env, '/api/folders', { method: 'POST', cookie: julie.cookie, headers: origin, body: { name: 'Private stuff' } });
    const folderId = made.body.folder.id;
    const fresh = (await connect([abby.id])).token;
    // #792 tokens carry scope_team: the same holes, the same fix.
    const legacy = (await call(env, '/api/hosted/token/scoped', { method: 'POST', token: julie.token, body: { team: abby.id } })).body.token;
    const rec = JSON.parse(env.META.map.get(`hosted-token:${idFor(legacy)}`));
    delete rec.scope; rec.scope_team = abby.id;
    env.META.map.set(`hosted-token:${idFor(legacy)}`, JSON.stringify(rec));
    for (const token of [fresh, legacy]) {
      const tries = [
        [`/api/folders?team=${abby.id}`, { method: 'PATCH', body: { id: folderId, name: 'pwned', visibility: 'public' } }],
        [`/api/folders?team=${abby.id}`, { method: 'POST', body: { name: 'planted' } }],
        [`/api/folders/move?team=${abby.id}`, { method: 'POST', body: { slugs: ['my-notes'], folder: folderId } }],
        [`/api/folders?id=${folderId}`, { method: 'DELETE', body: { team: abby.id } }],
        ['/api/folders', { method: 'GET', body: null, headers: {} }],
      ];
      for (const [path, opts] of tries) {
        const r = await call(env, path, { token, ...opts });
        assert(r.status === 403, `${opts.method} ${path} -> ${r.status} ${r.text.slice(0, 160)}`);
      }
      const ownTeam = await call(env, '/api/folders', { method: 'POST', token, body: { team: abby.id, name: 'Abby reports', existing_ok: true } });
      assert(ownTeam.status === 200, `its own team's folders: ${ownTeam.status} ${ownTeam.text}`);
    }
    const mine = await call(env, '/api/folders', { cookie: julie.cookie });
    const names = JSON.stringify(mine.body.folders.map((f) => [f.name, f.visibility]));
    assert(mine.body.folders.some((f) => f.id === folderId && f.name === 'Private stuff' && f.visibility === 'private'), `folder changed: ${names}`);
    assert(!names.includes('planted') && !names.includes('pwned'), `planted: ${names}`);
  });

  await t('review: a My docs token\'s catalog has no one else\'s docs in recent or starred', async () => {
    assert((await upload(bob.token, 'bobs-public', { access: { visibility: 'public' } })).status === 200, 'bob public doc');
    for (const slug of ['bobs-public', 'bobs-draft', 'my-notes', 'abby-secret']) {
      const r = await call(env, '/api/star', { method: 'POST', cookie: julie.cookie, headers: origin, body: { slug, starred: true } });
      assert(r.status === 200, `star ${slug}: ${r.status} ${r.text}`);
    }
    const token = (await connect(['me'])).token;
    const me = (await call(env, '/api/me', { token })).body;
    const starred = me.starred.map((row) => row.slug);
    assert(starred.includes('my-notes'), `own starred doc missing: ${starred}`);
    for (const slug of ['bobs-public', 'bobs-draft', 'abby-secret']) {
      assert(!starred.includes(slug) && !JSON.stringify(me.recent).includes(slug) && !JSON.stringify(me.feedback).includes(slug), `${slug} listed: ${JSON.stringify(me).slice(0, 400)}`);
    }
    const full = (await call(env, '/api/me', { token: julie.token })).body;
    assert(full.starred.some((row) => row.slug === 'bobs-public'), 'the account token lost its stars');
  });

  await t('review: the default team is a preference, --team a demand', async () => {
    const meAbby = (await connect(['me', abby.id])).token;
    const missed = await upload(meAbby, 'default-elsewhere', { team_default: 'BeFreed' });
    assert(missed.status === 200 && missed.body.scoped === true && !metaOf('default-elsewhere').workspace_id, `${missed.status} ${missed.text}`);
    const hit = await upload(meAbby, 'default-reached', { team_default: 'abby' });
    assert(hit.status === 200 && metaOf('default-reached').workspace_id === abby.id && hit.body.team === abby.id, hit.text);
    const demanded = await upload(meAbby, 'demanded-elsewhere', { team: 'BeFreed' });
    assert(demanded.status === 403 && demanded.body.error === 'token_scope', `${demanded.status} ${demanded.text}`);
    const oneTeam = (await connect([abby.id])).token;
    const only = await upload(oneTeam, 'only-team-default', { team_default: 'BeFreed' });
    assert(only.status === 200 && metaOf('only-team-default').workspace_id === abby.id, `${only.status} ${only.text}`);
    const account = await upload(julie.token, 'account-default', { team_default: 'BeFreed' });
    assert(account.status === 200 && !account.body.scoped && !metaOf('account-default').workspace_id, 'an account token is placed by the CLI, not the server');
  });

  await t('review: a workspace change racing a revoke does not bring the token back', async () => {
    const token = (await connect(['me'])).token;
    const id = idFor(token);
    const key = `hosted-token:${id}`;
    const get = env.META.get.bind(env.META);
    let reads = 0;
    // The revoke lands right after the route's first read of the record.
    env.META.get = async (k) => {
      const v = await get(k);
      if (k === key && ++reads === 1) env.META.map.delete(key);
      return v;
    };
    try {
      const r = await call(env, '/api/me/tokens/workspaces', { method: 'POST', cookie: julie.cookie, headers: origin, body: { id, workspaces: ['me', abby.id] } });
      assert(r.status === 404, `${r.status} ${r.text}`);
    } finally { env.META.get = get; }
    assert(!env.META.map.has(key), 'the revoked token was written back');
    assert((await call(env, '/api/hosted/whoami', { token })).status === 401, 'the revoked token works again');
  });

  await t('review: the last-used stamp expires on its own and goes with unpair', async () => {
    const token = (await connect(['me'])).token;
    const put = env.META.put.bind(env.META);
    let ttl = null;
    env.META.put = async (k, v, opts) => { if (k === `token-used:${idFor(token)}`) ttl = opts && opts.expirationTtl; return put(k, v, opts); };
    try {
      env.META.map.delete(`token-used:${idFor(token)}`);
      await call(env, '/api/hosted/whoami', { token });
    } finally { env.META.put = put; }
    assert(ttl >= 30 * 24 * 3600, `no expiry on the stamp: ${ttl}`);
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'worker', 'worker.js'), 'utf8');
    const unpair = src.slice(src.indexOf('if (body.unpair === true) {'), src.indexOf('if (body.unpair === true) {') + 1600);
    assert(/tokenUsedKey\(/.test(unpair), 'unpair leaves last-used stamps behind');
  });

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
