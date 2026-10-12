// "@" offers the people you work with first: the doc's own people, your
// teammates, then whoever you recently tagged or answered (Julie, 2026-10-12).

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
  const origin = { Origin: 'https://tdoc.dev' };
  console.log('mention directory');
  const alice = await issue(worker, env, 'alice');
  const bob = await issue(worker, env, 'bob');
  const carol = await issue(worker, env, 'carol');
  const made = await call('/api/teams', { method: 'POST', cookie: alice.cookie, headers: origin, body: { name: 'Acme', invites: ['bob'] } });
  const token = made.body.team.invite_url.split('/').pop();
  await call('/api/team/join', { method: 'POST', cookie: bob.cookie, headers: origin, body: { token } });
  const pub = { visibility: 'public', commenting: 'signed_in', history_visibility: 'public', allowed_users: [] };
  await call('/api/upload', { method: 'POST', token: alice.token, body: { slug: 'plan', version: 1, html: '<p>hello</p>', meta: { access: pub } } });
  await call('/api/upload', { method: 'POST', token: alice.token, body: { slug: 'notes', version: 1, html: '<p>notes</p>', meta: { access: pub } } });
  await call('/api/team/move', { method: 'POST', cookie: alice.cookie, headers: origin, body: { team: made.body.team.id, slugs: ['plan'] } });

  await t('on a team doc, teammates are offered and labelled', async () => {
    const r = await call('/api/mentions?slug=plan', { cookie: alice.cookie });
    assert(r.status === 200, `status ${r.status}`);
    const b = r.body.users.find((u) => u.login === 'bob');
    assert(b && b.tags.includes('teammate'), JSON.stringify(r.body.users));
    assert(!r.body.users.some((u) => u.login === 'alice'), 'offered yourself');
  });

  await t('someone you tagged comes back as recent on your next doc, after your teammates', async () => {
    const posted = await call('/api/comments', { method: 'POST', cookie: alice.cookie, headers: origin, body: { slug: 'notes', version: 1, text: 'thoughts @carol?', anchor: { kind: 'text', text: 'notes' } } });
    assert(posted.status === 200, `comment ${posted.status} ${JSON.stringify(posted.body)}`);
    const r = await call('/api/mentions?slug=plan', { cookie: alice.cookie });
    const logins = r.body.users.map((u) => u.login);
    const c = r.body.users.find((u) => u.login === 'carol');
    assert(c && c.tags.includes('recent'), JSON.stringify(r.body.users));
    assert(logins.indexOf('bob') < logins.indexOf('carol'), `teammate should come first: ${logins}`);
  });

  await t('the person you tagged sees you as recent too (from their inbox)', async () => {
    const r = await call('/api/mentions?slug=notes', { cookie: carol.cookie });
    const a = r.body.users.find((u) => u.login === 'alice');
    assert(a && a.tags.includes('doc'), JSON.stringify(r.body.users));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
