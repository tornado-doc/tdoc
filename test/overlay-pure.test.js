// Overlay pure-function tests (partial resolution of #23).
//
// The review flagged the 2758-line overlay IIFE as having "no unit-testable
// surface". A full decomposition into ES modules + bundle change is deferred
// (high-risk: the overlay is almost all un-runnable DOM code). This test takes
// the pragmatic first step: it gives the genuinely PURE functions (string/math,
// no DOM) real unit coverage by VM-extracting them from the source — so the
// anchor-matching string core is now guarded against regression, and these
// functions become a documented, testable surface.
//
// Pure functions covered: escapeHtml, normalizeNeedle, normalizeContext,
// normalizeQuery, commonPrefixLen, commonSuffixLen, isVisibleClientRect,
// nearestClientRect, endRectOnLine.
//
// Run with: node test/overlay-pure.test.js

const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// isGithubHttpsUrl moved to server/signin.js when the two device-flow
// implementations were merged into one. Search both files for a function so
// this stays a test of behaviour rather than of file layout.
const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'overlay.js'), 'utf8')
  + '\n' + fs.readFileSync(path.join(__dirname, '..', 'server', 'signin.js'), 'utf8');
function sliceFn(name) {
  // overlay functions are indented inside the IIFE; match `function name(`
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`fn ${name} not found in overlay.js or signin.js`);
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

// isGithubHttpsUrl uses the global URL constructor; expose it in the sandbox.
const box = { URL };
vm.createContext(box);
vm.runInContext([
  'escapeHtml', 'normalizeNeedle', 'normalizeContext', 'normalizeQuery',
  'commonPrefixLen', 'commonSuffixLen', 'isGithubHttpsUrl',
  'isAnthropicCompanyMark', 'tdocLogoUrl', 'agentLogoUrl', 'childrenOf',
  'inboxTargetUrl', 'findCommentRoot',
  'isVisibleClientRect', 'nearestClientRect', 'endRectOnLine',
].map(sliceFn).join('\n\n'), box);
const { escapeHtml, normalizeNeedle, normalizeContext, normalizeQuery,
        commonPrefixLen, commonSuffixLen, isGithubHttpsUrl, agentLogoUrl,
        childrenOf, inboxTargetUrl, findCommentRoot,
        isVisibleClientRect, nearestClientRect, endRectOnLine } = box;

console.log('overlay-pure (#23 testable surface)');

// escapeHtml — the overlay renders comment text/author via innerHTML, so this
// is the XSS-relevant escaper.
t('escapeHtml encodes all five dangerous characters', () => {
  assert(escapeHtml(`<a href="x" onclick='y'>&`) === '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;');
});
t('escapeHtml coerces non-strings without throwing', () => {
  assert(escapeHtml(42) === '42');
  assert(escapeHtml(null) === 'null');
});
t('escapeHtml leaves safe text untouched', () => {
  assert(escapeHtml('hello world 123') === 'hello world 123');
});

// normalize* — used by text-anchor matching; whitespace collapsing must be
// consistent or anchors drift.
t('normalizeNeedle collapses internal whitespace and trims', () => {
  assert(normalizeNeedle('  a   b\n\tc  ') === 'a b c');
  assert(normalizeNeedle('') === '');
  assert(normalizeNeedle(null) === '');
});
t('normalizeContext collapses whitespace but does NOT trim (preserves edges)', () => {
  assert(normalizeContext('  a  b  ') === ' a b ');
  assert(normalizeContext(null) === '');
});
t('normalizeQuery aliases normalizeNeedle', () => {
  assert(normalizeQuery('  x   y  ') === normalizeNeedle('  x   y  '));
});

// common prefix/suffix — used by the fuzzy re-anchor fallback.
t('commonPrefixLen counts the shared leading run', () => {
  assert(commonPrefixLen('abcXYZ', 'abcDEF') === 3);
  assert(commonPrefixLen('', 'abc') === 0);
  assert(commonPrefixLen('same', 'same') === 4);
});
t('commonSuffixLen counts the shared trailing run', () => {
  assert(commonSuffixLen('XYZabc', 'DEFabc') === 3);
  assert(commonSuffixLen('abc', '') === 0);
  assert(commonSuffixLen('tail', 'tail') === 4);
});
t('prefix/suffix handle no-overlap', () => {
  assert(commonPrefixLen('abc', 'xyz') === 0);
  assert(commonSuffixLen('abc', 'xyz') === 0);
});

