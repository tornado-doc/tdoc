// A version whose first upload died after its bytes were stored (a 1102, a
// failed KV write) must not wedge the doc: when the CLI walks its versions
// upward, the next missing one is committed as latest and the newer ones
// follow (Julie, 2026-10-13: pi-agent-harness stuck at v5, v7/v8 refused).

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
  const owner = await issue(worker, env, 'owner');
  const up = async (version, latest) => {
    const versions = Array.from({ length: latest }, (_, i) => ({ n: i + 1, created: `2026-10-0${Math.min(i + 1, 9)}T00:00:00Z` }));
    const r = await worker.fetch(req('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'pi', version, html: `<p>v${version}</p>`, meta: { title: 'pi', versions } } }), env, {});
    let body = null; try { body = await r.json(); } catch {}
    return { status: r.status, body };
  };
  const latest = async () => (JSON.parse(await env.META.get('meta:pi')).versions || []).map((v) => v.n).pop();
  console.log('version catch-up');
  for (let v = 1; v <= 5; v++) assert((await up(v, v)).status === 200, `seed v${v}`);
  // v6's bytes landed, its meta write never did.
  await env.DOCS.put('docs/pi/v6/index.html', '<p>v6</p>');

  await t('walking up from the orphan commits each version in turn', async () => {
    const r6 = await up(6, 8);
    assert(r6.status === 200, `v6 ${r6.status} ${JSON.stringify(r6.body)}`);
    assert(await latest() === 6, `after v6 latest is ${await latest()}`);
    const r7 = await up(7, 8);
    assert(r7.status === 200, `v7 ${r7.status} ${JSON.stringify(r7.body)}`);
    const r8 = await up(8, 8);
    assert(r8.status === 200 && await latest() === 8, `v8 ${r8.status} latest ${await latest()}`);
  });

  await t('a jump past a missing version is still refused', async () => {
    const r = await up(10, 10);
    assert(r.status === 409 && r.body.error === 'version_conflict', `status ${r.status}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
