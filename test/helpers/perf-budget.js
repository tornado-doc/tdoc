// Wall-clock budgets that mean the same thing on a laptop and on a shared CI
// runner. Two kinds, kept apart on purpose:
//
//   guard(name, ms, budget)   A complexity guard: linear work that a quadratic
//                             regression would blow past by 10-100x (a
//                             publish that hits the Worker's CPU limit). It
//                             always fails the test. The budget is written for
//                             a typical CI runner and scaled by this runner's
//                             measured speed (runnerFactor), never tightened.
//
//   budget(name, ms, budget)  A pure performance budget: a frame time, how
//                             long a sort takes in the browser. Worth watching,
//                             not worth a red build when a shared runner is
//                             busy. TDOC_PERF decides what an overrun does:
//                               enforce (default, and the CI `perf` job): the
//                                       test fails at settle() (or the
//                                       process exits 1), after every budget
//                                       in it was measured
//                               report  (the blocking CI jobs): a warning
//                                       annotation, the test goes on
//
// Every measurement is appended to $TDOC_PERF_LOG (JSON lines) when set;
// test/perf-summary.js turns that file into the job summary table.
const fs = require('fs');

// The calibration workload: a few MB of markup built, scanned by a regex,
// hashed, split into rows and round-tripped through JSON: the kind of work
// the guarded code does (string building, regex, allocation, GC).
// REFERENCE_MS is its best-of-five on a typical GitHub ubuntu-latest runner
// (52-72 ms there, Node 22; ~100 ms in the Playwright container; 150-200 ms
// on a loaded laptop that also runs the guarded code ~2.5x slower than CI),
// the machine the budgets were tuned on: a typical runner measures a factor
// of 1, a slow or busy one more.
const REFERENCE_MS = 70;
function workload() {
  const parts = [];
  for (let i = 0; i < 60000; i++) parts.push(`<tr data-row="r${i}"><td>${'x'.repeat(i % 40)}</td><td>${i * 7}</td></tr>`);
  const s = parts.join('\n');
  let n = 0;
  const re = /<tr data-row="r(\d+)"><td>([^<]*)<\/td>/g;
  for (let m = re.exec(s); m; m = re.exec(s)) n += m[2].length;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  const rows = s.split('\n').map((line, i) => ({ id: i, len: line.length, tail: line.slice(-12) }));
  const back = JSON.parse(JSON.stringify(rows));
  back.sort((a, b) => b.len - a.len || a.id - b.id);
  return n + h + back.length;
}

function bestOf(n, fn) {
  let best = Infinity;
  for (let k = 0; k < n; k++) {
    const t0 = process.hrtime.bigint();
    fn();
    best = Math.min(best, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return best;
}

let factor = null, calibrationMs = null;
// The most a budget is ever loosened. A runner measured slower than this is
// not a normal busy runner: the guards run at MAX_FACTOR and say so with a
// warning annotation, so a broken calibration can never silently waive them.
const MAX_FACTOR = 4;
function clampFactor(raw, source) {
  const f = Math.max(1, raw);
  if (f <= MAX_FACTOR) return f;
  const text = `runner factor ${raw.toFixed(2)} (${source}) is over the ${MAX_FACTOR}x cap; budgets are scaled by ${MAX_FACTOR} only`;
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=perf calibration::${text}` : `    ⚠ perf: ${text}`);
  return MAX_FACTOR;
}
// How much slower this machine is than a typical CI runner, measured now, in
// this process: 1 to MAX_FACTOR, so a fast machine never gets a tighter
// budget than the one written. TDOC_PERF_FACTOR pins it (to reproduce a CI
// number), within the same bounds.
function runnerFactor() {
  if (factor != null) return factor;
  const pinned = Number(process.env.TDOC_PERF_FACTOR);
  if (pinned > 0) return (factor = clampFactor(pinned, 'TDOC_PERF_FACTOR'));
  workload(); // warm the JIT
  calibrationMs = bestOf(5, workload);
  factor = clampFactor(calibrationMs / REFERENCE_MS, `calibration ${calibrationMs.toFixed(1)}ms vs ${REFERENCE_MS}ms`);
  return factor;
}

function mode() {
  return process.env.TDOC_PERF === 'report' ? 'report' : 'enforce';
}

function record(entry) {
  const file = process.env.TDOC_PERF_LOG;
  if (!file) return;
  try { fs.appendFileSync(file, JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n'); } catch {}
}

function fmt(ms) { return `${Number(ms).toFixed(1)}ms`; }

function guard(name, ms, budget) {
  const f = runnerFactor();
  const limit = budget * f;
  const ok = ms < limit;
  record({ kind: 'guard', name, ms, budget, factor: f, calibrationMs, limit, ok });
  if (!ok) throw new Error(`${name}: ${fmt(ms)}, over the ${fmt(limit)} guard (${budget}ms × ${f.toFixed(2)} runner factor)`);
  return ms;
}

// opts.factor: a calibration of its own (a browser's frame cadence, say)
// instead of the Node runner factor; clamped like it.
function budget(name, ms, limit, opts = {}) {
  const f = opts.factor != null ? clampFactor(opts.factor, `${name}: calibrated`) : runnerFactor();
  const scaled = limit * f;
  const ok = ms < scaled;
  const m = mode();
  record({ kind: 'budget', name, ms, budget: limit, factor: f, calibrationMs: opts.factor != null ? null : calibrationMs, limit: scaled, ok, mode: m });
  if (ok) return true;
  const text = `${name}: ${fmt(ms)}, over its ${fmt(scaled)} budget (${limit}ms × ${f.toFixed(2)} ${opts.factor != null ? 'calibrated' : 'runner'} factor)`;
  if (m === 'enforce') { overruns.push(text); return false; }
  // A GitHub annotation on the run, without failing it.
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=perf budget::${text}` : `    ⚠ perf (not failing, TDOC_PERF=report): ${text}`);
  return false;
}

// Enforced overruns are collected, so one slow frame does not hide the sort
// and search numbers after it; settle() at the end of a test fails it with
// all of them. Unsettled ones still fail the process.
const overruns = [];
function settle() {
  if (!overruns.length) return;
  const text = overruns.splice(0).join('\n');
  throw new Error(text);
}
process.on('exit', (code) => {
  if (!overruns.length) return;
  console.log(`  ✗ performance budgets over:\n    ${overruns.join('\n    ')}`);
  if (!code) process.exitCode = 1;
});

module.exports = { runnerFactor, bestOf, guard, budget, settle, REFERENCE_MS, MAX_FACTOR, workload };
