// tdoc AI's face (shell/src/agent-marks.jsx TdocAiMark) is tdoc's own mark
// with the Ask AI star on a badge, not new art and not new colours:
//   - the five strokes and their transform are assets/tdoc_logo.svg's;
//   - the star is ASK_ICON_PATH, imported, not a copy;
//   - colours are currentColor, the --td-accent token and white;
//   - every author face goes through AuthorAvatar, which gives it to tdoc AI
//     and to an agent tdoc cannot name (no generic robot in Needs you), and
//     the agent picker's tdoc AI row (ProviderMark) wears the same face.
// author-face-ui.test.js and my-docs-a-ui.test.js check it in a browser.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n    ${e.message}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m); }

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const marks = read('shell/src/agent-marks.jsx');
const mark = marks.slice(marks.indexOf('export const TDOC_LOGO_PATHS'));
const logo = read('assets/tdoc_logo.svg');

console.log('tdoc AI mark');

t('the strokes are assets/tdoc_logo.svg, path for path, with its transform', () => {
  const fromLogo = [...logo.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
  const block = mark.slice(0, mark.indexOf('];'));
  const fromMark = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert(fromLogo.length === 5, `logo has ${fromLogo.length} paths`);
  assert(JSON.stringify(fromMark) === JSON.stringify(fromLogo), `${JSON.stringify(fromMark)} != ${JSON.stringify(fromLogo)}`);
  const transform = logo.match(/<g transform="([^"]+)"/)[1];
  assert(mark.includes(`TDOC_LOGO_TRANSFORM = '${transform}'`), 'transform differs from the logo');
  assert(/stroke="currentColor"/.test(mark) && /strokeLinecap="round"/.test(mark), 'drawn like the logo: currentColor, round caps');
});

t('the badge star is the Ask AI icon, imported', () => {
  assert(/import \{ ASK_ICON_PATH \} from '\.\/ui\/ask-icon\.jsx'/.test(marks), 'ASK_ICON_PATH not imported');
  assert(/d=\{ASK_ICON_PATH\}/.test(mark), 'the star is not ASK_ICON_PATH');
});

t('colours: currentColor, the accent token, white; nothing else', () => {
  const body = mark.slice(mark.indexOf('export function TdocAiMark'));
  const hexes = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0].toLowerCase());
  const allowed = new Set(['#fff', '#000', '#1652f0']); // mask white/black; the token's own default
  for (const h of hexes) assert(allowed.has(h), `colour ${h}`);
  assert(body.includes("var(--td-accent, #1652f0)"), 'badge is not --td-accent');
});

t('AuthorAvatar: tdoc AI and an agent tdoc cannot name wear it; a provider keeps its mark', () => {
  const face = read('shell/src/document/author-face.jsx');
  const fn = face.slice(face.indexOf('export function AuthorAvatar'));
  const ai = fn.indexOf('isTdocAiAuthor(author)');
  const provider = fn.indexOf("author.kind === 'agent' && author.provider)");
  assert(ai > 0 && provider > ai, 'tdoc AI is not checked before the provider mark');
  assert(/!author\.provider && !avatarFor\(author\)/.test(fn), 'an unnamed agent does not get the tdoc AI mark');
  const model = read('shell/src/document/model.js');
  const up = model.slice(model.indexOf('function upstreamAvatarFor'));
  assert(!/\n  return 'https:\/\/github\.com\/openai\.png';\n\}/.test(up), 'an unknown agent still gets the OpenAI logo');
});

t('Needs you has no generic robot; the picker\'s tdoc AI row is the same face', () => {
  const needs = read('shell/src/docs-hub/needs-you.jsx');
  assert(!/\bBot\b/.test(needs.replace(/\/\/.*$/gm, '')), 'Needs you still draws lucide Bot');
  assert(/card\.author \|\| \{ kind: 'agent' \}/.test(needs), 'an old record does not go through AuthorAvatar');
  const notify = read('shell/src/document/notify-handoff.jsx');
  assert(/target\.tdoc_ai\) return <TdocAiMark/.test(notify), 'ProviderMark tdoc AI is not TdocAiMark');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
