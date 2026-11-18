// The browser CI job runs in the official Playwright image instead of
// installing browsers with apt (which hung on runners). The image tag must
// match the locked playwright version, or the browsers would not match.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const locked = lock.packages['node_modules/playwright'].version;
const image = (workflow.match(/mcr\.microsoft\.com\/playwright:v([\d.]+)-/) || [])[1];

let fail = 0;
function t(name, ok, why) { console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    ${why}`}`); if (!ok) fail++; }
console.log('CI workflow');
t('browser job image matches the locked playwright version', image === locked, `image v${image} vs playwright ${locked}`);
t('browser regressions are sharded', /--shard=\$\{\{ matrix\.shard \}\}\/4/.test(workflow), 'run.js --shard missing');
// Pure performance budgets warn in the blocking browser job and are enforced
// only in the perf job, which never blocks (test/helpers/perf-budget.js).
const perfJob = (workflow.match(/\n  perf:\n([\s\S]*?)\n  [a-z-]+:\n/) || [])[1] || '';
// The step itself: its env block, up to the next step (`- `), carries it.
const browserStep = (workflow.match(/\n( +)- run: node test\/run\.js --browser[^\n]*\n((?:\1  [^\n]*\n)*)/) || [])[2] || '';
t('the browser job reports performance budgets instead of failing on them', /^\s+env:\s*$/m.test(browserStep) && /^\s+TDOC_PERF: report\s*$/m.test(browserStep), 'TDOC_PERF: report missing on the browser step');
// Job-level only: a step-level continue-on-error would turn an overrun green.
t('the perf job enforces them and cannot block a merge', /run\.js --perf/.test(perfJob) && /^    continue-on-error: true$/m.test(perfJob) && !/^ {6,}continue-on-error/m.test(perfJob), 'perf job missing, blocking, or hiding overruns');
console.log(`\n${4 - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
