const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'extensions/feedback/manifest.json'), 'utf8'));
const background = fs.readFileSync(path.join(ROOT, 'extensions/feedback/background.js'), 'utf8');
const content = fs.readFileSync(path.join(ROOT, 'extensions/feedback/content.js'), 'utf8');
const contentSource = fs.readFileSync(path.join(ROOT, 'extensions/feedback/src/content.jsx'), 'utf8');
const options = fs.readFileSync(path.join(ROOT, 'extensions/feedback/options.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server/server.js'), 'utf8');
const worker = fs.readFileSync(path.join(ROOT, 'worker/worker.js'), 'utf8');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }

t('extension is Manifest V3 and injects only on web apps', () => {
  assert.strictEqual(manifest.manifest_version, 3);
  assert(manifest.background.service_worker === 'background.js');
  assert.deepStrictEqual(manifest.content_scripts[0].matches, ['http://*/*', 'https://*/*']);
  assert(!manifest.permissions.includes('unlimitedStorage'));
});

t('plugin reuses tdoc comments, mentions, login, and remote storage', () => {
  assert(background.includes("'/api/comments'"));
  assert(background.includes('/api/mentions'));
  assert(background.includes('tdoc-feedback-signin') && background.includes('url: parsed.documentUrl'));
  assert(background.includes("credentials: 'include'"));
  assert(!background.includes('feedbackQueue') && !background.includes('captureVisibleTab'));
});

t('product probe anchors carry URL, selector, text, a11y, rect, and viewport', () => {
  for (const field of ["kind: 'product'", 'url: canonical()', 'selector: selectorFor(element)', 'accessible_name:', 'rect:', 'viewport:']) assert(contentSource.includes(field), field);
  assert(contentSource.includes("event.key !== 'Alt'") && contentSource.includes('tdoc-feedback-toggle'));
});

t('extension uses the real tdoc React comment UI and its CSS source', () => {
  assert(contentSource.includes("import { CommentCard } from '../../../shell/src/document/comment-card.jsx'"));
  assert(contentSource.includes("import { CommentComposer } from '../../../shell/src/document/comment-composer.jsx'"));
  assert(contentSource.includes("import chromeCss from '../../../server/chrome.css?inline'"));
  assert(!contentSource.includes('mentionChips') && !contentSource.includes('className="message"'));
  assert(content.includes('tdoc-feedback-root') && content.includes('tdoc-margin-comment'));
});

t('comment threads support the same create and mutation actions as tdoc', () => {
  for (const action of ['tdoc-feedback-submit', 'tdoc-feedback-reply', 'tdoc-feedback-resolve', 'tdoc-feedback-edit', 'tdoc-feedback-delete', 'tdoc-feedback-react', 'tdoc-feedback-reanchor']) {
    assert(contentSource.includes(action), action);
    assert(background.includes(action), action);
  }
  assert(background.includes('currentUser:') && background.includes('isOwner:'));
  assert(server.includes('identity,\n      is_owner:') && worker.includes('identity: { login: me'));
});

t('configured document URL parser accepts only tdoc-shaped HTTP(S) URLs', () => {
  const sandbox = { URL, URLSearchParams, fetch() {}, chrome: { action: { onClicked: { addListener() {} } }, commands: { onCommand: { addListener() {} } }, runtime: { onMessage: { addListener() {} } }, tabs: {} } };
  vm.runInNewContext(`${background}\nthis.parse = parseDocumentUrl;`, sandbox);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sandbox.parse('https://tdoc.dev/d/my-app/v/7'))), { base: 'https://tdoc.dev', slug: 'my-app', version: 7, documentUrl: 'https://tdoc.dev/d/my-app/v/7' });
  assert.strictEqual(sandbox.parse('https://tdoc.dev/me'), null);
  assert.strictEqual(sandbox.parse('file:///tmp/doc'), null);
});

t('options require a complete document URL', () => {
  assert(options.includes('/d\\/'));
  assert(options.includes('chrome.storage.sync.set'));
});

console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
