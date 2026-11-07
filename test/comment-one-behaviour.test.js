// The source rules behind test/comment-one-behaviour-ui.test.js: behaviour the
// comment surfaces share lives in shared code, and a surface cannot switch it
// off, forget it or grow its own copy.
// Run with: node test/comment-one-behaviour.test.js
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const SURFACES = ['shell/src/document-shell.jsx', 'shell/src/feedback-space.jsx', 'feedback/src/main.jsx'];
const CARD = 'shell/src/document/comment-card.jsx';
let failed = 0;
const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); } };

console.log('One comment card: source rules');
t('the reply prefill is the card\'s rule: no surface can pass or forget it', () => {
  for (const file of [...SURFACES, 'shell/src/document/agent-ask.jsx', CARD, 'shell/src/document/mention-field.jsx']) {
    assert.doesNotMatch(read(file), /prefillReplies/, `${file} still has a prefillReplies switch`);
  }
  // For everybody, editing agents included: no flag and no review exclusion.
  assert.match(read(CARD), /const answering = v4 \? agentForThread\(thread, ask\.choices, commentId\) : null;/, 'the tag is not agentForThread\'s rule alone');
  assert.doesNotMatch(read(CARD), /isFeatureOn|askEditV2'\)|prefillOn/, 'the card reads dev mode again');
  assert.doesNotMatch(read(CARD), /candidate|suggestsFor/, 'the review exclusion came back');
  for (const file of [...SURFACES, 'shell/src/document/agent-ask.jsx', CARD]) assert.doesNotMatch(read(file), /nothingToPublish/, `${file} has a signal nothing reads`);
  // Suggestions themselves stay dev-mode only, and the hint follows them.
  assert.match(read('shell/src/document-shell.jsx'), /suggestsFor: suggestOn \? handsBackSuggestions : null/, 'suggestions left dev mode');
  for (const file of ['shell/src/feedback-space.jsx', 'feedback/src/main.jsx']) assert.match(read(file), /fixesTheApp: true/, `${file} lost its hint`);
  // A tagged reply on a space still publishes nothing: the server refuses versions.
  const refusals = read('worker/worker.js').match(/feedbackSpaceVersionRefusal\(writeGate\.meta\)/g) || [];
  assert.ok(refusals.length >= 3, `the server refuses versions to a space on only ${refusals.length} of upload, propose_edits and the card`);
  assert.match(read('worker/worker.js'), /!\(docMeta && docMeta\.created_from === 'feedback'\)/, 'a space offers suggestions again');
});
t('every surface takes its list from useCommentArea, so a card being typed in stays put', () => {
  for (const file of SURFACES) {
    assert.match(read(file), /useCommentArea\(/, `${file} filters on its own`);
    assert.doesNotMatch(read(file), /\.filter\(\(c\) => filter === 'all'/, `${file} has its own tab filter`);
  }
  assert.match(read('shell/src/document/comment-area.js'), /hasReplyDraft/);
});
t('the reply draft is the card\'s: no surface touches it', () => {
  for (const file of SURFACES) assert.doesNotMatch(read(file), /reply-draft|ReplyDraft/, `${file} handles reply drafts`);
  assert.match(read(CARD), /readReplyDraft/);
  assert.match(read(CARD), /writeReplyDraft/);
  assert.match(read(CARD), /clearReplyDraft/);
});
t('one height and scroll rule for every agent list, in one place', () => {
  const ui = read('shell/src/ui/ui.css');
  const rule = /\.tdoc-mention-menu,\s*\.ui-menu-popup\.tdoc-agent-menu,\s*\.ui-menu-popup\.ui-combo-popup \{\s*max-height: min\((\d+)px, var\(--available-height, 100vh\)\);/.exec(ui);
  assert.ok(rule, 'the shared rule in ui.css is gone');
  assert.match(read('shell/src/document/mention-field.jsx'), new RegExp(`MENU_MAX_HEIGHT = ${rule[1]};`), 'MENU_MAX_HEIGHT is not the CSS height');
  const chrome = read('server/chrome.css');
  for (const selector of ['.tdoc-mention-menu', '.ui-menu-popup.tdoc-agent-menu']) {
    const own = chrome.split('\n').filter((line) => line.trim().startsWith(`${selector} {`));
    assert.ok(own.length, `${selector} moved`);
    for (const line of own) assert.doesNotMatch(line, /max-height|overflow/, `${selector} has its own height in chrome.css`);
  }
});
t('every menu that holds agent rows carries the list\'s class, its submenu included', () => {
  assert.match(read('shell/src/document/agent-menu.jsx'), /<AppSubmenu[^>]*popupClassName="tdoc-agent-menu"/, 'More agents has no height rule');
  for (const file of ['shell/src/document/mention-field.jsx', 'shell/src/document/ask-ai-panel.jsx']) {
    const src = read(file);
    assert.match(src, /AgentMenuItems/);
    assert.match(src, /popupClassName="tdoc-agent-menu"/, `${file}: an agent menu without the rule`);
  }
  assert.match(read('shell/src/ui/combobox.jsx'), /ui-combo-popup/);
});
t('Fix with AI stays gone; reviewing a pending suggestion stays', () => {
  for (const file of ['shell/src/document-shell.jsx', CARD, 'shell/src/document/comment-layer.jsx', 'shell/src/document/suggestions.js', 'server/chrome.css']) {
    assert.doesNotMatch(read(file), /fixWithAi|fixAll|fixable|busyIds|tdoc-fix-ai|tdoc-fix-all|Fix with AI/, `${file} still has it`);
  }
  assert.match(read(CARD), /Review suggestion/);
});
t('the floating card measures itself in the visual viewport, in the card, for every surface', () => {
  const src = read(CARD);
  assert.match(src, /window\.visualViewport/);
  assert.match(src, /tdoc-cc-body/);
  assert.match(read('server/chrome.css'), /\.tdoc-floating-open > \.tdoc-reply-form/);
  assert.doesNotMatch(read('feedback/src/main.jsx'), /tdoc-floating-open \{[^}]*max-height/, 'the widget has its own height again');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
