// The text copy of a doc that the page carries for agents (see
// docAgentView in worker.js): real body text a fetch tool keeps, never seen
// by a person. Without JavaScript it takes no visible space; once the app
// starts it is gone, so a screen reader does not read the doc twice.
// Real worker routes (in-process harness) behind a local HTTP server, real
// built shell runtime, desktop and phone widths.
// Run with: node test/agent-view-ui.test.js

const fs = require('fs');
const http = require('http');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { loadWorker, makeEnv } = require('./helpers/worker-harness');
const { loadRuntimeAssets } = require('../server/runtime-assets');

const { chromium } = requirePlaywrightOrSkip('agent-view-ui.test.js');

async function seed(env) {
  const created = '2026-01-01T00:00:00.000Z';
  await env.META.put('meta:roadmap', JSON.stringify({ title: 'Q3 roadmap', slug: 'roadmap', created, versions: [{ n: 1, created }], access: { visibility: 'public' } }));
  await env.DOCS.put('docs/roadmap/v1/index.html', '<!doctype html><html><body><h1>Q3 roadmap</h1><p>We ship the importer first.</p></body></html>');
}

async function startServer(worker, env) {
  const assets = loadRuntimeAssets();
  const byPath = new Map(assets.all.map((asset) => [asset.path, asset]));
  const server = http.createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    const asset = byPath.get(pathname);
    if (asset) {
      res.setHeader('content-type', asset.type);
      return res.end(fs.readFileSync(asset.file));
    }
    const response = await worker.fetch(new Request(`https://tdoc.dev${req.url}`, {
      method: req.method,
      headers: { ...req.headers, host: 'tdoc.dev' },
    }), env, { waitUntil() {} });
    const type = response.headers.get('content-type') || '';
    let body = Buffer.from(await response.arrayBuffer());
    if (type.includes('text/html')) {
      body = Buffer.from(body.toString('utf8')
        .replaceAll('__TDOC_SHELL_RUNTIME_JS_PATH__', assets.js.path)
        .replaceAll('__TDOC_SHELL_RUNTIME_CSS_PATH__', assets.css.path));
    }
    response.headers.forEach((value, key) => {
      if (!['content-length', 'content-encoding', 'content-security-policy'].includes(key)) res.setHeader(key, value);
    });
    res.statusCode = response.status;
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

(async () => {
  console.log('Agent view on doc pages');
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  await seed(env);
  const { server, base } = await startServer(worker, env);
  const browser = await chromium.launch({ headless: true });
  let failed = 0;
  const t = async (name, fn) => {
    try { await fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  try {
    for (const [label, width, height] of [['desktop', 1280, 820], ['phone', 390, 844]]) {
      await t(`${label}: without JavaScript the agent text is in the page but takes no visible space`, async () => {
        const context = await browser.newContext({ viewport: { width, height }, javaScriptEnabled: false });
        const page = await context.newPage();
        await page.goto(`${base}/d/roadmap`);
        const view = page.locator('#tdoc-agent-view');
        if (!(await view.count())) throw new Error('agent view missing from the served page');
        if (!(await view.innerText()).includes('We ship the importer first.')) throw new Error('agent view lacks the doc text');
        const box = await view.boundingBox();
        if (!box || box.width > 1 || box.height > 1) throw new Error(`agent view is visible: ${JSON.stringify(box)}`);
        // The no-JS page has its own <noscript> summary; the view adds nothing to it.
        const size = () => page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight].join('x'));
        const withView = await size();
        await view.evaluate((n) => n.remove());
        if ((await size()) !== withView) throw new Error(`agent view changes the page size: ${withView} vs ${await size()}`);
        await context.close();
      });
      await t(`${label}: once the app starts the agent text is gone and the doc shows`, async () => {
        const context = await browser.newContext({ viewport: { width, height } });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(`${base}/d/roadmap`);
        await page.frameLocator('iframe').locator('h1', { hasText: 'Q3 roadmap' }).waitFor({ timeout: 10000 });
        if (await page.locator('#tdoc-agent-view').count()) throw new Error('agent view still in the page after boot');
        await page.screenshot({ path: `/tmp/tdoc-agent-view-${label}.png` });
        if (errors.length) throw new Error(errors.join('\n'));
        await context.close();
      });
    }
  } finally {
    await browser.close();
    server.close();
  }
  console.log(failed ? `\n${failed} failed` : '\nall passed');
  process.exit(failed ? 1 : 0);
})();
