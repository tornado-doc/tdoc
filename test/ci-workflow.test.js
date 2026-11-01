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
console.log(`\n${2 - fail} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
