// Pure helpers at the React/frame boundary.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const root = path.join(__dirname, '..');
const sources = [
  'server/frame-probe.js',
  'shell/src/document/model.js',
  'shell/src/sign-in-dialog.jsx',
  'shell/src/notifications-dialog.jsx',
  'shell/src/document-shell.jsx',
].map((file) => fs.readFileSync(path.join(root, file), 'utf8'));
const combined = sources.join('\n');

function sliceFunction(name) {
  const start = combined.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} missing`);
  let index = combined.indexOf('{', start);
  let depth = 0;
  for (; index < combined.length; index++) {
    if (combined[index] === '{') depth++;
    else if (combined[index] === '}' && --depth === 0) return combined.slice(start, index + 1);
  }
  throw new Error(`${name} is not balanced`);
}

const box = { URL };
vm.createContext(box);
vm.runInContext([
  'normalizeNeedle', 'normalizeContext', 'commonPrefixLen', 'commonSuffixLen',
  'isGitHubUrl', 'avatarFor', 'notificationTarget',
].map(sliceFunction).join('\n'), box);

console.log('React/frame pure helpers');

t('anchor normalization collapses whitespace consistently', () => {
  assert(box.normalizeNeedle('  a   b\n c ') === 'a b c');
  assert(box.normalizeContext('  a  b  ') === ' a b ');
});

t('fuzzy anchor prefix/suffix scores are stable', () => {
  assert(box.commonPrefixLen('abcX', 'abcY') === 3);
  assert(box.commonSuffixLen('Xabc', 'Yabc') === 3);
  assert(box.commonPrefixLen('a', 'b') === 0);
});

t('device flow opens only HTTPS GitHub URLs', () => {
  assert(box.isGitHubUrl('https://github.com/login/device'));
  assert(!box.isGitHubUrl('http://github.com/login/device'));
  assert(!box.isGitHubUrl('https://github.com.evil.test'));
  assert(!box.isGitHubUrl('javascript:alert(1)'));
});

t('agent avatars map to product marks without the Anthropic company avatar', () => {
  assert(box.avatarFor({ kind: 'agent', login: 'claude-code' }).includes('simpleicons.org/claude'));
  assert(box.avatarFor({ kind: 'agent', login: 'codex' }).includes('openai'));
  assert(box.avatarFor({ kind: 'agent', login: 'grok' }).includes('xai-org'));
  assert(box.avatarFor({ kind: 'agent', login: 'gemini' }).includes('googlegemini'));
});

t('notification destinations validate and encode slug/version/comment', () => {
  assert(box.notificationTarget(null) === '');
  assert(box.notificationTarget({ slug: 'a b', version: 3, comment_id: 'c 1' }) === '/d/a%20b/v/3?comment=c%201');
  assert(box.notificationTarget({ slug: 'd', version: 0 }) === '/d/d/v/1');
});

t('frame copy and theme protocols remain framework-free', () => {
  assert(combined.includes('[data-tdoc-copy]'), 'copy primitive missing');
  assert(combined.includes('tdoc:copyText'), 'copy bridge missing');
  assert(combined.includes('data-tdoc-default-theme'), 'theme hint missing');
  assert(combined.includes("message.defaultTheme === 'dark'"), 'shell theme hint handling missing');
});

t('comment navigation stays a two-way shell/frame protocol', () => {
  assert(combined.includes("type: 'tdoc:anchorClick'"), 'highlight click message missing');
  assert(combined.includes("type: 'tdoc:focusAnchor'"), 'anchor focus command missing');
  assert(combined.includes('anchorIdAtPoint'), 'highlight hit testing missing');
  assert(combined.includes('setActiveAnchor'), 'active highlight state missing');
});

t('React text rendering does not reintroduce HTML string escaping helpers', () => {
  const comments = fs.readFileSync(path.join(root, 'shell/src/document/comment-card.jsx'), 'utf8');
  assert(comments.includes('{comment.text}'), 'comment text is not rendered as React text');
  assert(!comments.includes('dangerouslySetInnerHTML'), 'comment content bypasses React escaping');
});

t('all comment mutations share the sign-in fallback', () => {
  const hook = fs.readFileSync(path.join(root, 'shell/src/hooks/use-comments.js'), 'utf8');
  assert(hook.includes('const mutate = useCallback'), 'shared mutation wrapper missing');
  assert(hook.includes('error.status === 401 && onUnauthorized'), '401 sign-in fallback missing');
  for (const operation of ['createComment', 'toggleReaction', 'removeComment', 'updateCommentAnchor']) {
    assert(hook.includes(`mutate(() => ${operation}`), `${operation} bypasses the shared mutation wrapper`);
  }
});

// A notification links to a comment, not to a position. When the anchor no
// longer resolves — the landing page republishes new content under the same
// version, so its thread orphans wholesale — there is no pin to scroll to, and
// bailing there left the link doing nothing at all: no card, no scroll, and
// `?comment=` still sitting in the URL. The floating card already knows how to
// render unanchored, so open it.
t('a deep link to an unanchored comment still opens its card', () => {
  const shell = fs.readFileSync(path.join(root, 'shell/src/document-shell.jsx'), 'utf8');
  const start = shell.indexOf('const cluster = clusters.find(');
  assert(start > 0, 'deep-link cluster lookup missing');
  const branch = shell.slice(start, start + 900);
  assert(!/if \(!cluster\) return;/.test(branch),
    'a missing cluster still aborts the deep link, so an unanchored comment is unreachable');
  const guard = branch.slice(branch.indexOf('if (!cluster)'));
  assert(/setOpenCommentId\(root\.id\)/.test(guard.slice(0, 700)),
    'an unanchored deep link must open the comment card');
  assert(/setDeepTarget\(null\)/.test(guard.slice(0, 700)),
    'an unanchored deep link must clear the pending target');
});

// The floating card is what shows an unanchored comment on desktop, and it is
// positioned without a cluster, so the card lands on screen rather than at the
// scroll offset of a pin that does not exist.
t('the floating card renders and positions without a cluster', () => {
  const layer = fs.readFileSync(path.join(root, 'shell/src/document/comment-layer.jsx'), 'utf8');
  assert(/unanchored=\{!pinIds\.has\(openComment\.id\)\}/.test(layer),
    'DesktopCommentLayer no longer marks an unanchored floating card');
  const shell = fs.readFileSync(path.join(root, 'shell/src/document-shell.jsx'), 'utf8');
  const pos = shell.slice(shell.indexOf('const cardPosition = {'), shell.indexOf('const cardPosition = {') + 500);
  assert(/openCluster\s*\n?\s*\?/.test(pos) && /:\s*(?:TOP_BAR_HEIGHT|frameTop) \+ 4/.test(pos),
    'cardPosition lost its no-cluster fallback, so an unanchored card can land off screen');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
