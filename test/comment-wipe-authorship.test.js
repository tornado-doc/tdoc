// Follow-ups to #829 (authorship at write time):
//   - DELETE /api/comments?all=1 (the owner's comment wipe) with an admin's
//     agent token on a team doc another person's agent wrote: refused
//     (agent_not_author_editor); the doc's owner, and a doc the admin's own
//     agent wrote, still wipe -- and a successful wipe answers 200 (it threw
//     ReferenceError after wiping, a 500 for a done job).
//   - POST /api/team/move with an admin's agent token: may not move another
//     person's agent-written doc out of the team; the admin in the browser
//     may.
// Run with: node test/comment-wipe-authorship.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  console.log('comment wipe and team move follow agent authorship');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  const call = async (path, opts) => {
    let r;
    try { r = await worker.fetch(req(path, opts), env, {}); } catch (e) { return { status: 500, body: null, text: String(e && e.message) }; }
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const origin = { Origin: 'https://tdoc.dev' };
  const julie = await issue(worker, env, 'julie');
  const bob = await issue(worker, env, 'bob');
  const html = (slug, v) => `<h1>${slug}</h1><p>${slug} v${v}: a sentence to comment on</p>`;
  const upload = (token, slug, v = 1) => call('/api/upload', { method: 'POST', token, body: { slug, version: v, html: html(slug, v), meta: { title: slug } } });
  const team = (await call('/api/teams', { method: 'POST', cookie: julie.cookie, headers: origin, body: { name: 'Acme' } })).body.team;
  await call('/api/team/join', { method: 'POST', cookie: bob.cookie, body: { token: team.invite_url.split('/').pop() } });
  // bobs-doc: Bob's (his agent wrote it), in Julie's team. julies-doc: hers.
  for (const [who, slug] of [[bob, 'bobs-doc'], [bob, 'bobs-move'], [julie, 'julies-doc']]) {
    assert((await upload(who.token, slug)).status === 200, `seed ${slug}`);
    assert((await call('/api/team/move', { method: 'POST', token: who.token, body: { team: team.id, slugs: [slug] } })).status === 200, `move ${slug}`);
  }
  const comment = async (slug) => (await call('/api/comments', { method: 'POST', cookie: bob.cookie, headers: origin, body: { slug, version: 1, text: 'keep me', anchor: { kind: 'text', text: 'a sentence' } } })).body.id;
  const count = async (slug) => ((await call(`/api/comments?slug=${slug}&version=1`, { cookie: julie.cookie })).body || []).length;
  const wipe = (token, slug) => call(`/api/comments?all=1&slug=${slug}`, { method: 'DELETE', token });

  await t("an admin's agent token cannot wipe the comments on a doc another person's agent wrote", async () => {
    await comment('bobs-doc');
    const r = await wipe(julie.token, 'bobs-doc');
    assert(r.status === 403 && r.body && r.body.error === 'agent_not_author_editor', `${r.status} ${r.text}`);
    assert(await count('bobs-doc') === 1, 'comments were wiped');
  });

  await t('a wipe the agent may do answers 200, not 500, and empties the doc', async () => {
    await comment('julies-doc');
    const r = await wipe(julie.token, 'julies-doc');
    assert(r.status === 200, `${r.status} ${r.text}`);
    assert(await count('julies-doc') === 0, 'not wiped');
  });

  await t("an admin's agent token cannot move another person's agent-written doc out of the team; the admin in the browser can", async () => {
    const r = await call('/api/team/move', { method: 'POST', token: julie.token, body: { team: null, slugs: ['bobs-move'] } });
    assert(r.status === 403 && r.body && r.body.error === 'agent_not_author_editor', `${r.status} ${r.text}`);
    assert(JSON.parse(env.META.map.get('meta:bobs-move')).workspace_id === team.id, 'it left the team');
    const browser = await call('/api/team/move', { method: 'POST', cookie: julie.cookie, headers: origin, body: { team: null, slugs: ['bobs-move'] } });
    assert(browser.status === 200, `browser: ${browser.status} ${browser.text}`);
    // And the admin's agent moves her own doc fine.
    const mine = await call('/api/team/move', { method: 'POST', token: julie.token, body: { team: null, slugs: ['julies-doc'] } });
    assert(mine.status === 200, `own doc: ${mine.status} ${mine.text}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
