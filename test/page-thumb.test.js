// A My docs card shows the top of a doc's page as a small static SVG
// (/d/<slug>/v/<n>/thumb.svg), the way Google Docs shows a page, instead of
// the whole document in a frame per card (2026-11-15: the framed preview took
// ~10s to fill a grid). The picture is built from the page's text blocks,
// never its markup, so nothing in it can run or fetch.
const { loadWorker, makeEnv, req } = require('./helpers/worker-harness');
const SHELL = require('../server/shell.js');

let pass = 0, fail = 0;
async function t(n, fn) { try { await fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e.message}`); fail++; } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const PAGE = `<!doctype html><html><head><title>x</title><style>body{color:red}</style><script>alert(1)</script></head><body>
<h1>Plan &amp; budget</h1>
<p>Opening <b>line</b> with <a href="javascript:alert(2)">a link</a> and <img src="https://evil.example/x.png" alt="pic" onerror="alert(3)">.</p>
<h2>Goals</h2><ul><li>Ship it</li><li>&lt;script&gt;alert(4)&lt;/script&gt;</li></ul>
<table><tr><th>Item</th><th>Cost</th></tr><tr><td>Rent</td><td>$10</td></tr></table>
<iframe src="https://evil.example/frame"></iframe><svg onload="alert(5)"><text>svg text</text></svg>
<p>Control\u0001char</p>
</body></html>`;

function seed(env, visibility) {
  env.META.map.set('meta:plan', JSON.stringify({
    title: 'Plan', created: '2026-01-01T00:00:00Z',
    versions: [{ n: 1, created: '2026-01-01T00:00:00Z' }],
    hosted: { account_id: 'acct_owner0000', github_login: 'olivia' },
    access: { visibility, commenting: 'signed_in', history_visibility: 'owner', allowed_users: [] },
  }));
  env.DOCS.map.set('docs/plan/v1/index.html', PAGE);
  env.META.map.set('session:feedface01', JSON.stringify({ login: 'olivia', name: 'Olivia', email: 'olivia@example.com', account_id: 'acct_owner0000', created: new Date().toISOString() }));
  env.META.map.set('session:cafebabe01', JSON.stringify({ login: 'petra', name: 'Petra', email: 'petra@example.com', created: new Date().toISOString() }));
  return { owner: 'tdoc_sid=feedface01', other: 'tdoc_sid=cafebabe01' };
}

(async () => {
  console.log('doc card page thumbnails (thumb.svg)');

  await t('the picture is the page text as our own markup: no script, link, image or remote fetch', async () => {
    const svg = SHELL.pageThumbSvg(PAGE);
    assert(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), svg.slice(0, 80));
    assert(svg.includes('<h1>Plan &amp; budget</h1>'), 'title heading');
    assert(svg.includes('<h2>Goals</h2>') && svg.includes('<li>Ship it</li>'), 'heading and bullets');
    assert(svg.includes('<td>Rent</td>'), 'table rows');
    assert(svg.includes('&lt;script&gt;alert(4)&lt;/script&gt;'), 'text that looks like markup stays text');
    assert(!/<script|<iframe|<img|<a\b|onerror|onload|javascript:|evil\.example|href=|src=/i.test(svg), svg);
    assert(!/[\u0000-\u0008]/.test(svg), 'no control characters (XML refuses them)');
    assert(svg.length < 12000, `${svg.length} bytes`);
  });

  await t('a very long page stops at the top of the page', async () => {
    const long = '<h1>Long</h1>' + Array.from({ length: 500 }, (_, i) => `<p>Paragraph ${i} ${'word '.repeat(40)}</p>`).join('');
    const svg = SHELL.pageThumbSvg(long);
    assert(svg.length < 16000, `${svg.length} bytes`);
    assert(!svg.includes('Paragraph 100 '), 'later paragraphs are not in it');
  });

  const mod = await loadWorker();
  const worker = mod.default;

  await t('the owner gets the picture as an image that cannot run, and the browser may keep it', async () => {
    const env = makeEnv(mod.CommentsStore);
    const c = seed(env, 'private');
    const res = await worker.fetch(req('/d/plan/v/1/thumb.svg', { cookie: c.owner }), env, {});
    assert(res.status === 200, `status ${res.status}`);
    assert(/^image\/svg\+xml/.test(res.headers.get('content-type')), res.headers.get('content-type'));
    assert(/\bsandbox\b/.test(res.headers.get('content-security-policy') || ''), 'CSP sandbox');
    assert(/default-src 'none'/.test(res.headers.get('content-security-policy') || ''), 'CSP default-src none');
    assert(res.headers.get('x-content-type-options') === 'nosniff');
    assert(/^private\b/.test(res.headers.get('cache-control') || ''), res.headers.get('cache-control'));
    assert((await res.text()).includes('Plan &amp; budget'));
  });

  await t('a private doc gives nobody else its picture, and an unknown version is not found', async () => {
    const env = makeEnv(mod.CommentsStore);
    const c = seed(env, 'private');
    const other = await worker.fetch(req('/d/plan/v/1/thumb.svg', { cookie: c.other }), env, {});
    assert(other.status === 404, `other account: ${other.status}`);
    assert(!(await other.text()).includes('Plan'), 'nothing of the page');
    const anon = await worker.fetch(req('/d/plan/v/1/thumb.svg'), env, {});
    assert(anon.status === 404, `signed out: ${anon.status}`);
    const missing = await worker.fetch(req('/d/plan/v/9/thumb.svg', { cookie: c.owner }), env, {});
    assert(missing.status === 404, `missing version: ${missing.status}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
