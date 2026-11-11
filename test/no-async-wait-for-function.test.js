// Source rule for browser tests: no page.waitForFunction with an async
// predicate. Playwright checks that the returned Promise is truthy, not what
// it resolves to, so such a wait passes after one evaluation and the next line
// races the thing it meant to wait for (the "Comment on this page" flake on
// #997 and #1001). Poll the condition in a loop instead.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const bad = /\.waitForFunction\(\s*async\b/;
const hits = [];
for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
  if (name === path.basename(__filename)) continue;
  fs.readFileSync(path.join(dir, name), 'utf8').split('\n').forEach((line, i) => {
    if (bad.test(line)) hits.push(`test/${name}:${i + 1}`);
  });
}
assert.deepEqual(hits, [], `waitForFunction with an async predicate never waits; poll instead:\n  ${hits.join('\n  ')}`);
console.log('no async waitForFunction predicates in test/');
