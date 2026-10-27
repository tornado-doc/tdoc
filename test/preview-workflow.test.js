// PR preview workflow (#148) — shareable published-chrome URL, not tdoc.dev.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const wf = fs.readFileSync(path.join(root, '.github/workflows/preview.yml'), 'utf8');
const baseWf = fs.readFileSync(path.join(root, '.github/workflows/preview-auth-base.yml'), 'utf8');
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
  assert(/"access":\{"visibility":"public","commenting":"signed_in","history_visibility":"public"/.test(wf),
    'the linked demo doc must be anonymously readable without enabling anonymous writes');
  assert(wf.includes('tdoc-preview-publish-landing.sh'), 'the preview must seed the landing doc');
  const reset = wf.indexOf('reset_preview_slug conway-life');
  const seed = wf.indexOf('seed 1 test/fixtures/tdocs/sample-doc/v1/index.html');
  assert(reset !== -1 && reset < seed,
    'reruns must clear the retained preview fixtures before reseeding v1');
  assert(!wf.includes('reset_preview_slug tornado-doc') && wf.includes('replace:true'),
    'the shared landing must be replaced in place, not moved to Trash on every PR');
  assert(wf.includes('bash bin/tdoc-preview-publish-landing.sh') && wf.includes('LANDING_STATUS='),
    'preview seed must recover a trashed landing and recheck it before skipping reseed');
  assert(/-X DELETE[\s\\]*\n[\s\S]*\/api\/doc\?slug=\$slug/.test(wf),
    'preview fixture reset must use the authenticated document delete route');
  assert(wf.includes('200|404)'),
    'preview fixture reset must be idempotent when a fixture does not exist yet');
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

t('unchanged PR fixtures do not burn the daily KV write budget', () => {
  assert(wf.includes('FIXTURE_FINGERPRINT='), 'preview seed must fingerprint its fixture inputs');
  assert(wf.includes('preview-fixtures:pr-${{ github.event.pull_request.number }}'),
    'fixture fingerprint must be isolated per PR');
  assert(wf.includes('wrangler kv key get "$FIXTURE_MARKER"'),
    'preview seed must read the prior fingerprint before deleting data');
  assert(wf.includes('preview fixtures unchanged; skipping KV delete/reseed'),
    'an unchanged rerun must skip destructive fixture writes');
  assert(wf.includes('wrangler kv key put "$FIXTURE_MARKER" "$FIXTURE_FINGERPRINT"'),
    'a successful seed must record its fingerprint');
  assert(wf.includes('--ttl 1209600'), 'the fixture marker must expire with 14-day preview data');
});

t('landing seed publishes normally, restores Trash before retry, and rejects unrelated conflicts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-preview-landing-seed-'));
  const curl = path.join(dir, 'curl');
  const sleep = path.join(dir, 'sleep');
  const payload = path.join(dir, 'landing.json');
  const log = path.join(dir, 'calls');
  const count = path.join(dir, 'count');
  const script = path.join(root, 'bin/tdoc-preview-publish-landing.sh');
  try {
    fs.writeFileSync(payload, JSON.stringify({ slug: 'tornado-doc', version: 1, replace: true }));
    fs.writeFileSync(sleep, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(curl, `#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -X|-H|--data|--data-binary|--connect-timeout|--max-time|-w) shift 2 ;;
    http://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */api/upload)
    echo upload >> "$MOCK_LOG"
    n=0; [ ! -f "$MOCK_COUNT" ] || n=$(cat "$MOCK_COUNT")
    n=$((n+1)); echo "$n" > "$MOCK_COUNT"
    if [ "$MOCK_SCENARIO" = trash ] && [ "$n" = 1 ]; then
      echo '{"error":"doc_in_trash","slug":"tornado-doc"}' > "$out"; printf 409
    elif [ "$MOCK_SCENARIO" = conflict ]; then
      echo '{"error":"version_conflict"}' > "$out"; printf 409
    else echo '{"ok":true}' > "$out"; printf 200; fi ;;
  */api/trash/restore)
    echo restore >> "$MOCK_LOG"
    echo '{"ok":true,"restored":["tornado-doc"]}' > "$out"; printf 200 ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
    for (const [scenario, expectedStatus, expectedCalls] of [
      ['normal', 0, 'upload'],
      ['trash', 0, 'upload\nrestore\nupload'],
      ['conflict', 1, 'upload'],
    ]) {
      fs.writeFileSync(log, '');
      fs.writeFileSync(count, '0');
      const run = spawnSync('bash', [script, 'http://preview.test', payload], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, MOCK_LOG: log, MOCK_COUNT: count,
          MOCK_SCENARIO: scenario, TDOC_PREVIEW_UPLOAD_TOKEN: 'test-preview-only',
          TDOC_PREVIEW_LANDING_RESPONSE: path.join(dir, 'response.json') }, encoding: 'utf8',
      });
      assert(run.status === expectedStatus, `${scenario} exited ${run.status}: ${run.stderr}`);
      assert(fs.readFileSync(log, 'utf8').trim() === expectedCalls, `${scenario} called ${fs.readFileSync(log, 'utf8')}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('never uses a personal Worker or the production upload token', () => {
  assert(wf.includes('TDOC_PREVIEW_UPLOAD_TOKEN'), 'must use a preview-only upload token');
  assert(!wf.includes('secrets.TDOC_DEV_UPLOAD_TOKEN'), 'must not reuse the tdoc.dev upload token');
  assert(!wf.includes('published.json'), 'must not read a laptop ~/.tdoc/published.json');
  assert(wf.includes('Do not deploy previews to a personal Worker'),
    'missing-secrets error must say not to use a personal Worker');
});

t('preview Clerk client is optional, isolated, and rejects TOML injection', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-preview-oidc-'));
  const file = path.join(dir, 'wrangler.toml');
  const script = path.join(root, 'bin', 'tdoc-preview-oidc-config.js');
  try {
    fs.writeFileSync(file, tpl);
    let run = spawnSync(process.execPath, [script, file], {
      env: { ...process.env, TDOC_PREVIEW_OIDC_CLIENT_ID: '' }, encoding: 'utf8',
    });
    assert(run.status === 0 && fs.readFileSync(file, 'utf8') === tpl,
      'an unconfigured preview must stay anonymously readable');

    run = spawnSync(process.execPath, [script, file], {
      env: { ...process.env, TDOC_PREVIEW_OIDC_CLIENT_ID: 'previewClient_123' }, encoding: 'utf8',
    });
    const configured = fs.readFileSync(file, 'utf8');
    assert(run.status === 0 && configured.includes('OIDC_ISSUER = "https://clerk.tdoc.dev"') &&
      configured.includes('OIDC_CLIENT_ID = "previewClient_123"'),
    'configured preview must use its own Clerk OAuth client');
    assert(!configured.includes('OIDC_CLIENT_SECRET ='), 'client secret must not enter Wrangler vars');

    fs.writeFileSync(file, tpl);
    run = spawnSync(process.execPath, [script, file], {
      env: { ...process.env, TDOC_PREVIEW_OIDC_CLIENT_ID: 'bad"\nTDOC_PREVIEW = "0' }, encoding: 'utf8',
    });
    assert(run.status !== 0 && fs.readFileSync(file, 'utf8') === tpl,
      'invalid client IDs must not rewrite the preview config');
    assert(wf.includes('secrets.TDOC_PREVIEW_OIDC_CLIENT_SECRET') &&
      wf.includes('wrangler versions secret put OIDC_CLIENT_SECRET --name tdoc-preview'),
    'the separate preview client secret must be installed only on tdoc-preview');
    assert(!wf.includes('secrets.OIDC_CLIENT_SECRET') && !tpl.includes('OIDC_CLIENT_ID = "qKJaxWEoECYonmld"'),
      'preview must not reuse the production Clerk OAuth client');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('fixed Clerk callback deploy is main-only and does not touch production', () => {
  assert(wf.split('\n').some((line) => line === '#   Clerk redirect URI https://tdoc-preview.jyshi1107.workers.dev/auth/oidc/callback'),
    'PR preview must document the one fixed Clerk callback');
  assert(tpl.split('\n').some((line) => line === '# https://tdoc-preview.jyshi1107.workers.dev/auth/oidc/callback in Clerk.'),
    'preview Worker config must document the fixed callback');
  assert(baseWf.includes('workflow_dispatch:') && baseWf.includes("github.ref == 'refs/heads/main'"),
    'stable callback deployment must run from main only');
  assert(baseWf.includes('wrangler deploy --name tdoc-preview') &&
    baseWf.includes('wrangler secret put OIDC_CLIENT_SECRET --name tdoc-preview'),
  'stable callback host needs its own deployed code and secret');
  assert(!/wrangler deploy --name tdoc(?:\s|$)/m.test(baseWf), 'callback deploy must never target production');
});

t('preview deploy rejects either half of the Clerk OAuth pair', () => {
  const step = wf.split('      - name: Require preview secrets\n')[1]
    ?.split('      - name: Offline test suite\n')[0];
  assert(step && step.includes('        run: |\n'), 'preview secret check step is missing');
  const script = step.split('        run: |\n')[1].replace(/^          /gm, '');
  for (const [id, secret, expected] of [
    ['', '', 0],
    ['previewClient_123', '', 1],
    ['', 'test-secret', 1],
    ['previewClient_123', 'test-secret', 0],
  ]) {
    const run = spawnSync('bash', ['-e', '-c', script], {
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: 'test-token', CLOUDFLARE_ACCOUNT_ID: 'test-account',
        TDOC_PREVIEW_UPLOAD_TOKEN: 'test-upload',
        TDOC_PREVIEW_OIDC_CLIENT_ID: id, TDOC_PREVIEW_OIDC_CLIENT_SECRET: secret,
      },
      encoding: 'utf8',
    });
    assert(run.status === expected, `Clerk pair ID=${Boolean(id)}, secret=${Boolean(secret)} returned ${run.status}`);
  }
});

t('Node and wrangler match production CD pins', () => {
  const node = wf.match(/node-version:\s*'(\d+)'/);
  assert(node && Number(node[1]) >= 22, 'wrangler 4.90.1 needs Node >= 22');
  assert(wf.includes('wrangler@4.90.1'), 'pin wrangler 4.90.1 like tdoc.dev CD');
});

t('a failed upload prints Wrangler diagnostics before exiting', () => {
  const upload = wf.slice(wf.indexOf('- name: Upload version with pr-N alias'));
  assert(upload.includes('set +e') && upload.includes('STATUS=$?'),
    'upload must capture failure instead of exiting inside command substitution');
  assert(upload.indexOf('echo "$OUT"') < upload.indexOf('exit "$STATUS"'),
    'captured Wrangler output must be printed before the failing exit');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
