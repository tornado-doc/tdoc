// Reader-template bake at creation (shell migration). The cross-origin shell
// serves author HTML in an isolated frame and injects NOTHING — so documents
// must be self-contained. bin/tdoc-new bakes the reader template (sliced from
// overlay.js's TDOC_READER_CSS markers, all :where() zero-specificity) into new
// docs as <style id="tdoc-reader">, the same id /export stamps. The validator
// exempts that block (it is tdoc's CSS, not author CSS).
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e.message || e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e); } }

const ROOT = path.join(__dirname, '..');
const SHELL = require(path.join(ROOT, 'server', 'shell.js'));
const overlaySrc = fs.readFileSync(path.join(ROOT, 'server', 'overlay.js'), 'utf8');

const FIXTURE = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>bake</title>
<style>body { background:#fff; } .note { border-left:3px solid #888; }</style>
</head><body><div class="wrap"><h1>Bake</h1><p>Prose relying on the reader template.</p></div></body></html>`;

function runNew(tmp, slug, html) {
  const f = path.join(tmp, `${slug}.html`);
  fs.writeFileSync(f, html);
  // --no-server: scaffold-only (CI has no installed skill dir and no server).
  cp.execFileSync('bash', [path.join(ROOT, 'bin', 'tdoc-new'), '--slug', slug, '--title', slug, '--html-file', f, '--no-server'], {
    env: { ...process.env, TDOC_DIR: path.join(tmp, 'tdocs') }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  return fs.readFileSync(path.join(tmp, 'tdocs', slug, 'v1', 'index.html'), 'utf8');
}

console.log('reader-template bake (tdoc-new self-contained docs)\n');

t('sliceReaderCss extracts the reading-column template from overlay.js', () => {
  const css = SHELL.sliceReaderCss(overlaySrc);
  if (!css || css.length < 1000) throw new Error(`slice too small (${css.length})`);
  if (!css.includes('max-width: 720px')) throw new Error('missing the 720px reading column');
  if (!/:where\(/.test(css)) throw new Error('template must be :where() zero-specificity');
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-bake-'));
try {
  t('tdoc-new bakes <style id="tdoc-reader"> into a new doc', () => {
    const out = runNew(tmp, 'bake-a', FIXTURE);
    const n = (out.match(/id="tdoc-reader"/g) || []).length;
    if (n !== 1) throw new Error(`expected exactly 1 tdoc-reader block, got ${n}`);
    if (!out.includes('max-width: 720px')) throw new Error('baked doc missing the reading column');
  });

  t('a doc that already carries #tdoc-reader is not double-baked', () => {
    const pre = FIXTURE.replace('</head>', '<style id="tdoc-reader">:where(body){font-size:17px;}</style></head>');
    const out = runNew(tmp, 'bake-b', pre);
    const n = (out.match(/id="tdoc-reader"/g) || []).length;
    if (n !== 1) throw new Error(`expected 1 tdoc-reader block after re-bake guard, got ${n}`);
  });

  t('the baked doc still passes tdoc-validate-template', () => {
    const f = path.join(tmp, 'tdocs', 'bake-a', 'v1', 'index.html');
    cp.execFileSync('python3', [path.join(ROOT, 'bin', 'tdoc-validate-template'), f, '--style', 'default'], { stdio: ['ignore', 'ignore', 'pipe'] });
  });

  t('the validator still rejects AUTHOR CSS that overrides reader layout', () => {
    // The exemption is scoped to id="tdoc-reader" — a plain author <style>
    // setting the root column must still fail.
    const badDoc = FIXTURE.replace('.note { border-left:3px solid #888; }', '.wrap { max-width: 400px; }');
    const f = path.join(tmp, 'bad.html');
    fs.writeFileSync(f, badDoc);
    let failed = false;
    try { cp.execFileSync('python3', [path.join(ROOT, 'bin', 'tdoc-validate-template'), f, '--style', 'default'], { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch { failed = true; }
    if (!failed) throw new Error('validator accepted an author root-layout override');
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
