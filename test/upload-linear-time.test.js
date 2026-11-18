// Malformed markup must not make an agent publish block the Worker. Exercise
// the real upload route, including aid stamping and shell preview extraction.
const assert = require('node:assert/strict');
const { loadWorker, makeEnv, issue, req } = require('./helpers/worker-harness');
const { guard, bestOf } = require('./helpers/perf-budget');

(async () => {
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore, { PUBLIC_HOST: 'tdoc.dev' });
  const owner = await issue(worker, env, 'upload-perf');
  const upload = (slug, html) => worker.fetch(req('/api/upload', {
    method: 'POST', token: owner.token, body: { slug, version: 1, html },
  }), env, {});

  // Budget: a quadratic scan of 1.5 MB costs seconds; linear work is ~150-300 ms
  // on CI runners. 1000 ms keeps the DoS guard (quadratic is minutes); it is
  // scaled by the runner's measured speed and the best of three runs is
  // compared, so a busy runner or one GC pause does not fail it.
  // Warm route initialization and the JIT before measuring document work.
  assert.equal((await upload('warm-up', '<h1>Warm up</h1><p>Text</p>')).status, 200);

  for (const [kind, opener] of [
    ['script', '<script'],
    ['comment', '<!--'],
    ['heading', '<h1'],
  ]) {
    const html = '<section>' + opener.repeat(Math.ceil(1.5 * 1024 * 1024 / opener.length)) + '</section>';
    let elapsedMs = Infinity;
    for (let k = 0; k < 3; k++) {
      const request = req('/api/upload', {
        method: 'POST', token: owner.token, body: { slug: `linear-${kind}-${k}`, version: 1, html },
      });
      const start = process.cpuUsage();
      const response = await worker.fetch(request, env, {});
      const cpu = process.cpuUsage(start);
      elapsedMs = Math.min(elapsedMs, (cpu.user + cpu.system) / 1000);
      assert.equal(response.status, 200, `${kind} upload: ${await response.text()}`);
    }
    guard(`${kind} upload, 1.5 MB, CPU`, elapsedMs, 1000);
    console.log(`  ✓ ${kind}: 1.5 MB uploaded in ${elapsedMs.toFixed(1)} ms CPU`);
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
