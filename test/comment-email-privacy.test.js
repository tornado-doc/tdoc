// People who sign in by email are keyed `email:<address>` in comment records.
// Comment payloads leave the worker with every address the reader is not
// entitled to replaced: by a per-doc alias where it is a key, by its local
// part where it is a name or a tag in comment text. The reader keeps their
// own address, the owner keeps the ones they invited, a team its members'.
// Run with: node test/comment-email-privacy.test.js

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const CAROL = 'carol.writer@example.com';
const DAVE = 'dave.reader@example.org';

(async () => {
  console.log('comment email privacy');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (p, o = {}) => {
    const r = await worker.fetch(req(p, o), env, {});
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch {}
    return { status: r.status, body, text };
  };
  const emailSession = async (email, sid) => {
    await env.META.put(`session:${sid}`, JSON.stringify({ email, name: email, created: '2026-01-01T00:00:00.000Z' }));
    return `tdoc_sid=${sid}`;
  };

  const alice = await issue(worker, env, 'alice');
  const eve = await issue(worker, env, 'eve');
  const carol = await emailSession(CAROL, 'ca'.repeat(16));
  const dave = await emailSession(DAVE, 'da'.repeat(16));
  const created = '2026-01-01T00:00:00.000Z';
  const seed = async (slug, access) => {
    await env.META.put(`meta:${slug}`, JSON.stringify({ title: slug, slug, created, versions: [{ n: 1, created }], access, hosted: { account_id: alice.account_id, github_login: 'alice' } }));
    await env.DOCS.put(`docs/${slug}/v1/index.html`, '<h1>Plan</h1><p>Billing first.</p>');
  };
  await seed('open', { visibility: 'public' });
  await seed('invited', { visibility: 'public', allowed_users: [CAROL] });

  for (const slug of ['open', 'invited']) {
    const c = await call('/api/comments', { method: 'POST', cookie: carol, body: { slug, version: 1, text: 'Who owns billing?', anchor: { kind: 'text', text: 'Billing' } } });
    assert(c.status === 200, `carol comment ${c.status} ${c.text}`);
    await call('/api/reactions', { method: 'POST', cookie: carol, body: { slug, comment_id: c.body.id, emoji: '👍', version: 1 } });
    const d = await call('/api/comments', { method: 'POST', cookie: dave, body: { slug, version: 1, parent_id: c.body.id, text: `@${CAROL} I think it is Ana.` } });
    assert(d.status === 200, `dave reply ${d.status} ${d.text}`);
  }

  const leaks = (text, ...emails) => emails.filter((e) => text.includes(e) || text.includes(e.split('@')[1]));

  await t('anonymous readers and other accounts get no address from any comment route', async () => {
    for (const who of [{}, { token: eve.token }, { cookie: eve.cookie }]) {
      for (const path of ['/api/comments?slug=open', '/api/comments?slug=open&version=all', '/d/open/v/1/export?download=0', '/d/open/v/1/fork', '/d/open']) {
        const r = await call(path, who);
        assert(r.status === 200, `${path} ${r.status}`);
        assert(!leaks(r.text, CAROL, DAVE).length, `${path} (${Object.keys(who)[0] || 'anonymous'}) leaks ${leaks(r.text, CAROL, DAVE)}`);
      }
      const md = await call('/d/open', { ...who, headers: { Accept: 'text/markdown' } });
      assert(!leaks(md.text, CAROL, DAVE).length, 'markdown leaks an address');
    }
  });

  await t('the alias is stable, per doc, and the names and tags keep only the local part', async () => {
    const a = (await call('/api/comments?slug=open')).body;
    const b = (await call('/api/comments?slug=open', { token: eve.token })).body;
    const other = (await call('/api/comments?slug=invited')).body;
    assert(/^email-alias:[0-9a-f]{12}$/.test(a[0].author.login), `alias ${a[0].author.login}`);
    assert(a[0].author.login === b[0].author.login, 'alias differs between readers');
    assert(a[0].author.login !== other[0].author.login, 'alias is the same across docs');
    assert(a[0].author.name === 'carol.writer', `name ${a[0].author.name}`);
    const reply = a[0].replies[0];
    assert(reply.text === '@carol.writer I think it is Ana.', `reply text ${reply.text}`);
    assert(JSON.stringify(a[0].reactions).includes(a[0].author.login), 'reaction is not keyed by the alias');
  });

  await t('a commenter keeps their own address, so the app still knows their comments', async () => {
    const r = await call('/api/comments?slug=open', { cookie: carol });
    assert(r.body[0].author.login === `email:${CAROL}`, `own login ${r.body[0].author.login}`);
    assert(!r.text.includes(DAVE), 'carol sees dave\'s address');
    const own = await call('/api/comments?slug=open', { cookie: dave });
    assert(own.body[0].replies[0].text.includes(`@${CAROL}`), 'dave\'s own reply lost the address he typed');
    assert(own.body[0].replies[0].author.login === `email:${DAVE}`, 'dave does not see his own key');
  });

  await t('the owner sees the addresses they invited, and only those', async () => {
    const invited = await call('/api/comments?slug=invited', { cookie: alice.cookie });
    assert(invited.text.includes(CAROL), 'owner does not see the address they invited');
    assert(!invited.text.includes(DAVE), 'owner sees an address they never invited');
    const open = await call('/api/comments?slug=open', { cookie: alice.cookie });
    assert(!leaks(open.text, CAROL, DAVE).length, 'owner sees uninvited addresses');
  });

  await t('mutation responses and the mention list follow the same rule', async () => {
    const list = (await call('/api/comments?slug=open', { cookie: eve.cookie })).body;
    const react = await call('/api/reactions', { method: 'POST', cookie: eve.cookie, body: { slug: 'open', comment_id: list[0].id, emoji: '❤️', version: 1 } });
    assert(react.status === 200 && !leaks(react.text, CAROL, DAVE).length, `reaction response ${react.status} leaks`);
    const reply = await call('/api/comments', { method: 'POST', cookie: eve.cookie, body: { slug: 'open', version: 1, parent_id: list[0].id, text: 'Agreed.' } });
    assert(reply.status === 200 && !leaks(reply.text, CAROL, DAVE).length, `reply response ${reply.status} leaks`);
    const mentions = await call('/api/mentions?slug=open', { cookie: eve.cookie });
    assert(mentions.status === 200, `mentions ${mentions.status}`);
    assert(!leaks(mentions.text, CAROL, DAVE).length, 'mention list offers an address');
    assert(mentions.body.users.some((u) => u.login === 'alice'), 'mention list lost the GitHub owner');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