// isGithubHttpsUrl — audit fix: startDeviceFlow only window.open()s the
// verification URL if it's an https github.com URL, never an arbitrary string.
t('isGithubHttpsUrl accepts https github.com URLs', () => {
  assert(isGithubHttpsUrl('https://github.com/login/device') === true);
  assert(isGithubHttpsUrl('https://github.com') === true);
});
t('isGithubHttpsUrl rejects non-github / non-https / junk', () => {
  assert(isGithubHttpsUrl('http://github.com/login/device') === false, 'http rejected');
  assert(isGithubHttpsUrl('https://evil.com/login') === false, 'other host rejected');
  assert(isGithubHttpsUrl('https://github.com.evil.com') === false, 'suffix-spoof rejected');
  assert(isGithubHttpsUrl('javascript:alert(1)') === false, 'js scheme rejected');
  assert(isGithubHttpsUrl('not a url') === false, 'garbage rejected');
  assert(isGithubHttpsUrl(null) === false, 'null rejected');
});

t('agentLogoUrl maps grok/claude/codex/cursor/gemini logins to product marks', () => {
  assert(agentLogoUrl({ login: 'grok' }).includes('xai-org'), 'grok');
  assert(agentLogoUrl({ login: 'claude-code' }).includes('claude'), 'claude');
  assert(!agentLogoUrl({ login: 'claude' }).includes('anthropic'), 'claude is not the company mark');
  assert(agentLogoUrl({ login: 'codex' }).includes('openai'), 'codex');
  assert(agentLogoUrl({ login: 'cursor' }).includes('cursor'), 'cursor');
  assert(agentLogoUrl({ login: 'gemini' }).includes('gemini'), 'gemini');
  assert(agentLogoUrl({ login: 'tdoc-agent' }).includes('tdoc_logo.svg'), 'tdoc logo');
  assert(agentLogoUrl({ login: 'mystery-bot' }).includes('tdoc_logo.svg'), 'unmatched uses tdoc logo');
  assert(!String(agentLogoUrl({ login: 'tdoc-agent' })).includes('⚡'), 'no lightning');
});
t('agentLogoUrl prefers an explicit https avatar_url', () => {
  assert(agentLogoUrl({ login: 'grok', avatar_url: 'https://example.com/me.png' }) === 'https://example.com/me.png');
});
t('agentLogoUrl never shows the Anthropic company AI mark for Claude', () => {
  const star = 'https://cdn.simpleicons.org/claude/d97757';
  const company = 'https://github.com/anthropics.png';
  assert(agentLogoUrl({ login: 'claude', avatar_url: company }) === star, 'stored company mark ignored');
  assert(agentLogoUrl({ login: 'claude-code', avatar_url: company }) === star, 'claude-code');
  assert(agentLogoUrl({ login: 'tdoc-agent', avatar_url: company }) === star, 'orphan company mark remapped');
  assert(!String(agentLogoUrl({ login: 'claude' }) || '').includes('anthropics'), 'mapped url is not anthropics');
});
t('childrenOf nests replies under their immediate parent', () => {
  const replies = [
    { id: 'r1', parent_id: 'c1' },
    { id: 'r2', parent_id: 'r1' },
    { id: 'r3', parent_id: 'c1' },
  ];
  assert(childrenOf(replies, 'c1', 'c1').map(r => r.id).join() === 'r1,r3', 'tops');
  assert(childrenOf(replies, 'r1', 'c1').map(r => r.id).join() === 'r2', 'nested');
  assert(childrenOf(replies, 'r2', 'c1').length === 0, 'leaf');
});

