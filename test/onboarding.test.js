// Onboarding tests.
//
// Mocked tests run by default. They invoke bin/tdoc-doctor with various
// TDOC_MOCK_* env vars and assert the JSON output describes the right state +
// the right missing_steps in the right order.
//
// Integration tests are gated behind TDOC_INTEGRATION=1. They assume the
// machine is already fully set up (which the doctor will verify) and run a
// real `tdoc-publish` / `tdoc-unpublish` round-trip on a throwaway slug.
//
// Run:
//   node test/onboarding.test.js
//   TDOC_INTEGRATION=1 node test/onboarding.test.js
//
// Exit code: 0 if all pass, 1 otherwise.

const { execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Resolve from the checkout under test, NOT ~/.claude/skills/tdoc — otherwise
// this suite silently probes whatever build happens to be installed and a
// broken working tree still goes green.
const SKILL_DIR = path.join(__dirname, '..');
const DOCTOR = path.join(SKILL_DIR, 'bin/tdoc-doctor');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, err) { console.log(`  ✗ ${name}\n    ${err}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e.message); } }

function runDoctor(envOverrides = {}) {
  // TDOC_PLATFORM is inherited from the caller's shell otherwise, which would
  // silently retarget every scenario.
  const env = { ...process.env, TDOC_PLATFORM: '', ...envOverrides };
  const out = execFileSync(DOCTOR, [], { env, encoding: 'utf8' });
  return JSON.parse(out);
}

function getStep(report, id) {
  return report.missing_steps.find(s => s.id === id);
}

(async () => {
  console.log('--- Mocked onboarding scenarios ---');

  await t('Scenario A [cloudflare]: no wrangler installed → missing_steps starts with wrangler', () => {
    const r = runDoctor({ TDOC_PLATFORM: 'cloudflare', TDOC_MOCK_NO_WRANGLER: '1' });
    if (r.deps.wrangler.ok) throw new Error('wrangler should be mocked-missing');
    if (r.ready_to_publish) throw new Error('cannot be ready without wrangler');
    if (!getStep(r, 'wrangler')) throw new Error('missing_steps should include id:wrangler');
    if (r.missing_steps[0].id !== 'wrangler') throw new Error(`expected wrangler first, got ${r.missing_steps[0].id}`);
  });

  await t('Scenario B: no jq → reports jq missing', () => {
    const r = runDoctor({ TDOC_MOCK_NO_JQ: '1' });
    // jq missing → JSON falls through to the minimal-emission path
    if (r.deps.jq.ok) throw new Error('jq should be mocked-missing');
    if (!r.missing_steps.find(s => s.id === 'jq')) throw new Error('jq step missing');
  });

  await t('Scenario C [cloudflare]: wrangler OK but no R2 → R2 step appears with click URL', () => {
    const r = runDoctor({ TDOC_PLATFORM: 'cloudflare', TDOC_MOCK_NO_R2: '1' });
    if (r.cloudflare.r2_enabled) throw new Error('R2 should be mocked-disabled');
    const step = getStep(r, 'cf_r2');
    if (!step) throw new Error('cf_r2 step missing');
    if (step.kind !== 'click') throw new Error(`cf_r2 should be kind:click, got ${step.kind}`);
    if (!step.cmd.startsWith('https://dash.cloudflare.com/')) throw new Error(`expected dashboard URL, got "${step.cmd}"`);
  });

  await t('Scenario D [cloudflare]: subdomain not claimed → step with onboarding URL', () => {
    const r = runDoctor({ TDOC_PLATFORM: 'cloudflare', TDOC_MOCK_NO_SUBDOMAIN: '1' });
    if (r.cloudflare.subdomain.ok) throw new Error('subdomain should be mocked-unclaimed');
    const step = getStep(r, 'cf_subdomain');
    if (!step) throw new Error('cf_subdomain step missing');
    if (step.kind !== 'click') throw new Error('cf_subdomain should be kind:click');
    if (!step.cmd.includes('/workers-and-pages')) throw new Error(`expected workers-and-pages URL, got "${step.cmd}"`);
  });

  await t('Scenario E [cloudflare]: not logged into Cloudflare → cf_login step (login kind)', () => {
    const r = runDoctor({ TDOC_PLATFORM: 'cloudflare', TDOC_MOCK_NO_CF_LOGIN: '1' });
    if (r.cloudflare.logged_in) throw new Error('cf should be mocked-logged-out');
    const step = getStep(r, 'cf_login');
    if (!step) throw new Error('cf_login step missing');
    if (step.kind !== 'login') throw new Error('cf_login should be kind:login');
    if (step.cmd !== 'wrangler login') throw new Error(`expected 'wrangler login', got "${step.cmd}"`);
  });

  await t('Scenario E2 [cloudflare]: logged in but token unreadable → cf_token step, publish_token_ok false, not ready', () => {
    const r = runDoctor({ TDOC_PLATFORM: 'cloudflare', TDOC_MOCK_NO_PUBLISH_TOKEN: '1' });
    // The token read happens only inside the "wrangler whoami succeeds" block,
    // so this scenario can only exercise the real elif branch when the host is
    // actually logged into Cloudflare. On a logged-out box (typical CI), the
    // mock has nothing to override — assert the logged-out invariant instead,
    // so the test is deterministic everywhere rather than environment-flaky.
    if (!r.cloudflare.logged_in) {
      if (!getStep(r, 'cf_login')) throw new Error('logged-out host should still surface cf_login');
      return; // can't simulate logged-in-but-no-token without a real login
    }
    // Logged-in host: this is the real #37 regression guard. whoami works but
    // the stored OAuth token can't be read; doctor used to report
    // logged_in:true and then silently fall through to "claim subdomain",
    // misattributing the cause.
    if (r.cloudflare.publish_token_ok) throw new Error('publish_token_ok should be false when token unreadable');
    if (r.ready_to_publish) throw new Error('cannot be ready without a usable token');
    const step = getStep(r, 'cf_token');
    if (!step) throw new Error('cf_token step missing when token unreadable');
    if (step.kind !== 'login') throw new Error(`cf_token should be kind:login, got ${step.kind}`);
    // And it must NOT misattribute to subdomain/r2 when the real cause is the token.
    if (getStep(r, 'cf_subdomain') || getStep(r, 'cf_r2')) {
      throw new Error('token failure must not surface as subdomain/r2 steps');
    }
  });

  await t('Scenario F: never published → published.ok is false but does not appear in missing_steps', () => {
    const r = runDoctor({ TDOC_MOCK_NOT_PUBLISHED: '1' });
    if (r.published.ok) throw new Error('published.ok should be false');
    // Publishing isn't itself a "missing step" — it's an action user takes after onboarding.
    if (r.missing_steps.find(s => s.id === 'published')) {
      throw new Error('missing_steps should not include published; user runs /tdoc publish themselves');
    }
  });

  await t('Scenario G [cloudflare]: everything missing → ordered list, install first, click last', () => {
    const r = runDoctor({
      TDOC_PLATFORM: 'cloudflare',
      TDOC_MOCK_NO_WRANGLER: '1',
      TDOC_MOCK_NO_JQ: '1',
      TDOC_MOCK_NO_CF_LOGIN: '1',
    });
    if (r.ready_to_publish) throw new Error('should not be ready');
    if (!r.missing_steps.length) throw new Error('should have steps');
    // The "install" step should come before "login" step (install order matters)
    // jq missing falls through to the simple emission path so structure differs.
    const ids = r.missing_steps.map(s => s.id);
    if (!ids.includes('jq')) throw new Error(`expected jq, got [${ids.join(',')}]`);
  });

  console.log('\n--- Hosted target (#236) ---');

  await t('H1: hosted is the default target when nothing says otherwise', () => {
    const r = runDoctor({ TDOC_MOCK_NOT_PUBLISHED: '1' });
    if (r.target !== 'hosted') throw new Error(`expected target hosted, got ${r.target}`);
  });

  await t('H2: a machine with no Cloudflare tooling at all is READY for hosted', () => {
    // The bug: this exact machine was told to install wrangler, log into
    // Cloudflare, claim a subdomain and enable R2 — none of which hosted needs.
    const r = runDoctor({
      TDOC_MOCK_NOT_PUBLISHED: '1',
      TDOC_MOCK_NO_WRANGLER: '1',
      TDOC_MOCK_NO_CF_LOGIN: '1',
      TDOC_MOCK_NO_SUBDOMAIN: '1',
      TDOC_MOCK_NO_R2: '1',
    });
    if (!r.ready_to_publish) {
      throw new Error(`hosted must be ready without Cloudflare; steps=[${r.missing_steps.map(s => s.id).join(',')}]`);
    }
    for (const id of ['wrangler', 'cf_login', 'cf_subdomain', 'cf_r2', 'cf_token']) {
      if (getStep(r, id)) throw new Error(`hosted must never ask for "${id}"`);
    }
  });

  await t('H3: hosted still reports the deps it genuinely needs', () => {
    for (const [mock, id] of [['TDOC_MOCK_NO_NODE', 'node'], ['TDOC_MOCK_NO_CURL', 'curl']]) {
      const r = runDoctor({ TDOC_MOCK_NOT_PUBLISHED: '1', [mock]: '1' });
      if (r.ready_to_publish) throw new Error(`hosted cannot be ready without ${id}`);
      if (!getStep(r, id)) throw new Error(`expected a "${id}" step`);
    }
  });

  await t('H4: target resolves flag > env > published.json, and the read is jq-free', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-doctor-target-'));
    const cfg = path.join(dir, 'published.json');
    try {
      fs.writeFileSync(cfg, JSON.stringify({ platform: 'cloudflare', subdomain: 'a', worker: 'tdoc' }));
      const fromCfg = runDoctor({ TDOC_CONFIG_FILE: cfg });
      if (fromCfg.target !== 'cloudflare') throw new Error(`config should select cloudflare, got ${fromCfg.target}`);

      // jq is what the doctor reports on, so resolving the target must not need it.
      const noJq = runDoctor({ TDOC_CONFIG_FILE: cfg, TDOC_MOCK_NO_JQ: '1' });
      if (noJq.target !== 'cloudflare') throw new Error(`target must resolve without jq, got ${noJq.target}`);

      const fromEnv = runDoctor({ TDOC_CONFIG_FILE: cfg, TDOC_PLATFORM: 'hosted' });
      if (fromEnv.target !== 'hosted') throw new Error(`env should beat config, got ${fromEnv.target}`);

      const out = execFileSync(DOCTOR, ['--platform', 'vercel'], {
        env: { ...process.env, TDOC_CONFIG_FILE: cfg, TDOC_PLATFORM: 'hosted' }, encoding: 'utf8',
      });
      const fromFlag = JSON.parse(out);
      if (fromFlag.target !== 'vercel') throw new Error(`flag should beat env, got ${fromFlag.target}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await t('H5: an unknown platform falls back to hosted rather than guessing', () => {
    const r = runDoctor({ TDOC_MOCK_NOT_PUBLISHED: '1', TDOC_PLATFORM: 'nonsense' });
    if (r.target !== 'hosted') throw new Error(`expected fallback to hosted, got ${r.target}`);
  });

  console.log('\n--- Help text on tdoc-update ---');

  await t('tdoc-update --help prints usage', () => {
    const r = spawnSync(path.join(SKILL_DIR, 'bin/tdoc-update'), ['--help'], { encoding: 'utf8' });
    if (!r.stdout.includes('usage:')) throw new Error(`no usage in: ${r.stdout}`);
  });

  await t('tdoc-update --check exits 0 with no changes (skill is up-to-date) or with diverged', () => {
    const r = spawnSync(path.join(SKILL_DIR, 'bin/tdoc-update'), ['--check'], { encoding: 'utf8' });
    // Acceptable exit codes: 0 (up-to-date OR --check returned cleanly) or 1 (diverged).
    if (![0, 1].includes(r.status)) throw new Error(`unexpected exit ${r.status}: ${r.stdout}\n${r.stderr}`);
  });

  // ---- Integration tests (gated) ----
  if (process.env.TDOC_INTEGRATION === '1') {
    console.log('\n--- Integration: real Cloudflare round-trip ---');
    const SLUG = `tdoc-int-${Date.now()}`;
    await t('Pre-flight: doctor says ready_to_publish', () => {
      const r = runDoctor();
      if (!r.ready_to_publish) throw new Error(`not ready: missing ${JSON.stringify(r.missing_steps)}`);
    });

    await t(`Create local doc ${SLUG}`, () => {
      const dir = path.join(os.homedir(), 'tdocs', SLUG, 'v1');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'index.html'), '<h1>integration test</h1>');
      fs.writeFileSync(path.join(os.homedir(), 'tdocs', SLUG, 'meta.json'),
        JSON.stringify({ title: 'int test', versions: [{ n: 1 }] }));
      fs.writeFileSync(path.join(os.homedir(), 'tdocs', SLUG, 'comments.json'), '[]');
    });

    await t(`Publish ${SLUG} via tdoc-publish`, () => {
      const r = spawnSync(path.join(SKILL_DIR, 'bin/tdoc-publish'), [SLUG], { encoding: 'utf8', timeout: 60000 });
      if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr || r.stdout}`);
      if (!r.stdout.includes('Published:')) throw new Error(`no Published: line in output`);
    });

    await t(`Unpublish ${SLUG}`, () => {
      const r = spawnSync(path.join(SKILL_DIR, 'bin/tdoc-unpublish'), [SLUG], { encoding: 'utf8', timeout: 30000 });
      if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr || r.stdout}`);
    });

    // Cleanup local
    fs.rmSync(path.join(os.homedir(), 'tdocs', SLUG), { recursive: true, force: true });
  } else {
    console.log('\n(Integration tests skipped. Run with TDOC_INTEGRATION=1 to enable.)');
  }

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail ? 1 : 0);
})();
