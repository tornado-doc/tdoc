// "Quick send to" (shell/src/document/send-to-app.js): the shell builds the
// app link from its own list; a page can only name an app. The browser half
// (homepage only, never another document) is in connect-ai-apps-ui.test.js.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

(async () => {
  console.log('send to app');
  const { SEND_APPS, sendToAppLink } = await import('../shell/src/document/send-to-app.js');
  let failed = 0;
  const t = (name, fn) => {
    try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
  };
  const prompt = 'set up https://tdoc.dev/SKILL.md';

  t('each app gets its documented deep link with the prompt encoded', () => {
    assert.equal(sendToAppLink('codex', prompt).href, `codex://new?prompt=${encodeURIComponent(prompt)}`);
    assert.equal(sendToAppLink('cursor', prompt).href, `cursor://anysphere.cursor-deeplink/prompt?text=${encodeURIComponent(prompt)}`);
    assert.equal(sendToAppLink('claude', prompt).href, `claude://claude.ai/new?q=${encodeURIComponent(prompt)}`);
    assert.equal(sendToAppLink('claudeai', prompt).href, `https://claude.ai/new?q=${encodeURIComponent(prompt)}`);
    assert.equal(sendToAppLink('chatgpt', prompt).href, `https://chatgpt.com/?q=${encodeURIComponent(prompt)}`);
    assert.equal(sendToAppLink('codex', prompt).name, 'Codex');
  });

  t('only the listed apps: no URLs, no inherited keys', () => {
    for (const app of ['javascript:alert(1)', 'https://evil.example', 'toString', '__proto__', '', undefined]) {
      assert.equal(sendToAppLink(app, prompt), null, String(app));
    }
    assert.deepEqual(Object.keys(SEND_APPS).sort(), ['chatgpt', 'claude', 'claudeai', 'codex', 'cursor']);
  });

  t('the prompt cannot break out of its parameter', () => {
    const href = sendToAppLink('codex', 'a&b=c#d').href;
    assert.equal(href, 'codex://new?prompt=a%26b%3Dc%23d');
  });

  t('an empty or very long prompt is refused', () => {
    assert.equal(sendToAppLink('codex', '   '), null);
    assert.equal(sendToAppLink('codex', 'x'.repeat(501)), null);
    assert.equal(sendToAppLink('codex', 42), null);
  });

  t('the shell asks only on tdoc site pages, and the probe sends a name, not a URL', () => {
    const shell = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'document-shell.jsx'), 'utf8');
    assert.match(shell, /'tdoc:sendToApp': \(message\) => \{\n\s+if \(!config\.isLanding\) return;/);
    const probe = fs.readFileSync(path.join(__dirname, '..', 'server', 'frame-probe.js'), 'utf8');
    assert.match(probe, /post\(\{ type: 'tdoc:sendToApp', app: trigger\.getAttribute\('data-tdoc-send'\) \|\| '', text: text \}\)/);
  });

  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
  console.log('\nall passed');
})();
