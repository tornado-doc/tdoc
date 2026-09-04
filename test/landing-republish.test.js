// #458 — the homepage is one v1, re-shipped in place.
//
// bin/tdoc-landing-release collapses landing/tornado-doc to a single v1 and
// publish-landing.yml uploads that v1 on every deploy to main. The worker's
// upload rule since #329 refuses to rewrite a version that already exists
// unless the freshly-stamped bytes are identical — right for `tdoc publish`,
// fatal for the homepage, whose bytes change with every reader.css change
// (the repo HTML carries no baked reader block) and with every landing edit.
// Every run from 2026-09-01 to 2026-09-04 died on that 409.
//
// The contract this pins: `replace: true` rewrites the LATEST version in
// place, from the provider upload token only. Plain re-upload keeps its
// guard, a hosted token cannot replace, a historical version cannot be
// replaced, and a version above latest is unaffected by the flag.

const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const TOKEN = 'provider-upload-token';
const SLUG = 'tornado-doc';

// The shape bin/tdoc-landing-release writes: one version, public, commentable,
// history owner-only.
function landingMeta(slug = SLUG) {
  return {
    slug,
    title: 'tdoc',
    created: '2026-08-01T00:00:00Z',
    versions: [{ n: 1, created: '2026-08-28T00:00:00Z', prompt: 'tdoc landing page' }],
    access: { visibility: 'public', history_visibility: 'owner', commenting: 'signed_in', allowed_users: [] },
  };
}

function page(headline) {
  return `<!doctype html><html><head><title>tdoc</title></head><body><h1>${headline}</h1><p>Prompt-native docs.</p></body></html>`;
}

