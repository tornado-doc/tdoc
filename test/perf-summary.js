#!/usr/bin/env node
// The measurements test/helpers/perf-budget.js appended to $TDOC_PERF_LOG,
// as a Markdown table: printed, and added to the GitHub job summary when
// $GITHUB_STEP_SUMMARY is set. Never fails: it reports.
//
//   node test/perf-summary.js [log] [title]
const fs = require('fs');

const file = process.argv[2] || process.env.TDOC_PERF_LOG;
const title = process.argv[3] || 'Performance budgets';
let rows = [];
try {
  rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
} catch {}

const ms = (v) => (v == null ? '' : `${Number(v).toFixed(1)} ms`);
const out = [`### ${title}`, ''];
if (!rows.length) out.push('No measurements were recorded.');
else {
  const over = rows.filter((r) => !r.ok);
  const cals = rows.filter((r) => r.calibrationMs != null);
  out.push(over.length
    ? `**${over.length} of ${rows.length} over budget.** ${over.some((r) => r.kind === 'guard') ? 'A complexity guard failed its test.' : 'Performance budgets only: reported, not failing the build.'}`
    : `All ${rows.length} within budget.`);
  if (cals.length) {
    const lo = Math.min(...cals.map((r) => r.calibrationMs)), hi = Math.max(...cals.map((r) => r.calibrationMs));
    out.push('', `Runner calibration ${lo === hi ? ms(lo) : `${ms(lo)} to ${ms(hi)}`} (one per test process); a guard's budget is written for a typical CI runner and only ever scaled up by it. Frame budgets scale by the browser's idle frame instead.`);
  }
  out.push('', '| | Check | Kind | Measured | Budget | × factor | Limit |', '|---|---|---|---:|---:|---:|---:|');
  for (const r of rows) {
    out.push(`| ${r.ok ? '✅' : r.kind === 'guard' ? '❌' : '⚠️'} | ${String(r.name).replace(/\|/g, '\\|')} | ${r.kind} | ${ms(r.ms)} | ${r.budget} ms | ${Number(r.factor).toFixed(2)} | ${ms(r.limit)} |`);
  }
}
const text = out.join('\n') + '\n';
process.stdout.write(text);
if (process.env.GITHUB_STEP_SUMMARY) {
  try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n'); } catch {}
}
