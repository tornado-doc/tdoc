// PR preview workflow (#148) — shareable published-chrome URL, not tdoc.dev.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const wf = fs.readFileSync(path.join(root, '.github/workflows/preview.yml'), 'utf8');
const prod = fs.readFileSync(path.join(root, '.github/workflows/deploy-tdoc-dev.yml'), 'utf8');
const tpl = fs.readFileSync(path.join(root, 'worker/wrangler.preview.toml.template'), 'utf8');

console.log('PR preview workflow (#148)');

t('runs on pull_request, never deploys tdoc.dev', () => {
  assert(/^\s*pull_request:/m.test(wf), 'must run on pull_request');
  assert(!/^\s*pull_request:/m.test(prod), 'production CD must stay main-only');
  assert(wf.includes('--name tdoc-preview') || wf.includes('tdoc-preview'),
    'must target the preview Worker');
  assert(!/wrangler deploy --name tdoc[^-]/.test(wf),
    'must not wrangler-deploy the production tdoc Worker');
  assert(!wf.includes('custom domain tdoc.dev'),
    'preview must not be the tdoc.dev production CD workflow');
});

t('is scoped to tornado-doc/tdoc and skips forks', () => {
  assert(wf.includes("github.repository == 'tornado-doc/tdoc'"),
    'must refuse to run on a fork of the repo');
  assert(wf.includes('github.event.pull_request.head.repo.full_name == github.repository'),
    'must not run fork PRs (no secrets, would deploy the org Worker from untrusted code)');
});

t('uses pr-<N> alias, not the branch name', () => {
  assert(wf.includes('--preview-alias'), 'must pass --preview-alias');
  assert(wf.includes('pr-${{ github.event.pull_request.number }}') || wf.includes('pr-${{ github.event.pull_request.number }}'),
    'alias must be pr-<PR number>');
  assert(!wf.includes('github.head_ref') || !wf.includes('--preview-alias "$BRANCH"'),
    'must not alias from the branch name');
});

t('sticky comment matches the #148 template', () => {
  assert(wf.includes('<!-- tdoc-preview -->'), 'must use the sticky HTML marker');
  assert(wf.includes('**Open this:**'), 'must lead with Open this');
  // The root used to be the neutral page on a preview, so the comment pointed
  // at the demo doc instead. The preview now seeds the landing, so `/` is the
  // real homepage and leads; the demo doc stays as the second link, because a
  // document is where the comment layer can be exercised.
  assert(wf.includes('**Open this:** https://${PREVIEW_HOST}/ '),
    'Open this must be the homepage now that the preview seeds it');
  assert(wf.includes('/d/conway-life/v/2'), 'the demo doc must still be linked');
  assert(/seed .*landing|seeded landing/.test(wf), 'the preview must seed the landing doc');
  assert(wf.includes('It is not [tdoc.dev](https://tdoc.dev)'),
    'must say the link is not tdoc.dev');
  assert(wf.includes('issues/comments/'), 'must PATCH an existing comment rather than always POST');
});

t('preview storage is not production, and DO is stripped', () => {
  assert(wf.includes('TDOC_PREVIEW: \'1\'') || wf.includes('TDOC_PREVIEW: "1"') || wf.includes("TDOC_PREVIEW: '1'"),
    'must bundle with TDOC_PREVIEW=1');
  assert(wf.includes('tdoc-preview-docs'), 'must use the preview R2 bucket');
  assert(wf.includes('tdoc-preview-META'), 'must use the preview KV namespace');
  assert(wf.includes('export class CommentsStore'),
    'must fail the job if the preview bundle still exports the DO');
  assert(tpl.includes('preview_urls = true'), 'preview wrangler must opt in to preview URLs');
  assert(!/durable_objects/.test(tpl), 'preview wrangler must omit COMMENTS DO');
});

t('never uses a personal Worker or the production upload token', () => {
  assert(wf.includes('TDOC_PREVIEW_UPLOAD_TOKEN'), 'must use a preview-only upload token');
  assert(!wf.includes('secrets.TDOC_DEV_UPLOAD_TOKEN'), 'must not reuse the tdoc.dev upload token');
  assert(!wf.includes('published.json'), 'must not read a laptop ~/.tdoc/published.json');
  assert(wf.includes('Do not deploy previews to a personal Worker'),
    'missing-secrets error must say not to use a personal Worker');
});

t('Node and wrangler match production CD pins', () => {
  const node = wf.match(/node-version:\s*'(\d+)'/);
  assert(node && Number(node[1]) >= 22, 'wrangler 4.90.1 needs Node >= 22');
  assert(wf.includes('wrangler@4.90.1'), 'pin wrangler 4.90.1 like tdoc.dev CD');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