async function upload(worker, env, body, token = TOKEN) {
  const r = await worker.fetch(req('/api/upload', { method: 'POST', token, body }), env, {});
  let data = {};
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

function storedV1(env, slug = SLUG) {
  return env.DOCS.map.get(`docs/${slug}/v1/index.html`) || '';
}

function versionsOf(env, slug = SLUG) {
  return JSON.parse(env.META.map.get(`meta:${slug}`)).versions;
}

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  // The landing shell fetches a GitHub star count server-side; keep the suite
  // offline and deterministic.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 404 });
  console.log('landing republish (#458)');

  const env = makeEnv(mod.CommentsStore, { TDOC_UPLOAD_TOKEN: TOKEN });

  await t('first publish of the homepage slug lands v1', async () => {
    const r = await upload(worker, env, { slug: SLUG, version: 1, html: page('First homepage'), meta: landingMeta() });
    assert(r.status === 200 && r.data.ok === true, `expected 200 ok, got ${r.status} ${JSON.stringify(r.data)}`);
    assert(storedV1(env).includes('First homepage'), 'v1 bytes not stored');
    assert(versionsOf(env).map((v) => v.n).join() === '1', 'expected exactly v1');
  });

  await t('re-shipping identical bytes without replace is still accepted', async () => {
    const r = await upload(worker, env, { slug: SLUG, version: 1, html: page('First homepage'), meta: landingMeta() });
    assert(r.status === 200 && r.data.ok === true, `expected 200 ok, got ${r.status} ${JSON.stringify(r.data)}`);
  });

  await t('re-shipping changed bytes without replace is the 409 CI was dying on', async () => {
    const r = await upload(worker, env, { slug: SLUG, version: 1, html: page('Second homepage'), meta: landingMeta() });
    assert(r.status === 409, `expected 409, got ${r.status} ${JSON.stringify(r.data)}`);
    assert(r.data.error === 'version_conflict' && r.data.baseVersion === 0 && r.data.latestVersion === 1,
      `unexpected body ${JSON.stringify(r.data)}`);
    assert(storedV1(env).includes('First homepage'), 'a refused upload must not touch the stored bytes');
  });

  await t('replace:true rewrites v1 in place — no v2, version list unchanged, sha refreshed', async () => {
    const before = versionsOf(env)[0].sha;
    const r = await upload(worker, env, { slug: SLUG, version: 1, html: page('Second homepage'), meta: landingMeta(), replace: true });
    assert(r.status === 200 && r.data.ok === true, `expected 200 ok, got ${r.status} ${JSON.stringify(r.data)}`);
    assert(r.data.url === `/d/${SLUG}/v/1`, `expected the v1 url, got ${r.data.url}`);
    const stored = storedV1(env);
    assert(stored.includes('Second homepage') && !stored.includes('First homepage'), 'v1 bytes were not replaced');
    assert(!env.DOCS.map.has(`docs/${SLUG}/v2/index.html`), 'replace must not append a v2');
    const versions = versionsOf(env);
    assert(versions.map((v) => v.n).join() === '1', `expected exactly v1, got ${JSON.stringify(versions)}`);
    assert(versions[0].sha && versions[0].sha !== before, 'the v1 entry must record the hash of the new bytes');
    assert(versions[0].prompt === 'tdoc landing page', 'the landing version entry must keep its payload fields');
  });

  await t('tdoc.dev/ serves the replaced homepage', async () => {
    const r = await worker.fetch(req('/'), env, {});
    const html = await r.text();
    assert(r.status === 200, `expected 200 from /, got ${r.status}`);
    // What publish-landing.yml greps for after the upload: the doc, not the
    // neutral fallback.
    assert(html.includes('"slug":"tornado-doc"') && html.includes('"isLanding":true'),
      'the homepage is on the neutral fallback, not the landing doc');
    const frame = await worker.fetch(req(`/d/${SLUG}/v/1/frame`, { dest: 'iframe' }), env, {});
    const body = await frame.text();
    assert(frame.status === 200 && body.includes('Second homepage') && !body.includes('First homepage'),
      `the frame does not carry the replaced bytes (${frame.status})`);
  });

  await t('a hosted account token cannot replace, even its own doc', async () => {
    const hosted = await issue(worker, env, 'mallory');
    const own = await upload(worker, env, { slug: 'mallory-doc', version: 1, html: page('mine') }, hosted.token);
    assert(own.status === 200, `hosted publish failed ${own.status} ${JSON.stringify(own.data)}`);
    const r = await upload(worker, env, { slug: 'mallory-doc', version: 1, html: page('rewritten'), replace: true }, hosted.token);
    assert(r.status === 403 && r.data.error === 'replace_forbidden', `expected 403 replace_forbidden, got ${r.status} ${JSON.stringify(r.data)}`);
    assert(storedV1(env, 'mallory-doc').includes('mine'), 'a refused replace must not touch the stored bytes');
    const steal = await upload(worker, env, { slug: SLUG, version: 1, html: page('stolen'), replace: true }, hosted.token);
    assert(steal.status === 403, `a hosted token must not replace the homepage, got ${steal.status}`);
    assert(storedV1(env).includes('Second homepage'), 'the homepage bytes must be untouched');
  });

  await t('replace never rewrites a historical version; the latest still can be', async () => {
    const two = await upload(worker, env, {
      slug: SLUG, version: 2, html: page('Third homepage'),
      meta: { ...landingMeta(), versions: [...landingMeta().versions, { n: 2, created: '2026-09-04T00:00:00Z' }] },
    });
    assert(two.status === 200, `appending v2 failed ${two.status} ${JSON.stringify(two.data)}`);
    const hist = await upload(worker, env, { slug: SLUG, version: 1, html: page('Rewritten history'), meta: landingMeta(), replace: true });
    assert(hist.status === 409 && hist.data.error === 'replace_not_latest' && hist.data.latestVersion === 2,
      `expected 409 replace_not_latest, got ${hist.status} ${JSON.stringify(hist.data)}`);
    assert(storedV1(env).includes('Second homepage'), 'v1 must be untouched');
    const latest = await upload(worker, env, {
      slug: SLUG, version: 2, html: page('Fourth homepage'), replace: true,
      meta: { ...landingMeta(), versions: [...landingMeta().versions, { n: 2, created: '2026-09-04T00:00:00Z' }] },
    });
    assert(latest.status === 200, `replacing the latest failed ${latest.status} ${JSON.stringify(latest.data)}`);
    assert((env.DOCS.map.get(`docs/${SLUG}/v2/index.html`) || '').includes('Fourth homepage'), 'v2 was not replaced');
    assert(versionsOf(env).map((v) => v.n).join() === '1,2', 'replace must not change the version list');
  });

  await t('replace on a version above latest is a plain append', async () => {
    const r = await upload(worker, env, {
      slug: SLUG, version: 3, html: page('Fifth homepage'), replace: true,
      meta: { ...landingMeta(), versions: [{ n: 1 }, { n: 2 }, { n: 3, created: '2026-09-04T01:00:00Z' }] },
    });
    assert(r.status === 200 && r.data.url === `/d/${SLUG}/v/3`, `expected v3 to land, got ${r.status} ${JSON.stringify(r.data)}`);
    assert(versionsOf(env).map((v) => v.n).join() === '1,2,3', 'v3 must be appended');
  });

  globalThis.fetch = realFetch;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
