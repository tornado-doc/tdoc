// Exercise the installed skill, not a developer checkout with dependencies.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-browser-free-'));
const skill = path.join(temp, 'skill');
const docs = path.join(temp, 'docs');
const violations = path.join(temp, 'browser-attempts');
const children = new Set();
let uploadServer;
const uploads = [];

function run(name, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [path.join(skill, 'bin', name), ...args], { env });
    children.add(child);
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('error', reject);
    child.on('close', code => {
      clearTimeout(timer); children.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

// Tripwires catch even an attempted browser check that is swallowed by a
// "soft skip". An empty browser cache alone would miss that regression.
const guard = path.join(temp, 'guard.cjs');
fs.writeFileSync(guard, `
const fs = require('fs'), Module = require('module');
const load = Module._load;
function reject(value) {
  fs.appendFileSync(process.env.TDOC_TEST_VIOLATIONS, value + '\\n');
  throw new Error('Browser dependency reached the user flow: ' + value);
}
if (/check-layout/.test(process.argv[1] || '')) reject(process.argv[1]);
Module._load = function(id, ...args) {
  if (/playwright|puppeteer/.test(id)) reject(id);
  return load.call(this, id, ...args);
};
`);
const fakeBin = path.join(temp, 'bin');
fs.mkdirSync(fakeBin);
for (const name of ['npm', 'npx', 'playwright', 'chromium', 'chrome']) {
  fs.writeFileSync(path.join(fakeBin, name), '#!/bin/sh\nprintf "%s\\n" "$0" >> "$TDOC_TEST_VIOLATIONS"\nexit 97\n', { mode: 0o755 });
}
const env = {
  ...process.env, HOME: temp, SKILL_DIR: skill, TDOC_DIR: docs,
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`, NODE_PATH: '',
  NODE_OPTIONS: `--require=${guard}`, TDOC_TEST_VIOLATIONS: violations,
  PLAYWRIGHT_BROWSERS_PATH: path.join(temp, 'empty-browser-cache'),
  TDOC_LAYOUT_REQUIRE: '1', // retired switches cannot re-enable the dependency
  TDOC_SKIP_UPDATE_CHECK: '1', TDOC_MOCK_UPDATE_BEHIND: '0', TDOC_PLATFORM: 'hosted',
  TDOC_CONFIG_FILE: path.join(temp, '.tdoc', 'published.json'),
};

(async () => {
  try {
    for (const entry of ['bin', 'server', 'shared', 'assets']) {
      fs.cpSync(path.join(root, entry), path.join(skill, entry), { recursive: true });
    }
    assert(!fs.existsSync(path.join(skill, 'node_modules')));
    assert(!fs.existsSync(path.join(skill, 'bin', 'tdoc-check-layout')));
    const sourcePaths = ['bin', 'SKILL.md', 'skills/tdoc/SKILL.md', 'ONBOARDING.md', 'FIRST-DOC.md', 'authoring'];
    function audit(file) {
      if (fs.statSync(file).isDirectory()) return fs.readdirSync(file).forEach(n => audit(path.join(file, n)));
      assert(!/playwright|chromium|tdoc-check-layout|layout_browser|TDOC_LAYOUT_REQUIRE/i.test(fs.readFileSync(file, 'utf8')), `browser requirement in ${file}`);
    }
    sourcePaths.forEach(p => audit(path.join(root, p)));

    let result = await run('tdoc-doctor', ['--json']);
    assert.equal(result.code, 0, result.stderr);
    const health = JSON.parse(result.stdout);
    assert.equal(health.ready_to_publish, true);
    assert(!('layout_browser' in health.deps));
    assert(!health.missing_steps.some(s => /browser|npm|npx/i.test(JSON.stringify(s))));
    console.log('  ✓ clean skill doctor requires no browser installation');

    const input = path.join(temp, 'input.html');
    const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:white}</style></head><body><div class="wrap"><h1>Browser-free document</h1><p>Keep my content.</p></div></body></html>';
    fs.writeFileSync(input, html);
    const args = ['--slug', 'sample', '--title', 'Sample', '--no-server', '--quiet', '--html-file', input];
    result = await run('tdoc-write', args);
    assert.equal(result.code, 0, result.stderr);
    const doc = path.join(docs, 'sample');
    const comments = '[{"id":"keep","text":"Preserve this comment"}]';
    fs.writeFileSync(path.join(doc, 'comments.json'), comments);
    const before = ['v1/index.html', 'meta.json', 'comments.json'].map(f => fs.readFileSync(path.join(doc, f), 'utf8'));
    assert(before[0].includes('id="tdoc-reader"'));
    fs.writeFileSync(input, html.replace('</body>', '<footer>Not allowed</footer></body>'));
    for (const flags of [['--force'], ['--version', 'next']]) {
      result = await run('tdoc-write', [...args, ...flags]);
      assert.notEqual(result.code, 0);
      assert.deepEqual(['v1/index.html', 'meta.json', 'comments.json'].map(f => fs.readFileSync(path.join(doc, f), 'utf8')), before);
      assert(!fs.existsSync(path.join(doc, 'v2')));
    }
    fs.writeFileSync(input, html.replace('Keep my content.', 'Updated content.'));
    result = await run('tdoc-write', [...args, '--version', 'next']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(fs.readFileSync(path.join(doc, 'comments.json'), 'utf8'), comments);
    assert.equal(fs.readFileSync(path.join(doc, 'v1/index.html'), 'utf8'), before[0]);
    const baked = fs.readFileSync(path.join(doc, 'v2/index.html'), 'utf8');
    assert(baked.includes('Updated content.'));
    console.log('  ✓ create/edit bake templates; static rejection preserves versions and comments');

    uploadServer = http.createServer((req, res) => {
      let body = '';
      req.on('data', d => { body += d; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/upload') {
          assert.equal(req.headers.authorization, 'Bearer test-token');
          const data = JSON.parse(body); uploads.push(data);
          res.end(JSON.stringify({ ok: true, slug: data.slug, version: data.version, size: 42 }));
        } else { res.statusCode = 404; res.end('{}'); }
      });
    });
    await new Promise(r => uploadServer.listen(0, '127.0.0.1', r));
    fs.mkdirSync(path.join(temp, '.tdoc'), { recursive: true });
    fs.writeFileSync(env.TDOC_CONFIG_FILE, JSON.stringify({ platform: 'hosted',
      base: `http://127.0.0.1:${uploadServer.address().port}`, public_host: '127.0.0.1', upload_token: 'test-token' }));
    result = await run('tdoc-publish', ['--visibility', 'private', '--history', 'owner', 'sample']);
    assert.equal(result.code, 0, result.stderr);
    assert(result.stdout.includes('Published:'));
    const latest = uploads.find(u => Number(u.version) === 2);
    assert(latest, 'latest version must reach the upload endpoint');
    assert.equal(latest.html, baked);
    assert.equal(latest.meta.access.visibility, 'private');
    assert.equal(latest.meta.access.history_visibility, 'owner');
    assert(!/layout check|playwright|chromium/i.test(result.stderr));
    console.log('  ✓ actual publish CLI uploads exact HTML and private access to an isolated HTTP endpoint');

    // Serve the shipped runtime with no developer dependencies installed.
    const portServer = http.createServer();
    await new Promise(r => portServer.listen(0, '127.0.0.1', r));
    const port = portServer.address().port;
    await new Promise(r => portServer.close(r));
    const preview = spawn(process.execPath, [path.join(skill, 'server/server.js')], {
      env: { ...env, TDOC_PORT: String(port) }, stdio: 'ignore',
    });
    children.add(preview);
    let response;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { response = await fetch(`http://127.0.0.1:${port}/d/sample/v/2`); if (response.ok) break; } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert(response?.ok, 'shipped preview server must start without node_modules');
    assert((await response.text()).includes('Sample'));
    assert(!fs.existsSync(violations), fs.existsSync(violations) ? fs.readFileSync(violations, 'utf8') : '');
    console.log('  ✓ local preview works; no browser import, checker launch or installer was attempted');
  } finally {
    for (const child of children) child.kill('SIGTERM');
    if (uploadServer) await new Promise(r => uploadServer.close(r));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
