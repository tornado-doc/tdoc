// Worker shell-parity guard (Step 7). The offline suite can't boot a Cloudflare
// Worker, so this does two things:
//   1. Hermetic SOURCE checks on worker.js — the shell routes/CSP wiring exist
//      and haven't silently regressed (same convention as csp-headers.test.js).
//   2. A FUNCTIONAL check: run bin/tdoc-bundle, import the bundled worker as an
//      ES module, and drive the shared builders it self-registers on globalThis
//      (TDOC_CHROME.buildBar + TDOC_SHELL_BUILDER.shellHtml) to prove the
//      published shell actually renders — bar, isolated /frame iframe, and only
//      our nonced chrome scripts.
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, err) { console.log(`  ✗ ${name}\n    ${err}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e.message); } }

const ROOT = path.join(__dirname, '..');
const workerSrc = fs.readFileSync(path.join(ROOT, 'worker', 'worker.js'), 'utf8');
const bundleSrc = fs.readFileSync(path.join(ROOT, 'bin', 'tdoc-bundle'), 'utf8');

(async () => {
  console.log('worker shell parity (hermetic source + bundled-builder functional)\n');

  // ── source: bundler inlines the shell modules ──────────────────────────────
  await t('bin/tdoc-bundle inlines chrome + shell as code and chrome + probe as strings', async () => {
    for (const marker of ['/* __TDOC_CHROME_MODULE__ */', '/* __TDOC_SHELL_MODULE__ */', '__TDOC_CHROME_JS__', '__TDOC_PROBE_JS__']) {
      if (!bundleSrc.includes(marker)) throw new Error(`tdoc-bundle no longer references ${marker}`);
    }
    if (!/bundleSha = sha\(\[worker, overlay, chromeMod, shellMod, frameProbe\]/.test(bundleSrc)) {
      throw new Error('bundle_sha must cover chrome/shell/probe so drift changes the hash');
    }
  });

  await t('worker.js declares the shell placeholders + globalThis accessors', async () => {
    for (const marker of ['/* __TDOC_CHROME_MODULE__ */', '/* __TDOC_SHELL_MODULE__ */', 'const CHROME_JS = `__TDOC_CHROME_JS__`', 'const PROBE_JS = `__TDOC_PROBE_JS__`']) {
      if (!workerSrc.includes(marker)) throw new Error(`worker.js missing ${marker}`);
    }
    if (!/globalThis\.TDOC_CHROME/.test(workerSrc) || !/globalThis\.TDOC_SHELL_BUILDER/.test(workerSrc)) {
      throw new Error('worker.js must read CHROME/SHELL off globalThis (Workers ban eval)');
    }
  });

  // ── source: CSP + frame route + doc render ─────────────────────────────────
  await t('worker cspHeader adds frame-src \'self\' (shell frames only same-origin /frame)', async () => {
    const s = workerSrc.indexOf('function cspHeader(nonce)');
    const body = workerSrc.slice(s, s + 260);
    if (!body.includes("frame-src 'self'")) throw new Error(`cspHeader missing frame-src 'self': ${body}`);
  });

  await t('worker frameCspHeader sandboxes the author frame to an opaque origin', async () => {
    const s = workerSrc.indexOf('function frameCspHeader(nonce)');
    if (s < 0) throw new Error('frameCspHeader() not found');
    const body = workerSrc.slice(s, s + 240);
    if (!/\bsandbox allow-scripts\b/.test(body)) throw new Error(`frameCspHeader must set sandbox allow-scripts: ${body}`);
    if (!body.includes("frame-ancestors 'self'")) throw new Error('frameCspHeader must set frame-ancestors \'self\'');
  });

  await t('worker /frame route is Sec-Fetch-Dest gated, access-gated, probe-injected, frame-CSP\'d', async () => {
    const s = workerSrc.indexOf('const frameMatch = p.match(/^\\/d\\/([^/]+)\\/v\\/(\\d+)\\/frame');
    if (s < 0) throw new Error('/frame route not found');
    const block = workerSrc.slice(s, s + 1200);
    if (!/isWidgetFrameRequest\(req\.headers\.get\('sec-fetch-dest'\)\)/.test(block)) throw new Error('/frame must gate on Sec-Fetch-Dest: iframe');
    if (!/enforceDocAccess\(/.test(block)) throw new Error('/frame must run enforceDocAccess (same gate as the doc view)');
    if (!/\$\{PROBE_JS\}/.test(block)) throw new Error('/frame must inject the nonced probe');
    if (!/frameCspHeader\(nonce\)/.test(block)) throw new Error('/frame must set frameCspHeader');
  });

  await t('worker serveDocVersion renders the shell for docs, keeps the overlay for the homepage', async () => {
    const s = workerSrc.indexOf('async function serveDocVersion(');
    const e = workerSrc.indexOf('async function landingResponse', s);
    const block = workerSrc.slice(s, e);
    if (!/isLanding \? injectOverlay : shellDocumentWorker/.test(block)) {
      throw new Error('serveDocVersion must render shellDocumentWorker for docs and injectOverlay for isLanding');
    }
    if (!block.includes("'Content-Security-Policy': cspHeader(nonce)")) throw new Error('doc-view must keep cspHeader(nonce)');
  });

  // ── functional: bundle, import, drive the shared builders ──────────────────
  await t('bundled worker self-registers the shell builders and renders a published shell', async () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-wshell-'));
    cp.execFileSync(process.execPath, [path.join(ROOT, 'bin', 'tdoc-bundle')], {
      env: { ...process.env, OUT_DIR: outDir }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    const bundled = path.join(outDir, '_worker.bundled.js');
    const asMjs = path.join(outDir, '_worker.bundled.mjs');
    fs.copyFileSync(bundled, asMjs);
    await import('file://' + asMjs);
    const CHROME = globalThis.TDOC_CHROME, SHELL = globalThis.TDOC_SHELL_BUILDER;
    if (!CHROME || typeof CHROME.buildBar !== 'function') throw new Error('TDOC_CHROME.buildBar not registered by the bundle');
    if (!SHELL || typeof SHELL.shellHtml !== 'function') throw new Error('TDOC_SHELL_BUILDER.shellHtml not registered by the bundle');
    // Published bar carries Share (the published-mode primary CTA).
    const bar = CHROME.buildBar({ mode: 'published', slug: 'demo', version: 3, versions: [{ n: 3 }] });
    if (!/id="tdoc-share-btn"/.test(bar)) throw new Error('published bar missing Share button');
    // The shell document embeds the isolated frame + our chrome, no author HTML.
    const doc = SHELL.shellHtml({
      title: 'Demo', frameSrc: '/d/demo/v/3/frame', nonceAttr: ' nonce="abc"',
      chromeCssStr: '.tdoc-bar{}', barInner: bar, footerInner: '<i></i>',
      chromeJs: 'window.__c=1;', authCfgJson: '{"mode":"published"}', cfgJson: '{"mode":"published"}',
      signinJs: 'window.__s=1;', onboardJs: '',
    });
    if (!/class="tdoc-doc-frame"[^>]*src="\/d\/demo\/v\/3\/frame"/.test(doc)) throw new Error('shell doc missing the /frame iframe');
    if (!/<div class="tdoc-bar">/.test(doc)) throw new Error('shell doc missing the chrome bar');
    if (!doc.includes('nonce="abc"')) throw new Error('shell doc scripts must carry the nonce');
    fs.rmSync(outDir, { recursive: true, force: true });
  });

  // ── published-mode bar wiring lives in the shared shellScript ──────────────
  await t('shellScript wires the published bar (Share/Duplicate/Download/identity)', async () => {
    const shell = require(path.join(ROOT, 'server', 'shell.js'));
    const js = shell.shellScript();
    for (const needle of [
      "wire('#tdoc-share-btn'", 'function showShareModal', 'function duplicateDoc',
      'function startDownload', 'function downloadExport', 'function renderIdentity',
      "'/api/doc/duplicate'", "data-action=\"duplicate\"", "data-action=\"download-pdf\"",
      'Sign in with GitHub', '__tdocSignIn',
    ]) {
      if (!js.includes(needle)) throw new Error(`shellScript missing published wiring: ${needle}`);
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
