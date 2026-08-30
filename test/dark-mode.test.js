const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const root = path.join(__dirname, '..');
const src = [
  'shell/src/top-bar.jsx',
  'shell/src/document-shell.jsx',
  'shell/src/document/comment-card.jsx',
  'server/frame-probe.js',
  'server/chrome.css',
].map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');

console.log('React dark mode');

t('TopBar owns a stable theme button and persists the explicit choice', () => {
  assert(src.includes('id="tdoc-theme-btn"'), 'theme button missing');
  assert(src.includes("localStorage.setItem('tdoc-theme'"), 'theme persistence missing');
  assert(src.includes("localStorage.getItem('tdoc-theme')"), 'stored theme restore missing');
});

t('theme paints the shell html element and is signaled to the frame', () => {
  assert(src.includes("setAttribute('data-tdoc-theme'"), 'shell theme attribute missing');
  assert(src.includes("type: 'tdoc:theme'"), 'frame theme message missing');
  assert(src.includes('html[data-tdoc-theme="dark"]'), 'dark CSS missing');
});

t('author dark default applies only when no stored preference exists', () => {
  assert(src.includes("storedTheme || (message.defaultTheme === 'dark' ? 'dark' : 'light')"), 'stored/default precedence changed');
  assert(src.includes('data-tdoc-default-theme'), 'frame default-theme probe missing');
  assert(!src.includes('prefers-color-scheme'), 'OS theme must not override document/user choice');
});

t('dark mode remains a page invert with media and controls restored', () => {
  assert(src.includes('invert(1) hue-rotate(180deg)'), 'page invert missing');
  assert(src.includes('color-scheme: dark'), 'dark control scheme missing');
  assert(/img:not\(\[data-tdoc-dark="invert"\]\)/.test(src), 'media restore missing');
  assert(!src.includes('--td-ground: #111111'), 'parallel dark palette returned');
});

t('dark mode strengthens author anchor highlights', () => {
  assert(src.includes("dark ? 'rgba(255,214,0,.78)'"), 'dark anchor paint is not strengthened');
  assert(src.includes('tdoc-anchor-active'), 'active anchor paint missing');
  assert(src.includes("st.textContent = highlightCss(theme === 'dark')"), 'theme does not repaint frame highlights');
});

t('emoji reactions preserve color while LGTM remains text', () => {
  assert(src.includes('className="tdoc-emoji"'), 'emoji wrapper missing');
  assert(src.includes("emoji === 'LGTM' ? 'tdoc-emoji-text'"), 'LGTM text handling missing');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
