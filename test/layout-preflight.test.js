// Actual Raft failure: fitting the page does not imply readable columns or SVG.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
require('./helpers/pin-browser-cache');
const { checkLayout } = require('../bin/tdoc-check-layout');
const root = path.join(__dirname, '..');
const bad = path.join(__dirname, 'fixtures/raft-layout-regression.html');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-layout-gate-'));
const run = (name, args, env = {}) => spawnSync('bash', [path.join(root, 'bin', name), ...args], {
  encoding: 'utf8', timeout: 60000,
  env: { ...process.env, HOME: temp, TDOC_DIR: path.join(temp, 'docs'), TDOC_MOCK_UPDATE_BEHIND: '0', ...env },
});

(async () => {
  try {
    const reports = await checkLayout(bad);
    assert.equal(reports.length, 6);
    const narrow = reports.find(r => r.width === 1440 && r.mode === 'narrow');
    const wide = reports.find(r => r.width === 1440 && r.mode === 'wide');
    assert(narrow.errors.some(e => e.includes('compressed table column')));
    assert(narrow.errors.some(e => e.includes('small rendered text')));
    assert(wide.errors.some(e => e.includes('outside SVG')));
    assert(!wide.errors.some(e => e.includes('compressed table column')));
    console.log('  ✓ original Raft table/SVG fail; wider page alone leaves the bad label');

    const good = path.join(temp, 'good.html');
    fs.writeFileSync(good, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:white}</style></head><body><div class="wrap"><h1>Existing document</h1><p>Keep my content.</p></div></body></html>');
    const baseArgs = ['--slug', 'sample', '--title', 'Sample', '--no-server', '--quiet'];
    let result = run('tdoc-write', [...baseArgs, '--html-file', good]);
    assert.equal(result.status, 0, result.stderr);
    const dir = path.join(temp, 'docs/sample');
    fs.writeFileSync(path.join(dir, 'comments.json'), '[{"id":"keep"}]');
    const before = ['v1/index.html', 'meta.json', 'comments.json'].map(f => fs.readFileSync(path.join(dir,f),'utf8'));
    for (const versionArgs of [['--force'], ['--version', 'next']]) {
      result = run('tdoc-write', [...baseArgs, '--html-file', bad, ...versionArgs]);
      assert.notEqual(result.status, 0);
      assert(result.stderr.includes('compressed table column'), result.stderr);
      assert.deepEqual(['v1/index.html', 'meta.json', 'comments.json'].map(f => fs.readFileSync(path.join(dir,f),'utf8')), before);
      assert(!fs.existsSync(path.join(dir, 'v2')));
    }
    console.log('  ✓ failed create/replace leaves the previous HTML, metadata and comments intact');

    // Even a caller that bypasses the write gateway cannot publish a broken
    // newest version through the CLI. Fail before login/network/deployment.
    fs.copyFileSync(bad, path.join(dir, 'v1/index.html'));
    result = run('tdoc-publish', ['sample']);
    assert.notEqual(result.status, 0);
    assert(result.stderr.includes('nothing uploaded'), result.stderr);
    assert(result.stderr.includes('compressed table column'), result.stderr);
    assert(!fs.existsSync(path.join(temp, '.tdoc/published.json')));
    console.log('  ✓ publishing rechecks edited bytes before any account setup or upload');

    result = run('tdoc-write', [...baseArgs, '--html-file', good, '--force'], { PLAYWRIGHT_BROWSERS_PATH: path.join(temp, 'missing-browser') });
    assert.notEqual(result.status, 0);
    assert(result.stderr.includes('rendered layout validation failed'));
    assert.equal(fs.readFileSync(path.join(dir,'v1/index.html'),'utf8'), fs.readFileSync(bad,'utf8'));
    console.log('  ✓ unavailable browser is a failure, never an unchecked success');
    result = run('tdoc-doctor', ['--json'], {
      PLAYWRIGHT_BROWSERS_PATH: path.join(temp, 'missing-browser'),
      TDOC_MOCK_NOT_PUBLISHED: '1', TDOC_SKIP_UPDATE_CHECK: '1',
    });
    assert.equal(result.status, 0, result.stderr);
    const health = JSON.parse(result.stdout);
    assert.equal(health.ready_to_publish, false);
    assert.equal(health.deps.layout_browser.ok, false);
    assert(health.missing_steps.some(step => step.id === 'layout_browser'));
    console.log('  ✓ doctor reports the missing browser and withholds ready-to-publish');
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
