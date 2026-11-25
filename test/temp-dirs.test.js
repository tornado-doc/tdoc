// What a test makes under the temp folder goes with it: done, failed, thrown,
// process.exit, Ctrl-C or a kill (helpers/temp-dirs.js), a kill of the runner
// too; every test that makes one uses the helper. tdoc-publish and tdoc-new
// leave nothing there either.
// Run with: node test/temp-dirs.test.js
require('./helpers/temp-dirs');
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
const fresh = (name) => fs.mkdtempSync(path.join(os.tmpdir(), name));
// Runs to its end; `when`: said once its output has it, what to do then.
const run = (cmd, args, { env = {}, when = null, act = () => {} } = {}) => new Promise((done) => {
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', acted = false;
  const hear = (chunk) => { out += chunk; if (when && !acted && out.includes(when)) { acted = true; act(child); } };
  child.stdout.on('data', hear);
  child.stderr.on('data', hear);
  child.on('close', (code, signal) => done({ code, signal, out }));
});

(async () => {
  console.log('temp folders');

  const make = `require('./test/helpers/temp-dirs');
    const fs = require('fs'), os = require('os'), path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
    fs.writeFileSync(path.join(dir, 'file'), 'x');
    fs.mkdirSync(path.join(dir, 'locked'));
    fs.writeFileSync(path.join(dir, 'locked', 'file'), 'x');
    fs.chmodSync(path.join(dir, 'locked'), 0);
    require('child_process').execFileSync('mkdir', [process.env.TMPDIR + '/by-a-child']);
    console.log('made');`;
  for (const [how, code, then, signal] of [
    ['done', 0, ''], ['process.exit', 3, 'process.exit(3);'], ['thrown', 1, "throw new Error('x');"], ['a rejection', 1, "Promise.reject(new Error('x'));"],
    ['Ctrl-C', 130, 'setTimeout(() => {}, 60000);', 'SIGINT'], ['a kill', 143, 'setTimeout(() => {}, 60000);', 'SIGTERM'], ['a closed terminal', 129, 'setTimeout(() => {}, 60000);', 'SIGHUP'],
  ]) {
    await t(`nothing is left: ${how}`, async () => {
      const tmp = fresh('tmp-');
      const r = await run(process.execPath, ['-e', `${make}\n${then}`], { env: { TMPDIR: tmp }, when: signal && 'made', act: (child) => child.kill(signal) });
      assert.equal(r.code, code, r.out);
      assert.ok(r.out.includes('made'), r.out);
      assert.deepEqual(fs.readdirSync(tmp), []);
    });
  }

  await t('a kill of the runner stops its suite, and nothing is left', async () => {
    const tmp = fresh('tmp-');
    const started = Date.now();
    const r = await run(process.execPath, ['test/run.js', '--shard=2/100000'], { env: { TMPDIR: tmp }, when: '===', act: (child) => setTimeout(() => child.kill('SIGTERM'), 100) });
    assert.equal(r.code, 143, r.out.slice(-300));
    assert.ok(Date.now() - started < 5000 && !r.out.includes('PASS'), r.out.slice(-300));
    for (let i = 0; i < 40 && fs.readdirSync(tmp).length; i++) await new Promise((x) => setTimeout(x, 50));
    assert.deepEqual(fs.readdirSync(tmp), []);
  });

  await t('every test that makes a temp file or folder uses the helper first', () => {
    const wrong = [];
    for (const dir of ['test', 'test/visual']) {
      for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(ROOT, dir, f), 'utf8');
        const makes = src.search(/mkdtemp|tmpdir\(\)/);
        const helper = src.search(/require\('\.\.?\/helpers\/(?:temp-dirs|fixture-server|worker-harness)(?:\.js)?'\)/);
        if (makes >= 0 && f !== 'temp-dirs.test.js' && (helper < 0 || helper > makes)) wrong.push(`${dir}/${f}`);
      }
    }
    assert.deepEqual(wrong, []);
    for (const f of ['fixture-server.js', 'worker-harness.js']) assert.match(fs.readFileSync(path.join(__dirname, 'helpers', f), 'utf8'), /^require\('\.\/temp-dirs'\);$/m);
    for (const f of fs.readdirSync(path.join(ROOT, 'bin')).filter((x) => fs.statSync(path.join(ROOT, 'bin', x)).isFile())) {
      assert.ok(!/mktemp (?:-d )?-t/.test(fs.readFileSync(path.join(ROOT, 'bin', f), 'utf8')), `bin/${f}: mktemp -t ignores TMPDIR on a Mac`);
    }
  });

  // A host that takes uploads, refuses them, or never answers.
  let mode = 'ok', asked = () => {};
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (!req.url.startsWith('/api/upload')) { res.statusCode = 404; return res.end('{}'); }
      asked();
      if (mode === 'hang') return undefined;
      res.statusCode = mode === 'ok' ? 200 : 500;
      return res.end(JSON.stringify(mode === 'ok' ? { ok: true, sha: 'x', size: 1 } : { error: 'down' }));
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  const home = fresh('home-');
  const docs = path.join(home, 'tdocs');
  fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
  fs.mkdirSync(path.join(docs, 'plan', 'v1'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({ platform: 'hosted', base, upload_token: 'token', public_host: `127.0.0.1:${server.address().port}` }));
  fs.writeFileSync(path.join(docs, 'plan', 'v1', 'index.html'), '<!doctype html><html><body><h1>Plan</h1></body></html>');
  fs.writeFileSync(path.join(docs, 'plan', 'meta.json'), JSON.stringify({ slug: 'plan', title: 'Plan', versions: [{ n: 1, created: '2026-01-01T00:00:00.000Z' }] }));
  const envFor = (tmp) => ({ HOME: home, TDOC_DIR: docs, TMPDIR: tmp, TDOC_SKIP_UPDATE_CHECK: '1', TDOC_NO_BROWSER: '1' });
  for (const [how, kill, code] of [['ok', null, 0], ['refused', null, null], ['hang', 'SIGTERM', null], ['hang', 'SIGINT', null]]) {
    await t(`tdoc-publish leaves nothing: ${kill || how}`, async () => {
      mode = how;
      const tmp = fresh('tmp-');
      let child = null, made = [];
      asked = () => { made = fs.readdirSync(tmp); if (kill) process.kill(-child.pid, kill); };
      const r = await new Promise((done) => {
        let out = '';
        child = spawn('bash', ['bin/tdoc-publish', '--visibility', 'unlisted', 'plan'], { cwd: ROOT, env: { ...process.env, ...envFor(tmp) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', (c) => { out += c; });
        child.stderr.on('data', (c) => { out += c; });
        child.on('close', (status) => done({ status, out }));
      });
      assert.ok(made.length, `the upload was not reached: ${r.out}`);
      if (code === 0) assert.equal(r.status, 0, r.out); else assert.notEqual(r.status, 0, r.out);
      assert.deepEqual(fs.readdirSync(tmp), []);
      assert.ok(!fs.readdirSync(path.join(home, '.tdoc')).some((f) => /tmp|bak/.test(f)), fs.readdirSync(path.join(home, '.tdoc')).join());
    });
  }
  server.close();

  for (const [what, args] of [['a sheet', ['--slug', 'sheet-ok', '--from-csv', 'ok.csv']], ['a file that is not one', ['--slug', 'sheet-missing', '--from-csv', 'missing.csv']], ['a slug that is refused', ['--slug', 'Not A Slug!', '--from-csv', 'ok.csv']]]) {
    await t(`tdoc-new leaves nothing: ${what}`, async () => {
      const tmp = fresh('tmp-');
      fs.writeFileSync(path.join(home, 'ok.csv'), 'a,b\n1,2\n');
      const r = await run('bash', ['bin/tdoc-new', '--quiet', '--no-server', ...args.map((a) => (a.endsWith('.csv') ? path.join(home, a) : a))], { env: envFor(tmp) });
      assert.equal(r.code === 0, args[1] === 'sheet-ok', r.out);
      assert.deepEqual(fs.readdirSync(tmp), []);
      assert.deepEqual(fs.readdirSync(docs).filter((f) => f.startsWith('.stage')), []);
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
