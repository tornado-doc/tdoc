// My docs must cost what the viewer owns, not what the whole platform holds.
// Every doc's meta key carries a small index in KV metadata; the catalog,
// the quota count and the newest-doc lookup read the index and fetch only the
// viewer's rows in full (Julie, 2026-10-11: Cloudflare 1102 for everyone).

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
  console.log('catalog index');
  const me = await issue(worker, env, 'me');
  const other = await issue(worker, env, 'other');
  for (let i = 0; i < 3; i++) {
    await call('/api/upload', { method: 'POST', token: me.token, body: { slug: `mine-${i}`, version: 1, html: `<p>mine ${i}</p>` } });
  }
  for (let i = 0; i < 60; i++) {
    await call('/api/upload', { method: 'POST', token: other.token, body: { slug: `theirs-${i}`, version: 1, html: `<p>theirs ${i}</p>` } });
  }
  // One doc from before the index existed: a meta value with no metadata.
  const legacy = JSON.parse(await env.META.get('meta:theirs-0'));
  await env.META.put('meta:theirs-legacy', JSON.stringify({ ...legacy, title: 'Legacy' }));

  await t('every published doc carries an owner index in its KV metadata', async () => {
    const md = env.META.metadata.get('meta:mine-0');
    assert(md && md.v === 1 && md.a === me.account_id && md.l === 1, JSON.stringify(md));
  });

  await t('My docs reads only the viewer\'s rows in full, however many docs others have', async () => {
    env.META.gets = [];
    const r = await call('/api/me', { token: me.token });
    assert(r.status === 200, `status ${r.status}`);
    const slugs = (r.body.docs || []).map((d) => d.slug).sort();
    assert(JSON.stringify(slugs) === JSON.stringify(['mine-0', 'mine-1', 'mine-2']), JSON.stringify(slugs));
    const metaReads = env.META.gets.filter((k) => k.startsWith('meta:'));
    assert(metaReads.filter((k) => k.startsWith('meta:theirs-') && k !== 'meta:theirs-legacy').length === 0,
      `read other people's docs: ${metaReads.join(', ')}`);
  });

  await t('a doc written before the index is read once and indexed on the way', async () => {
    const md = env.META.metadata.get('meta:theirs-legacy');
    assert(md && md.a === other.account_id, `legacy key not backfilled: ${JSON.stringify(md)}`);
    env.META.gets = [];
    await call('/api/me', { token: me.token });
    assert(!env.META.gets.includes('meta:theirs-legacy'), 'the backfilled key is still read in full');
  });

  await t('renaming and moving keep the index current', async () => {
    const renamed = await call('/api/doc/title', { method: 'PATCH', token: me.token, body: { slug: 'mine-1', title: 'Renamed' } });
    assert(renamed.status === 200 && env.META.metadata.get('meta:mine-1').t === 'Renamed', `title not in the index: ${renamed.status}`);
    const team = await call('/api/teams', { method: 'POST', token: me.token, body: { name: 'Idx' } });
    await call('/api/team/move', { method: 'POST', token: me.token, body: { team: team.body.team.id, slugs: ['mine-2'] } });
    assert(env.META.metadata.get('meta:mine-2').w === team.body.team.id, 'team not in the index');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
