// `/me` is a React Docs Hub driven by structured boot data. Access policy stays
// on each document's owner-only Share dialog and never leaks into the catalog.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (error) { console.log(`  ✗ ${name}\n    ${error.message}`); fail++; } }
function assert(value, message) { if (!value) throw new Error(message); }

const root = path.join(__dirname, '..');
const worker = fs.readFileSync(path.join(root, 'worker/worker.js'), 'utf8');
// The Docs Hub is a page orchestrator + a state/mutation hook + shared row
// components; behavior assertions look across all three.
const hub = ['shell/src/docs-hub.jsx', 'shell/src/hooks/use-docs-hub.js', 'shell/src/docs-hub/rows.jsx']
  .map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
const shellApi = fs.readFileSync(path.join(root, 'shell/src/document/api.js'), 'utf8');
const shell = fs.readFileSync(path.join(root, 'server/shell.js'), 'utf8');
const docsHub = fs.readFileSync(path.join(root, 'shell/src/docs-hub.jsx'), 'utf8');
const docsHubCss = fs.readFileSync(path.join(root, 'shell/src/docs-hub.css'), 'utf8');

console.log('/me React Docs Hub');

t('worker computes structured catalog data without access-policy fields', () => {
  const start = worker.indexOf('async function indexData(');
  const end = worker.indexOf('\nfunction ', start + 20);
  const block = worker.slice(start, end);
  assert(start >= 0, 'indexData missing');
  assert(block.includes('Promise.all'), 'metadata should load in parallel');
  assert(!/allowed_users|history_visibility|commenting/.test(block), 'catalog leaks access policy');
  assert(!/readComments\(|DOCS\.head/.test(block), 'catalog performs per-row content/comment I/O');
});

t('/me route uses the shared React app shell with a CSP nonce', () => {
  const start = worker.indexOf("if (p === '/me' && method === 'GET')");
  const end = worker.indexOf('// ---- interactive island', start);
  const route = worker.slice(start, end);
  assert(route.includes("page: 'docs-hub'"), 'Docs Hub boot discriminator missing');
  assert(route.includes('SHELL.appHtml({'), 'shared app shell missing');
  assert(route.includes("'Content-Security-Policy': cspHeader(nonce)"), 'CSP missing');
  assert(route.includes('canSeeMyDocs(env, s, url.origin)'), 'catalog access gate missing');
  assert(!/injectSiteChrome|indexHtml/.test(route), 'legacy /me renderer remains');
});

t('Docs Hub exposes search, sort, tabs, folders, star, selection, and batch actions', () => {
  for (const needle of [
    'search-field', 'select-all', 'batch-delete', 'row-menu-btn', 'row-delete',
    'My docs', 'Recent', 'Starred', 'saveFolder', 'moveDocs', 'toggleStar',
  ]) assert(hub.includes(needle), `missing Docs Hub behavior: ${needle}`);
});

t('Create a doc is a two-card fork rendered by the shared component', () => {
  // The cards live in create-from-scratch; the recipe they open lives with the
  // onboarding copy that owns its wording (#371).
  const choice = ['shell/src/create-from-scratch.jsx', 'shell/src/onboarding-dialog.jsx']
    .map((file) => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  assert(/import \{ CreateChoice \}/.test(docsHub), 'the Create dialog should render the shared component');
  assert(/<CreateChoice create=\{hub\.createDoc\} canCreate=\{capabilities\.create\} \/>/.test(docsHub),
    'the cards must be wired to the hub hook and its capability');
  assert(/copyText\(FIRST_DOC_RECIPE\)\.then\(setCopied\)/.test(choice), 'the recipe is not copyable');
  assert(/className="tdoc-recipe-wrap"/.test(choice), 'shared recipe treatment missing');
  assert(/copied \? 'Copied' : 'Copy'/.test(choice), 'Copy feedback state missing');
  // The dialog now carries its own actions — the cards themselves (#356) — so
  // the footer is a plain dismiss. Two primaries in one dialog is the thing to
  // guard against, not the missing "Done".
  assert(/actions=\{<button type="button" onClick=\{closeModal\}>Close<\/button>\}/.test(docsHub),
    'Create dialog should close through the shared action row');
  assert(!/actions=\{<button[^>]+className="primary"/.test(docsHub),
    'the footer must not compete with the cards');
});

t('mobile hub keeps 44px actions while quieting management controls', () => {
  assert(/\.mk-btn,[\s\S]*\.tab,[\s\S]*min-height: 44px/.test(docsHubCss), 'Create or tabs have undersized mobile targets');
  assert(/\.search-field[\s\S]*flex-basis: 100%/.test(docsHubCss), 'search is not dominant on narrow screens');
  assert(/\.toolbar select,[\s\S]*\.new-folder-btn[\s\S]*border-color: transparent/.test(docsHubCss), 'narrow management controls remain visually loud');
  assert(/\.select-all[\s\S]*font-size: 12px/.test(docsHubCss), 'narrow selection control remains visually dominant');
});

t('Docs Hub mutations use session cookies and never ask for an admin token', () => {
  assert(shellApi.includes("credentials: 'same-origin'"), 'session credentials missing');
  assert(!/TDOC_UPLOAD_TOKEN|admin-token|Authorization/.test(hub), 'token admin path remains');
  assert(!hub.includes('/api/doc/access'), 'catalog must not own access controls');
});

t('shell builder emits a generic empty app root rather than /me HTML', () => {
  assert(shell.includes('<div id="tdoc-app-root"></div>'), 'generic React root missing');
  assert(shell.includes('window.__TDOC_APP_BOOT__'), 'app boot payload missing');
  assert(!/doc-search|batch-delete/.test(shell), 'Docs Hub markup leaked into server builder');
});

t('remote delete uses the shared owner authorization gate', () => {
  const start = worker.indexOf("if (p === '/api/doc' && method === 'DELETE')");
  const route = worker.slice(start, start + 2200);
  assert(route.includes('await authorizeOwnerMutation(req, env, slug)'), 'shared owner gate missing');
});

t('unknown and unauthorized navigation preserves a neutral landing notice', () => {
  assert(worker.includes('function neutralLandingResponse(env, notice)'), 'React landing response missing');
  assert(worker.includes("Location: '/?notice=notfound'"), 'not-found notice redirect missing');
  assert(worker.includes("page: 'neutral-landing'"), 'neutral landing boot missing');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
