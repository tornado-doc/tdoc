// The document page reads only the head of a big document for its share
// excerpt, share image and onboarding CTA. Scanning a whole 1MB doc on every
// view tripped Cloudflare's per-request CPU limit (error 1102) for readers in
// China (Julie, 2026-10-08). The page must still describe the doc correctly.

const { loadWorker, makeEnv, req } = require('./helpers/worker-harness.js');

let pass = 0, fail = 0;
async function t(n, fn) {
  try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  console.log('shell scan cap');
  const created = '2026-01-01T00:00:00.000Z';
  const filler = '<p>' + 'Lorem ipsum dolor sit amet. '.repeat(40) + '</p>\n';
  const html = `<!doctype html><html><head><title>Big</title></head><body><h1>Big report</h1><p>Lead line of the report.</p>${filler.repeat(1400)}<a href="/start">Start</a></body></html>`;
  await env.META.put('meta:big-report', JSON.stringify({
    title: 'Big report', slug: 'big-report', created, versions: [{ n: 1, created }],
    access: { visibility: 'public', commenting: 'signed_in', history_visibility: 'public', allowed_users: [] },
  }));
  await env.DOCS.put('docs/big-report/v1/index.html', html);

  await t('a 1.5MB doc still gets its share excerpt from the top', async () => {
    assert(html.length > 1_400_000, `fixture is only ${html.length} bytes`);
    const r = await worker.fetch(req('/d/big-report/v/1'), env, {});
    const page = await r.text();
    assert(r.status === 200, `status ${r.status}`);
    const desc = (page.match(/property="og:description" content="([^"]*)"/) || [])[1] || "";
    assert(desc.includes("Big report Lead line of the report."), `excerpt: ${desc.slice(0, 80)}`);
  });

  await t('only the head is scanned: a /start link past it does not turn the page into onboarding', async () => {
    const r = await worker.fetch(req('/d/big-report/v/1'), env, {});
    const page = await r.text();
    assert(!/"onboarding":true/.test(page), 'the CTA at the end of a 1.5MB doc was scanned');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
