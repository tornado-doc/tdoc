// My docs rows carry the doc's opening line (Julie, 2026-10-14: "my docs
// 那边可不可以也有 preview 这样一眼知道是啥"). The catalog reads it from
// meta.preview, which publish writes, so listing never fetches a document
// body; the same field reaches team docs through the shared row.
const { loadWorker, makeEnv, req, issue } = require('./helpers/worker-harness');

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  console.log('My docs preview');

  await t('a published doc lists with its opening line', async () => {
    const env = makeEnv(mod.CommentsStore);
    const owner = await issue(worker, env, 'owner');
    const up = await worker.fetch(req('/api/upload', { method: 'POST', token: owner.token, body: {
      slug: 'q3-plan', version: 1,
      html: '<h1>Q3 plan</h1><p>We ship the agent picker, team folders and faster My docs this quarter.</p>',
    } }), env, {});
    assert(up.status === 200, `upload ${up.status}`);
    const me = await (await worker.fetch(req('/api/me', { cookie: owner.cookie }), env, {})).json();
    const row = (me.docs || []).find((d) => d.slug === 'q3-plan');
    assert(row, JSON.stringify(me.docs));
    assert(/agent picker, team folders/.test(row.excerpt || ''), `excerpt: ${JSON.stringify(row.excerpt)}`);
    assert(row.excerpt.length <= 180, `excerpt is ${row.excerpt.length} chars`);
  });

  await t('listing does not read document bodies', async () => {
    const env = makeEnv(mod.CommentsStore);
    const owner = await issue(worker, env, 'owner');
    await worker.fetch(req('/api/upload', { method: 'POST', token: owner.token, body: { slug: 'notes', version: 1, html: '<p>hello there world</p>' } }), env, {});
    const get = env.DOCS.get.bind(env.DOCS);
    let bodyReads = 0;
    env.DOCS.get = async (key, ...rest) => { if (/\/index\.html$/.test(key)) bodyReads++; return get(key, ...rest); };
    await worker.fetch(req('/api/me', { cookie: owner.cookie }), env, {});
    env.DOCS.get = get;
    assert(bodyReads === 0, `My docs fetched ${bodyReads} document bodies`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
