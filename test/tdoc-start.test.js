// Onboarding page (#142) and the /start route that serves it.
const fs = require('fs');
const path = require('path');
let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const meta = JSON.parse(fs.readFileSync(path.join(root, 'landing', 'tdoc-start', 'meta.json'), 'utf8'));
const latest = meta.versions[meta.versions.length - 1].n;
const html = fs.readFileSync(path.join(root, 'landing', 'tdoc-start', `v${latest}`, 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');

console.log('onboarding /start (#142)');

t('is interactive without author JavaScript', () => {
  // Published docs run under a nonce-only CSP, so every picker on this page
  // has to be CSS. A page that needed JS would look right locally and be dead
  // once shared, which is exactly the trap #138 describes.
  assert(!/<script\b/i.test(html), 'page contains a <script> tag; the CSP will not run it');
  assert(!/\son[a-z]+\s*=\s*["']/i.test(html), 'page contains an inline event handler');
  const radios = (html.match(/type="radio"/g) || []).length;
  assert(radios >= 6, `expected radio-driven pickers, found ${radios}`);
  assert(/:checked ~ \.panels/.test(html), 'pickers must be driven by :checked, not script');
});

t('teaches the loop on the real published doc', () => {
  const hrefs = [];
  const re = /\bhref="([^"]*)"/g; let m;
  while ((m = re.exec(html))) hrefs.push(m[1]);
  assert(hrefs.some((h) => h === 'https://tdoc.dev/d/conway-life/v/2'),
    'step 3 must link the real conway-life doc, not a mockup');
  // The comment gate is real: canCommentOnDoc returns false without a
  // session, so a walkthrough that omits sign-in walks the user into a wall.
  for (const beat of ['Fork the example', 'Sign in with GitHub', 'A new version appears']) {
    assert(html.includes(beat), `missing loop beat: ${beat}`);
  }
});

t('offers every supported runtime', () => {
  for (const r of ['Claude Code', 'Codex', 'Cursor', 'Gemini', 'Grok']) {
    assert(html.includes(r), `missing runtime: ${r}`);
  }
  assert(html.includes('/plugin marketplace add tornado-doc/tdoc'), 'missing marketplace line');
});

t('step 3 asks the host for a token, not for a doc', () => {
  // There is no server-side doc creation and there should not be: the page is
  // written by the user's agent on their machine. The web's job is to hand
  // over the hosted publish token so `publish` works with no setup.
  const js = fs.readFileSync(path.join(root, 'server', 'onboard.js'), 'utf8');
  assert(/\/api\/hosted\/token/.test(js), 'step 3 must call the real hosted-token endpoint');
  assert(!/onboard\/create/.test(js), 'no invented creation endpoint');
  assert(/hosted_registration_disabled/.test(js),
    'closed signup must be handled, not left as a generic error');
});

t('says what to say, not what to type', () => {
  // The whole premise is that you talk to the agent. A deploy command in the
  // hosting panel would contradict the page it sits on.
  const panels = html.match(/<div class="panel hp-[\s\S]*?<\/div>/g) || [];
  assert(panels.length >= 3, 'expected a panel per hosting target');
  assert(!/tdoc-publish|npx |wrangler /.test(panels.join(' ')), 'hosting panels must not contain CLI commands');
});

t('carries the SEO head', () => {
  assert(/<title>[^<]*tdoc[^<]*<\/title>/i.test(html), 'title does not mention tdoc');
  assert(/rel="canonical"/.test(html), 'missing canonical');
  assert(/property="og:title"/.test(html), 'missing og:title');
});

t('/start serves the doc and fails safe', () => {
  assert(/const START_SLUG = 'tdoc-start'/.test(worker), 'missing START_SLUG');
  assert(/if \(p === '\/start' && \(method === 'GET' \|\| method === 'HEAD'\)\) return landingResponse\(env, req, START_SLUG\)/.test(worker),
    '/start must route through landingResponse so it inherits the neutral-page fallback');
});

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail ? 1 : 0);
