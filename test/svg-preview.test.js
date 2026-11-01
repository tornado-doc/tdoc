const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const cli = path.join(root, 'bin/tdoc-preview-svg');
const latin = path.join(__dirname, 'fixtures/svg-preview/latin.ttf');
const cjk = path.join(__dirname, 'fixtures/svg-preview/cjk.ttf');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-svg-preview-test-'));
let n = 0;
function svg(text) { return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="50"><text x="10" y="30" font-family="Preview Latin" font-size="20">${text}</text></svg>`; }
function run(source, fonts = [latin], flags = [], executable = cli) {
  const file = path.join(dir, `${++n}.svg`), out = path.join(dir, `out-${n}`);
  fs.writeFileSync(file, source);
  const before = fs.readFileSync(file);
  const result = spawnSync(process.execPath, [executable, file, '--out', out, ...fonts.flatMap(f => ['--font', f]), ...flags], {
    encoding: 'utf8', env: { ...process.env, RUST_LOG: 'off', NODE_PATH: '' }, timeout: 10000,
  });
  assert.deepEqual(fs.readFileSync(file), before, 'source SVG must not change');
  assert(!fs.readdirSync(dir).some(f => f.startsWith('.tdoc-svg-')), 'staging must be cleaned');
  assert.ifError(result.error);
  return { ...result, json: JSON.parse(result.stdout), out };
}
function failed(r, code) {
  assert.equal(r.status, 1, r.stdout);
  assert.equal(r.json.status, 'error');
  assert.equal(r.json.code, code, r.stdout);
  assert(!fs.existsSync(r.out), 'failed renders must not leave accepted PNGs');
}
try {
  let r = run(svg('A'));
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.status, 'preview_ready');
  assert.equal(r.json.reviewRequired, true);
  assert.equal(r.json.images.length, 2);
  for (const [i, width] of [343, 672].entries()) {
    const png = fs.readFileSync(r.json.images[i]);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), width);
  }
  console.log('✓ covered Latin text produces real PNGs at both requested widths; visual review is still required');

  r = run(svg('A').replace(' xmlns="http://www.w3.org/2000/svg"', ''));
  assert.equal(r.status, 0, r.stdout);

  r = run(svg('A中文'));
  failed(r, 'missing_glyphs');
  assert.deepEqual(r.json.missingGlyphs.map(g => g.codePoint).sort(), ['U+4E2D', 'U+6587']);
  console.log('✓ missing Chinese glyphs fail even when the renderer itself succeeds and RUST_LOG=off');

  r = run(svg('A中文'), [latin, cjk]);
  assert.equal(r.status, 0, r.stdout);
  assert(r.json.warnings.some(w => w.includes('Fallback from Preview Latin to Preview CJK')));
  console.log('✓ a supplied CJK fallback font restores success without scanning system fonts');

  r = run(svg('A&#x4E2D;'));
  failed(r, 'missing_glyphs');
  assert.equal(r.json.missingGlyphs[0].character, '中');
  failed(run(svg('A𠮷'), [latin, cjk]), 'missing_glyphs');
  console.log('✓ numeric XML entities and uncovered supplementary-plane characters cannot bypass coverage checks');

  failed(run(svg('A'), []), 'usage');
  const badFont = path.join(dir, 'broken.ttf'); fs.writeFileSync(badFont, 'not a font');
  failed(run(svg('A'), [badFont]), 'render_warning');
  failed(run(svg('A'), [latin, badFont]), 'render_warning');
  failed(run('<svg broken'), 'render_failed');
  failed(run(svg('A'), [latin], ['--widths', '0,9999']), 'usage');
  failed(run(svg('A').replace('height="50"', 'height="5000000"')), 'render_failed');
  console.log('✓ missing/corrupt fonts, malformed SVG and excessive raster sizes fail without accepted output');

  r = run(svg('A'), [latin], ['--widths', '375,375']);
  assert.equal(r.status, 0, r.stdout); assert.equal(r.json.images.length, 1);
  const existing = path.join(dir, 'existing'); fs.mkdirSync(existing); fs.writeFileSync(path.join(existing, 'keep'), 'keep');
  r = run(svg('A中文'), [latin], ['--out', existing]);
  assert.equal(r.json.code, 'output_exists'); assert.equal(fs.readFileSync(path.join(existing, 'keep'), 'utf8'), 'keep');
  console.log('✓ duplicate widths are deduplicated and existing output directories are preserved');

  const clean = path.join(dir, 'clean'); fs.mkdirSync(path.join(clean, 'bin'), { recursive: true });
  fs.copyFileSync(cli, path.join(clean, 'bin/tdoc-preview-svg'));
  r = run(svg('A'), [latin], [], path.join(clean, 'bin/tdoc-preview-svg'));
  failed(r, 'dependency_missing');
  assert(r.json.message.includes('npm ci --prefix'));
  console.log('✓ a clean skill returns an explicit, isolated setup command without installing anything');
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
