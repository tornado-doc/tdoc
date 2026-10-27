// Sharing like Google Docs: "Anyone with the link" (visibility `unlisted`)
// is readable signed out but never indexed or listed; "Public" stays
// indexable; a new doc defaults to the link; "Require sign-in to view" turns
// strangers into a sign-in; and the manual migration moves non-profile public
// docs to the link, dry run first.

const path = require('path');
const { pathToFileURL } = require('url');
const { loadWorker, makeEnv, req, issue, putSession, FakeKV } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

async function seed(env, slug, access, owner = null, extra = {}) {
  const created = '2026-01-01T00:00:00.000Z';
  await env.META.put(`meta:${slug}`, JSON.stringify({
    title: slug, slug, created, versions: [{ n: 1, created }],
    ...(owner ? { hosted: { account_id: owner.account_id, github_login: owner.login } } : {}),
    ...(access ? { access } : {}),
    ...extra,
  }));
  await env.DOCS.put(`docs/${slug}/v1/index.html`, `<h1>${slug} body</h1>`);
}

const ROBOTS_META = /<meta name="robots" content="noindex[^"]*">/;

(async () => {
  console.log('link sharing (anyone with the link / public / require sign-in / migration)');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = async (p, o = {}) => {
    const r = await worker.fetch(req(p, o), env, {});
    let body = null;
    try { body = await r.clone().json(); } catch {}
    return { status: r.status, body, r };
  };

  const alice = await issue(worker, env, 'alice');
  const bob = await issue(worker, env, 'bob');
  await seed(env, 'link-plan', { visibility: 'unlisted', commenting: 'signed_in', history_visibility: 'public', allowed_users: [] }, alice);
  await seed(env, 'open-plan', { visibility: 'public', commenting: 'signed_in', history_visibility: 'public', allowed_users: [] }, alice);
  await seed(env, 'legacy-plan', null, alice);

  const SURFACES = (slug) => [
    [`/d/${slug}`, {}],
    [`/d/${slug}/v/1`, {}],
    [`/d/${slug}/raw`, {}],
    [`/d/${slug}/v/1/raw`, {}],
    [`/d/${slug}/v/1/frame`, { dest: 'iframe' }],
    [`/d/${slug}/v/1/export`, {}],
  ];

  await t('a link doc is readable signed out on every surface, each with X-Robots-Tag noindex', async () => {
    for (const [p, o] of SURFACES('link-plan')) {
      const { status, r } = await call(p, o);
      assert(status === 200 || status === 302, `${p}: ${status}`);
      assert(/noindex/.test(r.headers.get('x-robots-tag') || ''), `${p}: X-Robots-Tag ${r.headers.get('x-robots-tag')}`);
    }
  });

  await t('the link doc page carries <meta name="robots" content="noindex">', async () => {
    const { r } = await call('/d/link-plan/v/1');
    const page = await r.text();
    const head = page.slice(0, page.indexOf('</head>'));
    assert(ROBOTS_META.test(head), 'no robots meta in head');
  });

  await t('a Public doc is unchanged: readable, no noindex header or meta', async () => {
    for (const slug of ['open-plan', 'legacy-plan']) {
      for (const [p, o] of SURFACES(slug)) {
        const { status, r } = await call(p, o);
        assert(status === 200 || status === 302, `${p}: ${status}`);
        assert(!r.headers.get('x-robots-tag'), `${p}: unexpected X-Robots-Tag ${r.headers.get('x-robots-tag')}`);
      }
      const page = await (await call(`/d/${slug}/v/1`)).r.text();
      assert(!ROBOTS_META.test(page.slice(0, page.indexOf('</head>'))), `${slug}: robots meta on a public doc`);
    }
  });

  await t('a private doc denial is noindex too', async () => {
    await seed(env, 'secret-plan', { visibility: 'private', allowed_users: [] }, alice);
    const { status, r } = await call('/d/secret-plan/v/1');
    assert(status === 401, `status ${status}`);
    assert(/noindex/.test(r.headers.get('x-robots-tag') || ''), 'denial lacks X-Robots-Tag');
  });

  await t('a link doc is absent from /llms.txt, /llms-full.txt and robots.txt', async () => {
    for (const p of ['/llms.txt', '/llms-full.txt', '/robots.txt']) {
      const { status, r } = await call(p);
      assert(status === 200, `${p}: ${status}`);
      assert(!(await r.text()).includes('link-plan'), `${p} names the link doc`);
    }
  });

  await t('a profile lists a pinned Public doc but never a pinned link doc', async () => {
    await env.META.put(`account-profile:${alice.account_id}`, JSON.stringify({ account_id: alice.account_id, handle: 'alice', pins: ['link-plan', 'open-plan'] }));
    const r = await worker.fetch(req('/@alice', { headers: { Accept: 'application/json' } }), env, {});
    const text = await r.text();
    assert(r.status === 200, `/@alice ${r.status}`);
    assert(text.includes('open-plan'), 'public pin missing');
    assert(!text.includes('link-plan'), 'link doc listed on the profile');
  });

  await t('commenting on a link doc still needs sign-in', async () => {
    const { status } = await call('/api/comments', { method: 'POST', body: { slug: 'link-plan', version: 1, text: 'hi', anchor: { text: 'body' } } });
    assert(status === 401 || status === 403, `signed-out comment got ${status}`);
  });

  await t('a new doc published with no access defaults to anyone with the link', async () => {
    const r = await call('/api/upload', { method: 'POST', token: alice.token, body: {
      slug: 'fresh-plan', version: 1, html: '<p>fresh</p>', meta: { title: 'Fresh', versions: [{ n: 1 }] },
    } });
    assert(r.status === 200, `upload ${r.status} ${JSON.stringify(r.body)}`);
    const meta = JSON.parse(await env.META.get('meta:fresh-plan'));
    assert(meta.access && meta.access.visibility === 'unlisted', `access ${JSON.stringify(meta.access)}`);
    assert(meta.access.history_visibility === 'owner', `history ${meta.access.history_visibility}: a new doc's history is owner-only, like a flagged publish`);
    const page = await call('/d/fresh-plan/v/1');
    assert(page.status === 200 && /noindex/.test(page.r.headers.get('x-robots-tag') || ''), 'fresh doc is not a noindex link doc');
  });

  await t('an explicit public publish stays public; republishing a legacy doc does not change it', async () => {
    const r = await call('/api/upload', { method: 'POST', token: alice.token, body: {
      slug: 'chosen-public', version: 1, html: '<p>p</p>',
      meta: { title: 'P', versions: [{ n: 1 }], access: { visibility: 'public', history_visibility: 'owner', commenting: 'signed_in', allowed_users: [] } },
    } });
    assert(r.status === 200, `upload ${r.status}`);
    assert(JSON.parse(await env.META.get('meta:chosen-public')).access.visibility === 'public', 'explicit public lost');
    // A doc from before access policies: published, then its access block
    // removed, as every such doc's record looks today.
    await call('/api/upload', { method: 'POST', token: alice.token, body: { slug: 'old-plan', version: 1, html: '<p>v1</p>', meta: { title: 'old', versions: [{ n: 1 }] } } });
    const stored = JSON.parse(await env.META.get('meta:old-plan'));
    delete stored.access;
    await env.META.put('meta:old-plan', JSON.stringify(stored));
    const again = await call('/api/upload', { method: 'POST', token: alice.token, body: {
      slug: 'old-plan', version: 2, html: '<p>v2</p>', meta: { title: 'old', versions: [{ n: 1 }, { n: 2 }] },
    } });
    assert(again.status === 200, `republish ${again.status} ${JSON.stringify(again.body)}`);
    assert(!JSON.parse(await env.META.get('meta:old-plan')).access, 'republish rewrote a legacy doc\'s access');
  });

  await t('a blank doc created in the browser defaults to anyone with the link', async () => {
    const r = await call('/api/doc/create', { method: 'POST', cookie: alice.cookie, body: {} });
    assert(r.status === 200, `create ${r.status} ${JSON.stringify(r.body)}`);
    const meta = JSON.parse(await env.META.get(`meta:${r.body.slug}`));
    assert(meta.access && meta.access.visibility === 'unlisted' && meta.access.history_visibility === 'owner', JSON.stringify(meta.access));
  });

  await t('My docs tells the owner how each of their docs is shared (for the pin warning), and nobody else', async () => {
    const r = await call('/api/me', { token: alice.token });
    assert(r.status === 200, `/api/me ${r.status}`);
    const rows = Object.fromEntries((r.body.docs || []).map((d) => [d.slug, d]));
    assert(rows['fresh-plan'] && rows['fresh-plan'].visibility === 'unlisted', JSON.stringify(rows['fresh-plan']));
    assert(rows['chosen-public'] && rows['chosen-public'].visibility === 'public', JSON.stringify(rows['chosen-public']));
    const shell = require('fs').readFileSync(path.join(__dirname, '..', 'shell', 'src', 'docs-hub.jsx'), 'utf8')
      + require('fs').readFileSync(path.join(__dirname, '..', 'shell', 'src', 'profile.jsx'), 'utf8');
    assert((shell.match(/Pinning makes this doc Public \(searchable\)/g) || []).length === 2, 'both pin paths must warn');
  });

  await t('Require sign-in to view: strangers get sign-in, any signed-in account reads', async () => {
    const body = (access) => ({ slug: 'fresh-plan', access });
    const patch = await call('/api/doc/access', { method: 'PATCH', token: alice.token, body: body({ signin_required: true }) });
    assert(patch.status === 200, `patch ${patch.status} ${JSON.stringify(patch.body)}`);
    assert(patch.body.access.signin_required === true && patch.body.access.visibility === 'unlisted', JSON.stringify(patch.body.access));
    const out = await call('/d/fresh-plan/v/1');
    assert(out.status === 401, `signed out got ${out.status}`);
    assert(/Sign in/.test(await out.r.text()), 'no sign-in offer');
    const raw = await call('/d/fresh-plan/v/1/raw');
    assert(raw.status === 401, `signed-out raw got ${raw.status}`);
    const carol = await putSession(env, 'carol');
    const inn = await call('/d/fresh-plan/v/1', { cookie: carol });
    assert(inn.status === 200, `signed-in stranger got ${inn.status}`);
    assert(/noindex/.test(inn.r.headers.get('x-robots-tag') || ''), 'still noindex');
    const bobRaw = await call('/d/fresh-plan/v/1/raw', { token: bob.token });
    assert(bobRaw.status === 200 && /private/.test(bobRaw.r.headers.get('cache-control')), `bob raw ${bobRaw.status} ${bobRaw.r.headers.get('cache-control')}`);
    const bad = await call('/api/doc/access', { method: 'PATCH', token: alice.token, body: body({ signin_required: 'yes' }) });
    assert(bad.status === 400, `non-boolean accepted: ${bad.status}`);
    const pub = await call('/api/doc/access', { method: 'PATCH', token: alice.token, body: body({ visibility: 'public' }) });
    assert(pub.status === 200 && !pub.body.access.signin_required, `public keeps signin_required ${JSON.stringify(pub.body.access)}`);
    assert((await call('/d/fresh-plan/v/1')).status === 200, 'public doc not readable signed out');
  });

  // ---- migration ----
  const mig = await import(pathToFileURL(path.join(__dirname, '..', 'worker', 'migrate-public-to-link.mjs')).href);
  const kv = new FakeKV();
  const put = (slug, meta) => kv.put(`meta:${slug}`, JSON.stringify({ title: slug, slug, versions: [{ n: 1 }], ...meta }), { metadata: { v: 1, t: slug } });
  await put('m-legacy', {});
  await put('m-public', { access: { visibility: 'public', commenting: 'invited', history_visibility: 'owner', allowed_users: ['x'] } });
  await put('m-pinned', { access: { visibility: 'public' } });
  await put('m-curated', { access: { visibility: 'public' }, profile: { curated: true, restore_visibility: 'unlisted' } });
  await put('tornado-doc', { access: { visibility: 'public' } });
  await put('m-link', { access: { visibility: 'unlisted' } });
  await put('m-private', { access: { visibility: 'private' } });
  await put('m-pinned-link', { access: { visibility: 'unlisted' }, hosted: { account_id: 'acct_1' } });
  await kv.put('account-profile:acct_1', JSON.stringify({ account_id: 'acct_1', pins: ['m-pinned', 'm-pinned-link'] }));
  await put('m-acct-public', { access: { visibility: 'public' }, hosted: { account_id: 'acct_2' } });
  await put('m-acct-private', { access: { visibility: 'private' }, hosted: { account_id: 'acct_2' } });
  await put('m-acct-gated', { access: { visibility: 'unlisted', signin_required: true }, hosted: { account_id: 'acct_2' } });
  const snapshot = () => JSON.stringify([...kv.map.entries()]);

  await t('migration dry run counts and lists, and writes nothing', async () => {
    const before = snapshot();
    const res = await mig.runMigration(kv, { write: false, now: '2026-10-24T00:00:00Z' });
    assert(snapshot() === before, 'dry run wrote');
    assert(res.counts.public === 5 && res.counts.legacy === 1, JSON.stringify(res.counts));
    assert(res.counts.kept_pinned === 2 && res.counts.kept_site === 1 && res.counts.changed === 3, JSON.stringify(res.counts));
    assert(res.changed.sort().join(',') === 'm-acct-public,m-legacy,m-public', res.changed.join(','));
  });

  await t('migration dry run reports pinned docs that are not Public, and leaves them alone', async () => {
    const res = await mig.runMigration(kv, { write: false });
    assert(res.counts.pinned_not_public === 1, JSON.stringify(res.counts));
    assert(res.pinned_not_public[0].slug === 'm-pinned-link' && res.pinned_not_public[0].visibility === 'unlisted' && res.pinned_not_public[0].pinned_by === 'acct_1',
      JSON.stringify(res.pinned_not_public));
    assert(!res.changed.includes('m-pinned-link'), 'a pinned link doc was scheduled for change');
  });

  await t('migration --account is read-only and counts one account\'s docs by visibility', async () => {
    const before = snapshot();
    const res = await mig.runMigration(kv, { account: 'acct_2', write: true });
    assert(snapshot() === before, '--account wrote');
    assert(res.write === false && res.counts.docs === 3, JSON.stringify(res.counts));
    assert(JSON.stringify(res.by_visibility) === JSON.stringify({ public: 1, private: 1, 'unlisted (sign-in required)': 1 }), JSON.stringify(res.by_visibility));
    assert(res.plan.length === 1 && res.plan[0].slug === 'm-acct-public' && res.plan[0].action === 'move to unlisted', JSON.stringify(res.plan));
  });

  await t('migration apply moves only non-profile public docs, keeps the rest of the policy and the KV metadata', async () => {
    await mig.runMigration(kv, { write: true, now: '2026-10-24T00:00:00Z' });
    const get = async (s) => JSON.parse(await kv.get(`meta:${s}`));
    const legacy = await get('m-legacy');
    assert(legacy.access.visibility === 'unlisted' && legacy.access.history_visibility === 'public' && legacy.access_migration.from === 'legacy', JSON.stringify(legacy));
    const pub = await get('m-public');
    assert(pub.access.visibility === 'unlisted' && pub.access.commenting === 'invited' && pub.access.allowed_users[0] === 'x', JSON.stringify(pub.access));
    for (const s of ['m-pinned', 'm-curated', 'tornado-doc']) assert((await get(s)).access.visibility === 'public', `${s} changed`);
    assert((await get('m-private')).access.visibility === 'private', 'private changed');
    assert(JSON.stringify(kv.metadata.get('meta:m-public')) === JSON.stringify({ v: 1, t: 'm-public' }), 'metadata lost');
  });

  await t('migration is idempotent: a second run changes nothing', async () => {
    const before = snapshot();
    const res = await mig.runMigration(kv, { write: true });
    assert(res.changed.length === 0 && snapshot() === before, JSON.stringify(res.counts));
  });

  await t('migration --undo restores what it changed', async () => {
    const res = await mig.runMigration(kv, { write: true, undo: true });
    assert(res.changed.sort().join(',') === 'm-acct-public,m-legacy,m-public', res.changed.join(','));
    assert(!JSON.parse(await kv.get('meta:m-legacy')).access, 'legacy not restored');
    assert(JSON.parse(await kv.get('meta:m-public')).access.visibility === 'public', 'public not restored');
  });

  await t('the migration is not wired into deploy or the worker', async () => {
    const fs = require('fs');
    const root = path.join(__dirname, '..');
    const wf = path.join(root, '.github', 'workflows');
    const files = fs.existsSync(wf) ? fs.readdirSync(wf).map((f) => fs.readFileSync(path.join(wf, f), 'utf8')) : [];
    files.push(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert(!files.some((s) => s.includes('migrate-public-to-link')), 'migration referenced by a workflow or package.json');
    const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
    assert(!/import[^;]*migrate-public-to-link/.test(worker), 'worker imports the migration');
  });

  await t('tdoc-publish documents unlisted as the default and keeps public', async () => {
    const src = require('fs').readFileSync(path.join(__dirname, '..', 'bin', 'tdoc-publish'), 'utf8');
    assert(/--visibility unlisted\|public\|private\s+\(default for a new doc: unlisted/.test(src), 'usage line');
    assert(/''\|public\|unlisted\|private\) ;;/.test(src), 'accepted values');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
