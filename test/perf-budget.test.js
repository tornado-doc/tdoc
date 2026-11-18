// test/helpers/perf-budget.js: complexity guards fail everywhere and are
// scaled (never tightened) by the runner's measured speed; performance
// budgets fail only when enforced (the CI perf job) and warn when
// TDOC_PERF=report (the blocking jobs); every measurement is logged.
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); fail++; } }
// Each case in its own process: the factor is measured once per process.
function run(code, env = {}) {
  const r = spawnSync(process.execPath, ['-e', `const P = require(${JSON.stringify(path.join(__dirname, 'helpers', 'perf-budget.js'))});\n${code}`], { env: { ...process.env, TDOC_PERF: '', TDOC_PERF_LOG: '', GITHUB_ACTIONS: '', ...env }, encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

console.log('perf budgets');
t('the runner factor is measured and never below 1; TDOC_PERF_FACTOR pins it', () => {
  const r = run('const f = P.runnerFactor(); if (!(f >= 1)) process.exit(2); console.log(f);');
  assert.equal(r.status, 0, r.out);
  assert.equal(run('if (P.runnerFactor() !== 2.5) process.exit(2);', { TDOC_PERF_FACTOR: '2.5' }).status, 0);
  assert.equal(run('if (P.runnerFactor() !== 1) process.exit(2);', { TDOC_PERF_FACTOR: '0.2' }).status, 0, 'a fast machine never tightens');
});
t('a guard passes under its scaled budget and fails over it, in any mode', () => {
  assert.equal(run("P.guard('x', 150, 100);", { TDOC_PERF_FACTOR: '2' }).status, 0, '150 < 100 × 2');
  const over = run("P.guard('x', 250, 100);", { TDOC_PERF_FACTOR: '2', TDOC_PERF: 'report' });
  assert.notEqual(over.status, 0, 'report mode does not soften a guard');
  assert.match(over.out, /x: 250\.0ms, over the 200\.0ms guard/);
});
t('a budget fails when enforced (the default), warns when reported', () => {
  assert.notEqual(run("P.budget('frame', 50, 34, { factor: 1 });").status, 0);
  const r = run("const ok = P.budget('frame', 50, 34, { factor: 1 }); if (ok !== false) process.exit(2);", { TDOC_PERF: 'report' });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /perf \(not failing/);
  const gh = run("P.budget('frame', 50, 34, { factor: 1 });", { TDOC_PERF: 'report', GITHUB_ACTIONS: 'true' });
  assert.match(gh.out, /^::warning title=perf budget::frame: 50\.0ms/m, 'an annotation on the run');
  assert.equal(run("P.budget('frame', 50, 34, { factor: 1.5 });").status, 0, 'a calibrated factor scales the budget');
});
t('every measurement goes to TDOC_PERF_LOG, and the summary reads it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-perf-'));
  const log = path.join(dir, 'perf.jsonl');
  run("P.guard('g', 1, 100); P.budget('b', 50, 34, { factor: 1 });", { TDOC_PERF_LOG: log, TDOC_PERF: 'report', TDOC_PERF_FACTOR: '1' });
  const rows = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => [r.kind, r.name, r.ok]), [['guard', 'g', true], ['budget', 'b', false]]);
  const summary = spawnSync(process.execPath, [path.join(__dirname, 'perf-summary.js'), log, 'T'], { encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: '' } });
  assert.equal(summary.status, 0);
  assert.match(summary.stdout, /1 of 2 over budget\.\*\* Performance budgets only/);
  assert.match(summary.stdout, /\| ⚠️ \| b \| budget \| 50\.0 ms \| 34 ms/);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
