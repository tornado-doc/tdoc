// A doc's author name and its per-version publisher come from the credential
// that published it, never from the request (Julie, 2026-10-12: docs from
// other people's agents showed up under her account wearing their names).

const crypto = require('crypto');
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
  console.log('publish attribution');
  const owner = await issue(worker, env, 'owner');
  // A second credential on the same account that carries no GitHub handle
  // (an email-born token): exactly the shape that let a spoofed name stick.
  const bare = 'bare-token-for-test';
  const hash = crypto.createHash('sha256').update(bare).digest('hex');
  await env.META.put(`hosted-token:${hash}`, JSON.stringify({ account_id: owner.account_id, email: 'owner@example.com', created: new Date().toISOString() }));

  await t('a request cannot set the author name', async () => {
    const r = await call('/api/upload', { method: 'POST', token: bare, body: {
      slug: 'spoof', version: 1, html: '<p>x</p>',
      meta: { hosted: { github_login: 'mallory', owner_key: 'mallory' }, versions: [{ n: 1, created: '2026-01-01T00:00:00Z', token: 'forged000000' }] },
    } });
    assert(r.status === 200, `upload ${r.status} ${JSON.stringify(r.body)}`);
    const meta = JSON.parse(await env.META.get('meta:spoof'));
    assert(meta.hosted.github_login !== 'mallory' && meta.hosted.owner_key !== 'mallory', JSON.stringify(meta.hosted));
  });

  await t('each version records which credential published it, and a client cannot forge it', async () => {
    const meta = JSON.parse(await env.META.get('meta:spoof'));
    assert(meta.versions[0].token === hash.slice(0, 12), JSON.stringify(meta.versions));
    await call('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'spoof', version: 2, html: '<p>y</p>', meta: { versions: [{ n: 1, created: '2026-01-01T00:00:00Z', token: 'forged000000' }, { n: 2 }] } } });
    const after = JSON.parse(await env.META.get('meta:spoof'));
    const ownerHash = crypto.createHash('sha256').update(owner.token).digest('hex').slice(0, 12);
    assert(after.versions.find((v) => v.n === 2).token === ownerHash, JSON.stringify(after.versions));
    assert(after.versions.find((v) => v.n === 1).token === hash.slice(0, 12), `v1's publisher was rewritten: ${JSON.stringify(after.versions)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
