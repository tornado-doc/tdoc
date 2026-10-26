const assert = require('assert/strict');
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness');
(async () => {
  const mod = await loadWorker(); const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  const realFetch = globalThis.fetch; const asked = [];
  globalThis.fetch = async (url, init) => {
    if (typeof url === 'string' && url.startsWith('https://github.com/')) { asked.push(url); return new Response('gz', { status: url.includes('/missing.') ? 404 : 200 }); }
    return realFetch(url, init);
  };
  try {
    const sha = 'a'.repeat(40);
    const ok = await worker.fetch(req(`/install/source/${sha}.tar.gz`), env, {});
    assert.equal(ok.status, 200); assert.equal(await ok.text(), 'gz');
    assert.match(ok.headers.get('Cache-Control'), /immutable/);
    assert.deepEqual(asked, [`https://github.com/tornado-doc/tdoc/archive/${sha}.tar.gz`], 'only the official repository');
    assert.equal((await worker.fetch(req('/install/source/missing.tar.gz'), env, {})).status, 404);
    assert.equal((await worker.fetch(req('/install/source/..evil.tar.gz'), env, {})).status, 400);
    assert.notEqual((await worker.fetch(req('/install/source/a%2Fb.tar.gz'), env, {})).status, 200);
    console.log('✓ the install relay serves only tornado-doc/tdoc archives, so GitHub-blocked sandboxes can install');
  } finally { globalThis.fetch = realFetch; }
})().catch(e => { console.error(e); process.exit(1); });
