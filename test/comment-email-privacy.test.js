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
  env.TDOC_EMAIL_ALIAS_SECRET = 'test-alias-secret';
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

  // What is typed, and how another reader sees it.
  const TAGS = [
    ['ask @ann@one.example and @bob@two.example', 'ask @ann and @bob'],
    ['ask @ann@one.example,@bob@two.example;@cat@three.example now', 'ask @ann,@bob;@cat now'],
    ['ask @ann@one.example/@bob@two.example', 'ask @ann/@bob'],
    ['ask @ann@one.example_@bob@two.example-@cat@three.example', 'ask @ann@bob-@cat'],
    ['ask @ann@one.example, please.', 'ask @ann, please.'],
    ['is it @ann@one.example? (@bob@two.example)', 'is it @ann? (@bob)'],
    ['"@ann@one.example" -@bob@two.example <@cat@three.example>', '"@ann" -@bob <@cat>'],
    ['问 @ann@one.example，@bob@two.example、@cat@three.example。', '问 @ann，@bob、@cat。'],
    ['请@ann@one.example看一下（@bob@two.example）', '请@ann看一下（@bob）'],
    ['@ann@one.example和@bob@two.example说', '@ann和@bob说'],
    ['@lee,@ann@one.example', '@lee,@ann'],
    ['@lee,@ann.kim@one.example,@bob@two.example', '@lee,@ann.kim,@bob'],
    ['@j.lee/@ann@one.example', '@j.lee/@ann'],
    ['@ann@one.bücher.example, ok', '@ann, ok'],
    ['@ann@one.例子, ok', '@ann, ok'],
    // Not tags: as they are.
    ['write to ann@mail.example', 'write to ann@mail.example'],
    ['@lee, @j-lee and @kim', '@lee, @j-lee and @kim'],
    ['see https://unpkg.com/@scope/pkg@1.2.3/x.js', 'see https://unpkg.com/@scope/pkg@1.2.3/x.js'],
  ];
  const textsOf = (body) => new Map(body.flatMap((c) => [c, ...(c.replies || [])]).map((c) => [c.id, c.text]));

  await t('mention tags read the same whatever is written around them, for every reader and route', async () => {
    await seed('tags', { visibility: 'public' });
    const ids = [];
    for (const [text] of TAGS) {
      const c = await call('/api/comments', { method: 'POST', cookie: carol, body: { slug: 'tags', version: 1, text } });
      assert(c.status === 200, `comment ${c.status} ${c.text}`);
      const r = await call('/api/comments', { method: 'POST', cookie: carol, body: { slug: 'tags', version: 1, parent_id: c.body.id, text } });
      assert(r.status === 200, `reply ${r.status}`);
      ids.push([c.body.id, r.body.id]);
    }
    for (const [who, o] of [['anonymous', {}], ['another account', { cookie: eve.cookie }], ['a token', { token: eve.token }], ['the owner', { cookie: alice.cookie }]]) {
      for (const path of ['/api/comments?slug=tags', '/api/comments?slug=tags&version=all']) {
        const shown = textsOf((await call(path, o)).body);
        TAGS.forEach(([text, want], i) => {
          for (const id of ids[i]) assert(shown.get(id) === want, `${who} ${path}: ${JSON.stringify(text)} shows ${JSON.stringify(shown.get(id))}`);
        });
      }
      for (const path of ['/d/tags', '/d/tags/v/1/export?download=0', '/d/tags/v/1/fork']) {
        const r = await call(path, o);
        assert(r.status === 200 && !/(one|two|three)\./.test(r.text), `${who} ${path}: ${(r.text.match(/.{30}(one|two|three)\..{10}/) || [r.status])[0]}`);
      }
      const md = await call('/d/tags', { ...o, headers: { Accept: 'text/markdown' } });
      assert(md.status === 200 && !/(one|two|three)\./.test(md.text), `${who} markdown`);
    }
    // The author's own words are whole, and saving an edit of them keeps them so.
    const own = textsOf((await call('/api/comments?slug=tags', { cookie: carol })).body);
    for (const [i, [text]] of TAGS.entries()) {
      for (const id of ids[i]) {
        assert(own.get(id) === text, `own words: ${JSON.stringify(own.get(id))}`);
        const saved = await call('/api/comments', { method: 'PATCH', cookie: carol, body: { slug: 'tags', version: 1, id, text: `${own.get(id)} !` } });
        assert(saved.status === 200 && saved.body.text === `${text} !`, `edited: ${saved.status} ${saved.body && saved.body.text}`);
      }
    }
  });

  await t('mention tags in the two feeds', async () => {
    const team = (await call('/api/teams', { method: 'POST', cookie: alice.cookie, body: { name: 'T' } })).body.team;
    await call('/api/team/join', { method: 'POST', cookie: eve.cookie, body: { token: team.invite_url.split('/').pop() } });
    await seed('team-tags', { visibility: 'private', team: true, commenting: 'signed_in', allowed_users: [] });
    await env.META.put('meta:team-tags', JSON.stringify({ ...JSON.parse(await env.META.get('meta:team-tags')), workspace_id: team.id }));
    await seed('eve-tags', { visibility: 'public' });
    await env.META.put('meta:eve-tags', JSON.stringify({ ...JSON.parse(await env.META.get('meta:eve-tags')), hosted: { account_id: eve.account_id, github_login: 'eve' } }));
    for (const slug of ['team-tags', 'eve-tags']) {
      await env.META.put(`comments:${slug}`, JSON.stringify(TAGS.map(([text], i) => ({ id: `${slug}${i}`, text, created, version: 1, author: { login: 'quinn', name: 'quinn' } }))));
    }
    for (const [slug, path] of [['team-tags', `/api/team/comments?id=${team.id}`], ['eve-tags', '/api/me/comments?offset=0']]) {
      const r = await call(path, { cookie: eve.cookie });
      const rows = new Map(((r.body && r.body.items) || []).filter((x) => x.slug === slug).map((x) => [x.id, x.text]));
      TAGS.forEach(([text, want], i) => assert(rows.get(`${slug}${i}`) === want, `${path}: ${JSON.stringify(text)} shows ${JSON.stringify(rows.get(`${slug}${i}`))}`));
    }
  });

  await t('mention tags: the owner sees the ones they invited, and long text is read quickly', async () => {
    await seed('long-tags', { visibility: 'public', allowed_users: [CAROL] });
    const long = ['@a@b.example,'.repeat(8000), '@'.repeat(60000), 'a@'.repeat(60000), `@a@${'.'.repeat(60000)} `, `@a@${'b.'.repeat(60000)}`, `@a@b.example${'-'.repeat(60000)}`, `${'_'.repeat(60000)}@a@b.example`, `@a@b.example${'好'.repeat(60000)}`];
    await env.META.put('comments:long-tags', JSON.stringify([`see @lee,@${CAROL} ok`, ...long].map((text, i) => ({ id: `l${i}`, text, created, version: 1, author: { login: 'quinn', name: 'quinn' } }))));
    const started = process.hrtime.bigint();
    const r = await call('/api/comments?slug=long-tags', { cookie: alice.cookie });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert(r.status === 200 && r.body[0].text === `see @lee,@${CAROL} ok`, `invited: ${r.status} ${r.body && r.body[0].text}`);
    assert(!r.body[1].text.includes('example') && ms < 3000, `${Math.round(ms)} ms`);
    assert((await call('/api/comments?slug=long-tags')).body[0].text === 'see @lee,@carol.writer ok', 'another reader');
  });

  await t('with no secret configured there is no alias to match: every hidden address is the same placeholder', async () => {
    delete env.TDOC_EMAIL_ALIAS_SECRET;
    const r = await call('/api/comments?slug=open');
    assert(!leaks(r.text, CAROL, DAVE).length, 'leaks without a secret');
    assert(r.body[0].author.login === 'email-hidden' && r.body[0].replies[0].author.login === 'email-hidden', `placeholder ${r.body[0].author.login}`);
    assert(r.body[0].author.name === 'carol.writer', 'display name lost');
    const own = await call('/api/comments?slug=open', { cookie: carol });
    assert(own.body[0].author.login === `email:${CAROL}`, 'the commenter lost their own key');
    env.TDOC_EMAIL_ALIAS_SECRET = 'test-alias-secret';
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
