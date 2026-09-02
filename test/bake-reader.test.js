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

t('server/reader.css is the standalone reading-column template', () => {
  const css = fs.readFileSync(path.join(ROOT, 'server', 'reader.css'), 'utf8');
  if (!css || css.length < 1000) throw new Error(`reader.css too small (${css.length})`);
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

  t('the baked block records which template generation it is', () => {
    // Each document freezes the template it was created with, so the
    // generation has to be readable from the document rather than inferred by
    // diffing rendered type sizes across documents.
    const out = fs.readFileSync(path.join(tmp, 'tdocs', 'bake-a', 'v1', 'index.html'), 'utf8');
    if (!/id="tdoc-reader" data-tdoc-template="[0-9a-f]{8}"/.test(out)) {
      throw new Error('baked block carries no data-tdoc-template stamp');
    }
  });

  t('tdoc-bake is idempotent and reports skip', () => {
    const f = path.join(tmp, 'tdocs', 'bake-a', 'v1', 'index.html');
    const before = fs.readFileSync(f, 'utf8');
    const out = cp.execFileSync('node', [path.join(ROOT, 'bin', 'tdoc-bake'), f], { encoding: 'utf8' });
    if (!out.startsWith('skip')) throw new Error(`expected skip, got: ${out.trim()}`);
    if (fs.readFileSync(f, 'utf8') !== before) throw new Error('tdoc-bake rewrote an already-baked file');
  });

  t('tdoc-bake --scan --apply stamps a version written by hand', () => {
    // The /tdoc edit path writes v<n>/index.html directly, so a document can
    // gain a version that never went through creation-time baking.
    const dir = path.join(tmp, 'tdocs', 'bake-a', 'v2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), FIXTURE);
    cp.execFileSync('node', [path.join(ROOT, 'bin', 'tdoc-bake'), '--scan', '--apply', '--dir', path.join(tmp, 'tdocs')], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    if (!out.includes('id="tdoc-reader"')) throw new Error('--apply left a hand-written version unbaked');
  });

  t('the frame fallback no longer keys off the string "max-width"', () => {
    // A document that declares a responsive breakpoint — which the authoring
    // contract asks for — used to be read as "styles itself" and lost the
    // template entirely. Both serving paths must inject on the presence of the
    // block alone.
    for (const rel of ['server/server.js', 'worker/worker.js']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (src.includes("includes('max-width')")) {
        throw new Error(`${rel} still gates the reader template on the string "max-width"`);
      }
    }
  });

  t('/export does not stamp a second copy into an already-baked doc', () => {
    const src = fs.readFileSync(path.join(ROOT, 'worker', 'worker.js'), 'utf8');
    const fn = src.slice(src.indexOf('function injectReaderCss'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    // The guard is the shared tag-matching test (a substring check
    // false-positives on prose that quotes the id).
    if (!body.includes('hasReaderBlock(html)')) {
      throw new Error('injectReaderCss has no presence guard — downloads get two reader blocks');
    }
  });

  t('the token block is zero-specificity like the rest of the template', () => {
    // Dropping the frame's "does this document style itself" guard rests on
    // the template losing every contest with author CSS. A bare :root is
    // (0,1,0) and the block is stamped after any author <style> in head, so an
    // unwrapped token block would override an author's own --td-* values.
    const css = fs.readFileSync(path.join(ROOT, 'server', 'reader.css'), 'utf8');
    const bare = css.split('\n').filter((line) => /^\s*:root\s*[,{]/.test(line));
    if (bare.length) throw new Error(`reader.css has a bare :root (specificity 0,1,0): ${bare[0].trim()}`);
    if (!/:where\(:root\)/.test(css)) throw new Error('the token block is no longer wrapped in :where()');
  });

  t('a $ in the template survives baking literally', () => {
    // `$&`, `$\`` and `$'` are substitution patterns in a replacement string,
    // and the template is the replacement. [class$="…"] is ordinary CSS.
    const f = path.join(tmp, 'dollar.html');
    fs.writeFileSync(f, FIXTURE);
    const fake = path.join(tmp, 'fake-skill');
    fs.mkdirSync(path.join(fake, 'server'), { recursive: true });
    fs.mkdirSync(path.join(fake, 'bin'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'bin', 'tdoc-bake'), path.join(fake, 'bin', 'tdoc-bake'));
    fs.writeFileSync(path.join(fake, 'server', 'reader.css'), '[class$="x"]{color:red}/* $& $` $\' $1 */');
    cp.execFileSync('node', [path.join(fake, 'bin', 'tdoc-bake'), f], { stdio: ['ignore', 'ignore', 'pipe'] });
    const out = fs.readFileSync(f, 'utf8');
    if (!out.includes('[class$="x"]')) throw new Error('an attribute-suffix selector did not survive baking');
    if (!out.includes('$&')) throw new Error('$& was expanded instead of kept literal');
  });

  t('tdoc-write --version next adds a baked version and keeps the thread', () => {
    // The gateway exists because /tdoc edit used to write v<n>/index.html by
    // hand: no validation, no bake, and meta.json updated from prose.
    const f2 = path.join(tmp, 'gw2.html');
    fs.writeFileSync(f2, FIXTURE.replace('<h1>Bake</h1>', '<h1>Bake v2</h1>'));
    const docs = path.join(tmp, 'tdocs');
    fs.writeFileSync(path.join(docs, 'bake-a', 'comments.json'), '[{"id":"c1","text":"keep"}]');
    cp.execFileSync('bash', [path.join(ROOT, 'bin', 'tdoc-write'), '--slug', 'bake-a', '--title', 'bake-a',
      '--html-file', f2, '--version', 'next', '--no-server', '--quiet'],
      { env: { ...process.env, TDOC_DIR: docs }, stdio: ['ignore', 'ignore', 'pipe'] });

    const meta = JSON.parse(fs.readFileSync(path.join(docs, 'bake-a', 'meta.json'), 'utf8'));
    const ns = meta.versions.map((v) => v.n);
    const top = Math.max(...ns);
    const out = fs.readFileSync(path.join(docs, 'bake-a', `v${top}`, 'index.html'), 'utf8');
    if (!out.includes('id="tdoc-reader"')) throw new Error(`v${top} written without the reading template`);
    if (!out.includes('Bake v2')) throw new Error('gateway wrote the wrong HTML');
    if (!ns.includes(1)) throw new Error('gateway dropped earlier versions from meta.json');
    const comments = fs.readFileSync(path.join(docs, 'bake-a', 'comments.json'), 'utf8');
    if (!comments.includes('keep')) throw new Error('gateway reset an existing comment thread');
  });

  t('tdoc-write --version next refuses to invent a document', () => {
    const f = path.join(tmp, 'gwx.html');
    fs.writeFileSync(f, FIXTURE);
    let failed = false;
    try {
      cp.execFileSync('bash', [path.join(ROOT, 'bin', 'tdoc-write'), '--slug', 'no-such-doc', '--title', 'x',
        '--html-file', f, '--version', 'next', '--no-server', '--quiet'],
        { env: { ...process.env, TDOC_DIR: path.join(tmp, 'tdocs') }, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch { failed = true; }
    if (!failed) throw new Error('adding a version to a nonexistent doc should fail');
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
