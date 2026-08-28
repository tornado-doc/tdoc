// React/Vite shell architecture guard. Author HTML remains isolated and
// framework-free; provider UI is emitted as boot data plus hashed assets.
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, error) { console.log(`  ✗ ${name}\n    ${error}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (error) { bad(name, error.message); } }

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const worker = read('worker/worker.js');
const bundler = read('bin/tdoc-bundle');

(async () => {
  console.log('React worker shell architecture\n');

  await t('bundle embeds only the shell builder, frame probe, reader CSS, and Vite runtime', async () => {
    for (const marker of ['/* __TDOC_SHELL_MODULE__ */', '__TDOC_PROBE_JS__', '__TDOC_READER_CSS__', '__TDOC_SHELL_RUNTIME_JS__', '__TDOC_SHELL_RUNTIME_CSS__']) {
      if (!bundler.includes(marker)) throw new Error(`missing ${marker}`);
    }
    for (const retired of ['CHROME_MODULE', 'CHROME_JS', 'MANAGE_JS', 'SIGNIN_JS', 'ONBOARD_JS']) {
      if (bundler.includes(retired)) throw new Error(`legacy bundle input remains: ${retired}`);
    }
    if (!bundler.includes('sha([worker, shellMod, frameProbe, readerCss, runtimeJs, runtimeCss]')) {
      throw new Error('bundle hash does not cover the complete runtime input set');
    }
  });

  await t('worker declares the shell/probe/runtime placeholders without legacy chrome globals', async () => {
    for (const marker of ['/* __TDOC_SHELL_MODULE__ */', 'const PROBE_JS = `__TDOC_PROBE_JS__`', 'const SHELL_RUNTIME_JS = `__TDOC_SHELL_RUNTIME_JS__`']) {
      if (!worker.includes(marker)) throw new Error(`worker missing ${marker}`);
    }
    if (!worker.includes('globalThis.TDOC_SHELL_BUILDER')) throw new Error('shell builder accessor missing');
    if (/TDOC_CHROME|CHROME_JS|MANAGE_JS/.test(worker)) throw new Error('legacy chrome runtime remains');
  });

  await t('shell HTML is an empty React root plus boot data and hashed assets', async () => {
    const shell = require(path.join(ROOT, 'server/shell.js'));
    const doc = shell.shellHtml({
      title: 'Demo',
      nonceAttr: ' nonce="abc"',
      cfgJson: '{"slug":"demo"}',
      bootJson: '{"frameSrc":"/d/demo/v/3/frame"}',
      runtimeJsPath: '/shell.abc.js',
      runtimeCssPath: '/shell.abc.css',
    });
    if (!doc.includes('<div id="tdoc-shell-root"></div>')) throw new Error('empty React root missing');
    if (!doc.includes('window.__TDOC_SHELL__')) throw new Error('config boot missing');
    if (!doc.includes('window.__TDOC_SHELL_BOOT__')) throw new Error('page boot missing');
    if (!doc.includes('type="module" src="/shell.abc.js" nonce="abc"')) throw new Error('Vite module missing');
    if (/<iframe|class="tdoc-bar"/.test(doc)) throw new Error('server still renders provider UI');
  });

  await t('document entry renders React components and never starts a legacy engine', async () => {
    const entry = read('shell/src/main.jsx');
    if (!entry.includes('createRoot(root).render(<DocumentShell')) throw new Error('DocumentShell render missing');
    if (/hydrateRoot|legacy-shell|startLegacyShell/.test(entry)) throw new Error('legacy hydration path remains');
    for (const file of [
      'shell/src/document/comment-card.jsx',
      'shell/src/document/comment-layer.jsx',
      'shell/src/document/document-toolbar.jsx',
      'shell/src/hooks/use-frame-bridge.js',
      'shell/src/hooks/use-comments.js',
      'shell/src/ui/dialog.jsx',
      'shell/src/ui/menu.jsx',
    ]) {
      if (!fs.existsSync(path.join(ROOT, file))) throw new Error(`component boundary missing: ${file}`);
    }
  });

  await t('author frame stays destination-gated, access-gated, probed, and sandboxed', async () => {
    const start = worker.indexOf('const frameMatch = p.match(/^\\/d\\/([^/]+)\\/v\\/(\\d+)\\/frame');
    const block = worker.slice(start, start + 2400);
    for (const needle of ['isWidgetFrameRequest', 'enforceDocAccess(', '${PROBE_JS}', 'frameCspHeader(nonce)']) {
      if (!block.includes(needle)) throw new Error(`/frame missing ${needle}`);
    }
    const csp = worker.slice(worker.indexOf('function frameCspHeader'), worker.indexOf('function frameCspHeader') + 300);
    if (!csp.includes('sandbox allow-scripts') || !csp.includes("frame-ancestors 'self'")) throw new Error('frame CSP weakened');
  });

  await t('all documents, including landing docs, use the same React shell response', async () => {
    const start = worker.indexOf('async function serveDocVersion(');
    const block = worker.slice(start, worker.indexOf('async function landingResponse', start));
    if (!block.includes('const render = shellDocumentWorker;')) throw new Error('unified render path missing');
    if (!block.includes("'Content-Security-Policy': cspHeader(nonce)")) throw new Error('shell CSP missing');
    if (/injectOverlay/.test(block)) throw new Error('overlay render path remains');
  });

  await t('bundle is importable and registers the shell builder', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-react-shell-'));
    cp.execFileSync(process.execPath, [path.join(ROOT, 'bin/tdoc-bundle')], {
      env: { ...process.env, OUT_DIR: out },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const modulePath = path.join(out, '_worker.bundled.mjs');
    fs.copyFileSync(path.join(out, '_worker.bundled.js'), modulePath);
    await import(`file://${modulePath}`);
    if (typeof globalThis.TDOC_SHELL_BUILDER?.shellHtml !== 'function') throw new Error('builder not registered');
    fs.rmSync(out, { recursive: true, force: true });
  });

  await t('Vite manifest points to committed content-hashed assets', async () => {
    const manifest = JSON.parse(read('server/runtime/manifest.json'));
    const entry = Object.values(manifest).find((item) => item?.isEntry);
    if (!/^shell\.[\w-]+\.js$/.test(entry?.file || '')) throw new Error('hashed JS missing');
    if (!/^shell\.[\w-]+\.css$/.test(entry?.css?.[0] || '')) throw new Error('hashed CSS missing');
    for (const asset of [entry.file, entry.css[0]]) {
      if (!fs.existsSync(path.join(ROOT, 'server/runtime', asset))) throw new Error(`asset missing: ${asset}`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
