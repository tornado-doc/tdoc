// Bare /d/<slug> (no /v/<n>) resolves to the latest version via redirect.
//
// Before this route existed, the canonical short link — the thing people
// naturally paste — bounced to the not-found landing while every versioned
// URL of the same doc kept working. The route redirects to /v/<latest>, and
// it enforces the access gate BEFORE redirecting so an unauthorized probe
// sees the same denial as /v/<n> and never learns the version count.

const { loadWorker, makeEnv, req } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  console.log('doc head redirect (/d/<slug> → latest)');
  const mod = await loadWorker();
  const worker = mod.default;

  async function seed(env, slug, versions, extraMeta = {}) {
    await env.META.put(`meta:${slug}`, JSON.stringify({
      title: slug,
      versions: versions.map((n) => ({ n, created: `2026-01-0${n}T00:00:00Z` })),
      ...extraMeta,
    }));
    for (const n of versions) {
      await env.DOCS.put(`docs/${slug}/v${n}/index.html`, `<h1>${slug} v${n}</h1>`);
    }
  }

  await t('bare /d/<slug> 302s to the latest version', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seed(env, 'pricing', [1, 2, 3]);
    const r = await worker.fetch(req('/d/pricing'), env, {});
    assert(r.status === 302, `expected 302, got ${r.status}`);
    assert(r.headers.get('Location') === '/d/pricing/v/3',
      `expected /d/pricing/v/3, got ${r.headers.get('Location')}`);
  });

  await t('trailing slash form redirects the same way', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seed(env, 'pricing', [1, 2]);
    const r = await worker.fetch(req('/d/pricing/'), env, {});
    assert(r.status === 302 && r.headers.get('Location') === '/d/pricing/v/2',
      `expected 302 → /d/pricing/v/2, got ${r.status} → ${r.headers.get('Location')}`);
  });

  await t('unknown slug keeps the not-found landing redirect', async () => {
    const env = makeEnv(mod.CommentsStore);
    const r = await worker.fetch(req('/d/never-published'), env, {});
    assert(r.status === 302, `expected 302, got ${r.status}`);
    assert(r.headers.get('Location') === '/?notice=notfound',
      `expected /?notice=notfound, got ${r.headers.get('Location')}`);
  });

  await t('private doc denies anonymous probe instead of leaking latest version', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seed(env, 'secret-plan', [1, 2, 3, 4], {
      access: { visibility: 'private' },
    });
    const r = await worker.fetch(req('/d/secret-plan'), env, {});
    assert(r.status !== 302, `must not redirect, got 302 → ${r.headers.get('Location')}`);
    assert(r.status === 401 || r.status === 403, `expected 401/403, got ${r.status}`);
  });

  await t('versioned routes are untouched by the head route', async () => {
    const env = makeEnv(mod.CommentsStore);
    await seed(env, 'pricing', [1, 2]);
    const r = await worker.fetch(req('/d/pricing/v/1'), env, {});
    assert(r.status === 200, `expected 200, got ${r.status}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
