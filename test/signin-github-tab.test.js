// #179: the sign-in dialog must hand GitHub off to a new tab, always.
//
// The device flow's only route to GitHub used to be a scripted
// window.open() fired after `await api('/api/auth/device/start')`. That is
// outside the click's activation window, so Safari and in-app webviews
// either swallow it — leaving a dialog whose verification URL was plain
// text with nothing to click — or open it in the current tab. Losing this
// tab loses the poll loop, and the sign-in can never finish.
//
// A native <a target="_blank"> cannot navigate the page it sits on, so the
// guard here is: the anchor exists, points at the verification URL, and the
// flow never depends on the popup landing.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'signin.js'), 'utf8');

console.log('sign-in hands GitHub to a new tab (#179)');

t('the dialog ships a real anchor to the verification URL', () => {
  assert(/<a class="tds-open"/.test(src),
    'no anchor in the dialog: a blocked popup leaves the user with nothing to click');
  assert(/href="' \+ esc\(uri\) \+ '"/.test(src),
    'the anchor must point at the verification URL the API returned');
});

t('the anchor opens a new tab and cannot move the page it sits on', () => {
  const anchor = src.match(/<a class="tds-open"[\s\S]{0,240}?>/);
  assert(anchor, 'could not isolate the anchor');
  assert(/target="_blank"/.test(anchor[0]), 'anchor must target _blank');
  assert(/rel="noopener noreferrer"/.test(anchor[0]),
    'anchor must carry noopener noreferrer: the new tab gets no handle on this one');
});

t('only an https github.com URL is ever linked or opened', () => {
  assert(/if \(isGithubHttpsUrl\(uri\)\) \{/.test(src),
    'the anchor and the popup must both sit behind isGithubHttpsUrl');
});

t('a blocked popup is handled, not assumed away', () => {
  assert(/popped = window\.open\(uri, '_blank', 'noopener'\)/.test(src),
    'the convenience popup should still be attempted');
  assert(/if \(!popped\)/.test(src),
    'a blocked popup must change the copy; the flow cannot depend on it landing');
  assert(/try \{ popped = window\.open/.test(src),
    'window.open can throw in embedded webviews; it must be guarded');
});

t('the poll keeps running whether or not the popup landed', () => {
  const after = src.slice(src.indexOf('if (isGithubHttpsUrl(uri))'));
  assert(/\(function poll\(\)/.test(after),
    'the poll must start regardless of how the user reaches GitHub');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
