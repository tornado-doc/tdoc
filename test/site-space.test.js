// The SDK: a site owner binds one comment space to their site. Visitors on
// the bound origins comment into it; other origins cannot borrow it; the
// owner chooses invited-only or anyone signed in (Julie, 2026-10-13).

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
  const made = await call('/api/feedback/connect', { method: 'POST', cookie: owner.cookie, headers: home, body: { origin: site } });
  assert(made.status === 200, `space ${made.status}`);
  const slug = made.body.slug;

  await t('only the owner can bind a space to a site, and gets the snippet', async () => {
    const stranger = await call('/api/feedback/site', { method: 'POST', cookie: visitor.cookie, headers: home, body: { slug, origins: [site] } });
    assert(stranger.status === 403, `stranger ${stranger.status}`);
    const bad = await call('/api/feedback/site', { method: 'POST', cookie: owner.cookie, headers: home, body: { slug, origins: ['not a url'] } });
    assert(bad.status === 400 && bad.body.error === 'invalid_origin', `bad ${bad.status}`);
    const r = await call('/api/feedback/site', { method: 'POST', cookie: owner.cookie, headers: home, body: { slug, origins: [`${site}/`], mode: 'invited' } });
    assert(r.status === 200 && r.body.site.origins[0] === site && r.body.site.mode === 'invited', JSON.stringify(r.body));
    assert(r.body.snippet.includes(`data-tdoc-space="${slug}"`), r.body.snippet);
    assert(r.body.access.visibility === 'private' && r.body.access.commenting === 'invited', JSON.stringify(r.body.access));
  });

  await t('invited-only: a visitor who was not invited is told so', async () => {
    const r = await call('/api/feedback/connect', { method: 'POST', cookie: visitor.cookie, headers: home, body: { origin: site, space: slug } });
    assert(r.status === 403 && r.body.error === 'not_invited', `${r.status} ${JSON.stringify(r.body)}`);
  });

  await t('another site cannot borrow the space', async () => {
    const r = await call('/api/feedback/connect', { method: 'POST', cookie: owner.cookie, headers: home, body: { origin: 'https://evil.example', space: slug } });
    assert(r.status === 403 && r.body.error === 'origin_not_allowed', `${r.status}`);
  });

  await t('anyone signed in: a visitor connects and comments into the site\'s space', async () => {
    await call('/api/feedback/site', { method: 'POST', cookie: owner.cookie, headers: home, body: { slug, origins: [site], mode: 'public' } });
    const c = await call('/api/feedback/connect', { method: 'POST', cookie: visitor.cookie, headers: home, body: { origin: site, space: slug } });
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
    assert(r.status === 200 && r.body.site.origins.length === 2 && r.body.site.mode === 'public', `bearer bind ${r.status} ${JSON.stringify(r.body)}`);
    assert(r.body.snippet.includes(`data-tdoc-space="${slug}"`), 'no snippet');
    const read = await call(`/api/feedback/site?slug=${slug}`, { headers: bearer(owner.token) });
    assert(read.status === 200 && read.body.site.mode === 'public' && read.body.snippet, `read ${read.status} ${JSON.stringify(read.body)}`);
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
