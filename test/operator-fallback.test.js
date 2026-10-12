// The deploy operator (TDOC_OWNER) owns only docs that name no hosted owner.
// An email-born account's doc (account id + owner key, no GitHub handle) is
// that account's: never in the operator's My docs, never readable or
// deletable by her (Julie, 2026-10-12; Fable audit reproduction).

const crypto = require('crypto');
const H = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await H.loadWorker();
  const worker = mod.default;
  const env = H.makeEnv(mod.CommentsStore, { TDOC_OWNER: 'yayashuxue', TDOC_HOSTED_REGISTRATION: '1' });
  const call = async (p, o) => { const r = await worker.fetch(H.req(p, o), env, {}); let b = null; try { b = await r.clone().json(); } catch {} return { status: r.status, body: b, r }; };
  console.log('operator fallback');
  const julie = await H.issue(worker, env, 'yayashuxue', 'mac-mini');
  const id = crypto.randomBytes(16).toString('hex');
  await env.META.put(`session:${id}`, JSON.stringify({
    email: 'tongxunhu13@gmail.com', oidc: true, name: 'tongxunhu13', avatar_url: '', created: new Date().toISOString(),
    idp: { provider: 'oidc', sub: 'user_x' },
  }));
  const outsider = `tdoc_sid=${id}`;
  const mint = await call('/api/hosted/token', { method: 'POST', cookie: outsider, body: { label: 'cowork' } });
  assert(mint.status === 200, `mint ${mint.status}`);
  const priv = { visibility: 'private', commenting: 'invited', history_visibility: 'owner', allowed_users: [] };
  const up = await call('/api/upload', { method: 'POST', token: mint.body.token, body: { slug: 'their-doc', version: 1, html: '<p>hi</p>', meta: { title: 'Theirs', access: priv } } });
  assert(up.status === 200, `upload ${up.status}`);
  // A legacy doc with no hosted owner at all is still the operator's.
  await env.META.put('meta:legacy-doc', JSON.stringify({ title: 'Legacy', versions: [{ n: 1, created: '2025-01-01T00:00:00Z' }], access: priv }));
  await env.DOCS.put('docs/legacy-doc/v1/index.html', '<p>old</p>');

  const myDocs = async () => H.bootData(await (await call('/me', { cookie: julie.cookie })).r.text(), '__TDOC_APP_BOOT__').docs.map((d) => d.slug);

  await t('an email-born account\'s doc is not in the operator\'s My docs, even after a visit', async () => {
    assert(!(await myDocs()).includes('their-doc'), 'listed cold');
    await call('/d/their-doc/v/1', { cookie: julie.cookie });
    assert(!(await myDocs()).includes('their-doc'), 'listed after a visit');
  });

  await t('the operator cannot read or delete it', async () => {
    const read = await call('/d/their-doc/v/1', { cookie: julie.cookie });
    assert(read.status === 403, `read ${read.status}`);
    const del = await call('/api/doc?slug=their-doc', { method: 'DELETE', cookie: julie.cookie, headers: { Origin: 'https://tdoc.dev' } });
    assert(del.status !== 200, `deleted: ${del.status}`);
    assert(await env.META.get('meta:their-doc'), 'meta gone');
  });

  await t('its own account still owns it', async () => {
    const read = await call('/d/their-doc/v/1', { cookie: outsider });
    assert(read.status === 200, `owner read ${read.status}`);
  });

  await t('a doc that names no owner at all stays the operator\'s', async () => {
    assert((await myDocs()).includes('legacy-doc'), 'legacy doc missing for the operator');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
