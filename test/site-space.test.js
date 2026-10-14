// The SDK: a site owner binds one comment space to their site. Visitors on
// the bound origins comment into it; other origins cannot borrow it. Who may
// comment is the space doc's own Share settings, like any doc: binding never
// rewrites access (Julie, 2026-10-14).

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (path, opts) => {
    const r = await worker.fetch(req(path, opts), env, {});
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  const home = { Origin: 'https://tdoc.dev' };
  const site = 'https://app.example.com';
  console.log('site comment space');
  const owner = await issue(worker, env, 'owner');
  const visitor = await issue(worker, env, 'visitor');
  const friend = await issue(worker, env, 'friend');
  const mate = await issue(worker, env, 'mate');
  const newbie = await issue(worker, env, 'newbie');
  const made = await call('/api/feedback/connect', { method: 'POST', cookie: owner.cookie, headers: home, body: { origin: site } });
  assert(made.status === 200, `space ${made.status}`);
  const slug = made.body.slug;

  const patchAccess = (access) => call('/api/doc/access', { method: 'PATCH', cookie: owner.cookie, headers: home, body: { slug, access } });
  const connectAs = (who, origin = site) => call('/api/feedback/connect', { method: 'POST', cookie: who.cookie, headers: home, body: { origin, space: slug } });

  await t('only the owner can bind a space to a site, and gets the snippet; binding leaves access alone', async () => {
    const stranger = await call('/api/feedback/site', { method: 'POST', cookie: visitor.cookie, headers: home, body: { slug, origins: [site] } });
    assert(stranger.status === 403, `stranger ${stranger.status}`);
    const bad = await call('/api/feedback/site', { method: 'POST', cookie: owner.cookie, headers: home, body: { slug, origins: ['not a url'] } });
    assert(bad.status === 400 && bad.body.error === 'invalid_origin', `bad ${bad.status}`);
    const before = await call(`/api/feedback/site?slug=${slug}`, { cookie: owner.cookie, headers: home });
    // A legacy `mode` is accepted and ignored.
    const r = await call('/api/feedback/site', { method: 'POST', cookie: owner.cookie, headers: home, body: { slug, origins: [`${site}/`], mode: 'invited' } });
    assert(r.status === 200 && r.body.site.origins[0] === site && !('mode' in r.body.site), JSON.stringify(r.body));
    assert(r.body.snippet.includes(`data-tdoc-space="${slug}"`), r.body.snippet);
    assert(JSON.stringify(r.body.access) === JSON.stringify(before.body.access), `access changed: ${JSON.stringify(before.body.access)} → ${JSON.stringify(r.body.access)}`);
  });

  await t('Share decides: a private space refuses a visitor who was not invited, and says so', async () => {
    const p = await patchAccess({ visibility: 'private', commenting: 'invited', allowed_users: [] });
    assert(p.status === 200, `patch ${p.status} ${JSON.stringify(p.body)}`);
    // Re-binding (even with the old "public" mode) never undoes Share.
    const again = await call('/api/feedback/site', { method: 'POST', cookie: owner.cookie, headers: home, body: { slug, origins: [site], mode: 'public' } });
    assert(again.body.access.visibility === 'private' && again.body.access.commenting === 'invited', JSON.stringify(again.body.access));
    const r = await connectAs(visitor);
    assert(r.status === 403 && r.body.error === 'not_invited' && /share/i.test(r.body.message), `${r.status} ${JSON.stringify(r.body)}`);
  });

  await t('a person the owner adds in Share connects and comments through the SDK', async () => {
    await patchAccess({ allowed_users: ['friend'] });
    const r = await connectAs(friend);
    assert(r.status === 200 && r.body.slug === slug && r.body.token, `${r.status} ${JSON.stringify(r.body)}`);
    assert(r.body.share_url && r.body.share_url.endsWith(`/d/${slug}?doc=1&share=1`) && !('invite_url' in r.body), `share_url ${r.body.share_url}`);
    const posted = await call('/api/comments', { method: 'POST', headers: { Authorization: `Bearer ${r.body.token}` }, body: { slug, version: 1, text: 'invited and here', anchor: { kind: 'product', url: `${site}/`, selector: 'main' } } });
    assert(posted.status === 200, `comment ${posted.status} ${JSON.stringify(posted.body)}`);
  });

  await t('another site cannot borrow the space', async () => {
    const r = await connectAs(owner, 'https://evil.example');
    assert(r.status === 403 && r.body.error === 'origin_not_allowed', `${r.status}`);
  });

  await t('a team space: members comment, outsiders are refused, a pending invitee joins on connect', async () => {
    const made = await call('/api/teams', { method: 'POST', cookie: owner.cookie, headers: home, body: { name: 'Acme', invites: ['mate', 'newbie'] } });
    assert(made.status === 200, `team ${made.status} ${JSON.stringify(made.body)}`);
    const teamId = made.body.team.id;
    const accepted = await call('/api/team/accept-invite', { method: 'POST', cookie: mate.cookie, headers: home, body: { id: teamId } });
    assert(accepted.status === 200, `accept ${accepted.status}`);
    const moved = await call('/api/team/move', { method: 'POST', cookie: owner.cookie, headers: home, body: { slugs: [slug], team: teamId } });
    assert(moved.status === 200, `move ${moved.status} ${JSON.stringify(moved.body)}`);
    // Still bound: moving is not unbinding.
    const m = await connectAs(mate);
    assert(m.status === 200 && m.body.token, `member ${m.status} ${JSON.stringify(m.body)}`);
    const posted = await call('/api/comments', { method: 'POST', headers: { Authorization: `Bearer ${m.body.token}` }, body: { slug, version: 1, text: 'teammate here', anchor: { kind: 'product', url: `${site}/`, selector: 'main' } } });
    assert(posted.status === 200, `member comment ${posted.status}`);
    const out = await connectAs(visitor);
    assert(out.status === 403 && out.body.error === 'not_invited', `outsider ${out.status}`);
    const n = await connectAs(newbie);
    assert(n.status === 200 && n.body.token, `invitee ${n.status} ${JSON.stringify(n.body)}`);
    const team = await call(`/api/team?id=${teamId}`, { cookie: newbie.cookie, headers: home });
    assert(team.status === 200 && !(team.body.team.invites || []).includes('newbie'), `invitee did not join ${team.status} ${JSON.stringify(team.body)}`);
    // Back out of the team so the next cases see a personal space again.
    await call('/api/team/move', { method: 'POST', cookie: owner.cookie, headers: home, body: { slugs: [slug], team: null } });
    await patchAccess({ visibility: 'unlisted', commenting: 'signed_in' });
  });

  await t('anyone signed in (link + signed-in commenting in Share): a visitor connects and comments', async () => {
    const c = await connectAs(visitor);
    assert(c.status === 200 && c.body.slug === slug && c.body.token, `${c.status} ${JSON.stringify(c.body)}`);
    const auth = { Authorization: `Bearer ${c.body.token}` };
    const session = await call('/api/feedback/session', { headers: auth });
    assert(session.status === 200 && session.body.slug === slug, `session ${session.status} ${JSON.stringify(session.body)}`);
    const posted = await call('/api/comments', { method: 'POST', headers: auth, body: { slug, version: 1, text: 'button is cut off', anchor: { kind: 'product', url: `${site}/pricing`, selector: 'main > button' } } });
    assert(posted.status === 200, `comment ${posted.status} ${JSON.stringify(posted.body)}`);
  });

  await t('turning it off stops new visitors', async () => {
    await call('/api/feedback/site', { method: 'POST', cookie: owner.cookie, headers: home, body: { slug, off: true } });
    const r = await call('/api/feedback/connect', { method: 'POST', cookie: visitor.cookie, headers: home, body: { origin: site, space: slug } });
    assert(r.status === 404, `${r.status}`);
  });

  await t('the owner\'s agent binds, reads and unbinds with its upload token (tdoc-site); others cannot', async () => {
    const bearer = (tok) => ({ Authorization: `Bearer ${tok}` });
    const r = await call('/api/feedback/site', { method: 'POST', headers: bearer(owner.token), body: { slug, origins: [site, 'https://www.example.com'], mode: 'public' } });
    assert(r.status === 200 && r.body.site.origins.length === 2 && !('mode' in r.body.site) && r.body.access.commenting === 'signed_in', `bearer bind ${r.status} ${JSON.stringify(r.body)}`);
    assert(r.body.snippet.includes(`data-tdoc-space="${slug}"`), 'no snippet');
    const read = await call(`/api/feedback/site?slug=${slug}`, { headers: bearer(owner.token) });
    assert(read.status === 200 && read.body.site.origins.length === 2 && read.body.snippet, `read ${read.status} ${JSON.stringify(read.body)}`);
    const notOwner = await call('/api/feedback/site', { method: 'POST', headers: bearer(visitor.token), body: { slug, origins: ['https://evil.example'] } });
    assert(notOwner.status === 403, `non-owner token bound: ${notOwner.status}`);
    const notOwnerRead = await call(`/api/feedback/site?slug=${slug}`, { headers: bearer(visitor.token) });
    assert(notOwnerRead.status === 403, `non-owner read ${notOwnerRead.status}`);
    const anon = await call('/api/feedback/site', { method: 'POST', body: { slug, origins: [site] } });
    assert(anon.status === 401, `anon ${anon.status}`);
    const crossSite = await call('/api/feedback/site', { method: 'POST', cookie: owner.cookie, headers: { Origin: 'https://evil.example' }, body: { slug, off: true } });
    assert(crossSite.status === 403, `cross-origin cookie ${crossSite.status}`);
    // A visitor's feedback token (the SDK's) is never an owner credential.
    const c = await call('/api/feedback/connect', { method: 'POST', cookie: owner.cookie, headers: home, body: { origin: site, space: slug } });
    assert(c.status === 200 && c.body.token, `connect ${c.status}`);
    const scoped = await call('/api/feedback/site', { method: 'POST', headers: bearer(c.body.token), body: { slug, off: true } });
    assert(scoped.status === 403 && scoped.body.error === 'feedback_token_scope', `feedback token ${scoped.status} ${JSON.stringify(scoped.body)}`);
    const off = await call('/api/feedback/site', { method: 'POST', headers: bearer(owner.token), body: { slug, off: true } });
    assert(off.status === 200 && off.body.site === null, `off ${off.status}`);
    const gone = await call(`/api/feedback/site?slug=${slug}`, { headers: bearer(owner.token) });
    assert(gone.status === 200 && gone.body.site === null && !gone.body.snippet, 'still bound');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