t('inboxTargetUrl builds /d/<slug>/v/<n>?comment=<id>', () => {
  assert(inboxTargetUrl(
    { slug: 'conway-life', version: 3, comment_id: 'c_1' },
    { slug: 'other', version: 1 }
  ) === '/d/conway-life/v/3?comment=c_1');
});
t('inboxTargetUrl falls back to the current doc when the row has no slug', () => {
  assert(inboxTargetUrl(
    { comment_id: 'r_9', thread_id: 'c_1' },
    { slug: 'sample-doc', version: 2 }
  ) === '/d/sample-doc/v/2?comment=r_9');
});
t('inboxTargetUrl never emits /d/undefined', () => {
  assert(inboxTargetUrl({}, {}) === '');
  assert(inboxTargetUrl({ comment_id: 'c_1' }, { version: 1 }) === '');
  assert(inboxTargetUrl(null, null) === '');
});
t('inboxTargetUrl encodes slug and comment id', () => {
  assert(inboxTargetUrl(
    { slug: 'a b', version: 1, comment_id: 'c 1' },
    {}
  ) === '/d/a%20b/v/1?comment=c%201');
});
t('inboxTargetUrl treats bad versions as 1', () => {
  assert(inboxTargetUrl({ slug: 'd', version: 'nope', comment_id: 'c' }, {}) === '/d/d/v/1?comment=c');
  assert(inboxTargetUrl({ slug: 'd', version: 0 }, {}) === '/d/d/v/1');
});
t('isVisibleClientRect rejects empty / missing boxes', () => {
  assert(isVisibleClientRect(null) === false);
  assert(isVisibleClientRect({ width: 0, height: 0 }) === false);
  assert(isVisibleClientRect({ width: 12, height: 0 }) === true);
  assert(isVisibleClientRect({ width: 0, height: 16 }) === true);
});
t('endRectOnLine sits at the caret X, not the line origin', () => {
  const line = { left: 40, right: 400, top: 120, bottom: 140, width: 360, height: 20 };
  const end = endRectOnLine(line, 280);
  assert(end.left === 280 && end.right === 280, 'x is the caret, not line.left');
  assert(end.top === 120 && end.bottom === 140, 'stays on the same line');
  assert(endRectOnLine(line).left === 400, 'no x → line end');
  assert(endRectOnLine(null) === null);
});
t('nearestClientRect picks the line box under the caret, not the union', () => {
  const line1 = { left: 40, right: 400, top: 100, bottom: 120, width: 360, height: 20 };
  const line2 = { left: 40, right: 180, top: 120, bottom: 140, width: 140, height: 20 };
  const empty = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
  const hit = nearestClientRect([line1, empty, line2], 170, 132);
  assert(hit === line2, 'caret on the second line should not snap to line 1');
  const up = nearestClientRect([line1, line2], 80, 108);
  assert(up === line1, 'upward selection caret stays on the first line');
  assert(nearestClientRect([], 0, 0) === null);
});
t('findCommentRoot maps a reply id to its top-level card', () => {
  const list = [
    { id: 'c1', replies: [{ id: 'r1' }, { id: 'r2' }] },
    { id: 'c2', replies: [] },
  ];
  assert(findCommentRoot(list, 'c1') === 'c1');
  assert(findCommentRoot(list, 'r2') === 'c1');
  assert(findCommentRoot(list, 'c2') === 'c2');
  assert(findCommentRoot(list, 'missing') === 'missing');
  assert(findCommentRoot(list, '') === null);
  assert(findCommentRoot(null, 'c1') === 'c1');
});

// --- dark-default hint + copy primitive (source guards; live behavior in ui.test.js) ---
// These features are DOM/clipboard-bound so they can't run pure here; guard the
// wiring at the source so an accidental removal or the flashCopied() name
// collision (two same-named fns → last wins) can't slip back in unnoticed.
t('readStoredTheme honors data-tdoc-default-theme, stored pref still wins', () => {
  const fn = sliceFn('readStoredTheme');
  assert(/getItem\(THEME_KEY\)/.test(fn), 'a stored tdoc-theme must be read first');
  assert(/data-tdoc-default-theme/.test(fn), 'must fall back to the doc-declared default theme');
});
t('overlay exposes a data-tdoc-copy click-to-copy primitive', () => {
  assert(/function wireCopyTriggers\(/.test(src), 'wireCopyTriggers must be defined');
  assert(/\n\s*wireCopyTriggers\(\);/.test(src), 'wireCopyTriggers must be called on bar mount');
  const body = sliceFn('wireCopyTriggers');
  assert(/\[data-tdoc-copy\]/.test(body), 'delegated handler targets [data-tdoc-copy]');
  assert(/writeText/.test(body), 'copy uses navigator.clipboard.writeText');
  assert(/,\s*true\s*\)/.test(body), 'listener is capture-phase (beats artifact/comment handlers)');
});
t('copy primitives use distinctly named flash helpers (no flashCopied collision)', () => {
  assert(/function flashCopyTrigger\(/.test(src), 'flashCopyTrigger must exist');
  // Copy-as-Markdown moved into the ⋯ menu and now confirms with a toast, so the
  // old bar-button flashCopied helper is gone — there must be none left to collide.
  const n = (src.match(/function flashCopied\(/g) || []).length;
  assert(n === 0, `flashCopied should be gone (toast now), found ${n}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
