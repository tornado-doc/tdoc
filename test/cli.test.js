// CLI resilience tests (Batch D). Drives the real bash scripts in a hermetic
// temp TDOC_DIR. Node test runner so it joins the same `npm test` suite.
//
// Covers:
//   - tdoc-new-force-destroys-before-validate (P2): --force must NOT destroy an
//     existing doc when the replacement HTML is invalid (stage-validate-swap)
//   - cli-curl-no-timeout (P2): every curl carries --max-time (static check)
//   - cli-cf-api-no-http-status-check (P2): cf_api helper exists + gates status
//   - published.json validation, partial-version abort, ping-loop (static)
//
// Run with: node test/cli.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn, spawnSync } = require('child_process');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const BIN = path.join(__dirname, '..', 'bin');
const readBin = (f) => fs.readFileSync(path.join(BIN, f), 'utf8');

console.log('cli (Batch D resilience)');

// ---- static checks across all CLIs ----
t('every curl call carries --max-time (no unbounded hang)', () => {
  for (const f of ['tdoc-publish', 'tdoc-pull', 'tdoc-doctor', 'tdoc-agent-reply']) {
    const src = readBin(f);
    // Actual invocations only: `curl` in COMMAND position — at the start of a
    // line or right after |, ;, &, ( or $( — and followed by a flag, quote or
    // $var. Looser patterns kept catching things that issue no request and so
    // cannot hang: `curl_ok`, `command -v curl`, "brew install curl" as a
    // missing_steps label, and `add_step curl "Install curl"` where curl is
    // the argument rather than the program.
    const curls = src.split('\n').filter(l => /(^|[|;&(]|\$\()\s*curl\s+(-|["'$])/.test(l)
      && !l.trim().startsWith('#'));
    for (const line of curls) {
      assert(/--max-time/.test(line), `${f}: curl without --max-time:\n      ${line.trim()}`);
    }
  }
});

t('tdoc-publish has a cf_api helper that checks HTTP status', () => {
  const src = readBin('tdoc-publish');
  assert(/cf_api\(\)/.test(src), 'cf_api helper missing');
  assert(/http_code/.test(src) && /grep -qE '\^2/.test(src), 'cf_api does not gate on 2xx HTTP status');
});

t('tdoc-publish validates published.json fields (no null host/token)', () => {
  const src = readBin('tdoc-publish');
  assert(/= "null"/.test(src) && /Delete it and re-run/.test(src),
    'published.json null-field validation missing');
});

t('tdoc-publish does not let an older-version failure abort the latest', () => {
  const src = readBin('tdoc-publish');
  assert(/OLDER_FAILED/.test(src), 'older-version best-effort handling missing');
  assert(/FATAL: latest version/.test(src), 'latest-version hard-fail missing');
});

t('tdoc-publish defaults to hosted and treats Cloudflare/Vercel as self-host flags', () => {
  const src = readBin('tdoc-publish');
  assert(/hosted\|cloudflare\|vercel/.test(src), 'usage does not include hosted platform');
  assert(/PLATFORM_FLAG:-hosted/.test(src), 'first publish must default to hosted');
  assert(/first_time_setup_hosted\(\)/.test(src), 'hosted setup function missing');
  assert(/\/api\/hosted\/token/.test(src), 'hosted setup does not request a provider-issued token');
  assert(/\/api\/auth\/device\/start/.test(src), 'hosted setup must GitHub-device-flow before minting a token');
  assert(/sign_in_required/.test(src), 'hosted setup must handle a missing GitHub session');
  assert(!/TDOC_HOSTED_UPLOAD_TOKEN/.test(src), 'hosted setup must not require an out-of-band upload token');
  assert(/TDOC_HOSTED_BASE:-https:\/\/tdoc\.dev/.test(src), 'hosted setup does not default to tdoc.dev');
  assert(/platform: "hosted"/.test(src), 'hosted setup does not persist hosted platform');
  assert(/github_login: gh/.test(src), 'hosted setup does not persist github_login');
  assert(/account_id: acct/.test(src), 'hosted setup does not persist account_id');
  assert(/if \[ "\$PLATFORM" = "hosted" \]/.test(src), 'hosted platform branch missing');
  assert(/UPLOAD_BASE="\$BASE"/.test(src), 'hosted branch should upload to configured base');
  assert(/PUBLIC_BASE="\$BASE"/.test(src), 'hosted branch should emit configured hosted base links');
  assert(/hosted_registration_disabled/.test(src),
    'hosted setup should detect closed provider registration');
  assert(/--platform cloudflare/.test(src) && /--platform vercel/.test(src),
    'closed hosted signup must point at --platform cloudflare|vercel');
  assert(!/enable TDOC_HOSTED_REGISTRATION/.test(src),
    'CLI must not tell users to flip TDOC_HOSTED_REGISTRATION on tdoc.dev');
  assert(/platform:"cloudflare"/.test(src),
    'cloudflare setup must persist platform:"cloudflare"');
  assert(/switching publish platform/.test(src),
    'conflicting --platform must switch (rewrite config), not ignore');
  assert(!/ignoring '--platform/.test(src),
    'must not swallow a conflicting --platform flag');
  assert(/published\.json\.bak\.switch/.test(src),
    'platform switch must keep a previous-config backup');
});

t('pull/unpublish read hosted base from published.json', () => {
  for (const f of ['tdoc-pull', 'tdoc-unpublish']) {
    const src = readBin(f);
    assert(/PLATFORM="\$\(json_file_get "\$CONFIG_FILE" platform\)"/.test(src),
      `${f}: platform detection missing`);
    assert(/PLATFORM="\$\{PLATFORM:-cloudflare\}"/.test(src),
      `${f}: platform must still default to cloudflare for old configs`);
    assert(/"\$PLATFORM" = "hosted"/.test(src), `${f}: hosted platform branch missing`);
    assert(/BASE="\$\(json_file_get "\$CONFIG_FILE" base\)"/.test(src),
      `${f}: hosted/vercel branch should read .base`);
  }
});

t('tdoc-new fails loudly if the local server never comes up', () => {
  const src = readBin('tdoc-new');
  assert(/SERVER_UP/.test(src) && /failed to start/.test(src),
    'ping-loop success is not checked');
});

t('chat-driven new and edit flows require host validation', () => {
  const rootSkill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const packagedSkill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'tdoc', 'SKILL.md'), 'utf8');
  assert(rootSkill === packagedSkill, 'root and packaged SKILL.md copies must stay identical');
  // Validation is no longer a step the agent performs between writing the file
  // and publishing it: writing a version goes through bin/tdoc-write, which
  // validates, bakes and records in one place. Both prose paths must route
  // through it, or the guarantee is optional again.
  assert(/Hand the HTML to `bin\/tdoc-write`[\s\S]*Do not write into `~\/tdocs` yourself[\s\S]*not open, publish, or report the document as complete/.test(rootSkill),
    '/tdoc new must write through the gateway');
  assert(/Hand it to `bin\/tdoc-write --version next`[\s\S]*Do not write `v<n\+1>\/` yourself/.test(rootSkill),
    '/tdoc edit must write through the gateway');
});

// The reader stamps `background` and `border-radius` onto every th and td at
// zero specificity, so a table that names neither renders as a grid of rounded
// tinted chips no matter what the style says. That failure is invisible in the
// source, which is why the validator checks it instead of leaving it to prose.
// The contract is "name it", not "make it transparent": a heat-map cell that
// deliberately sets a fill is a choice, and only silence inherits a chip.
// An <svg width="960"> renders at 960 physical pixels. The reader caps it with
// `max-width: 100% !important`, so a figure that states no width of its own
// looks right where tdoc serves it and runs off the right edge anywhere else,
// with the scroll wrapper hiding the overflow rather than announcing it.
t('a figure with a pixel width but no CSS width is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-fig-'));
  const write = (css, body) => {
    const f = path.join(dir, 'f' + Math.abs(css.length * 31 + body.length) + '.html');
    fs.writeFileSync(f, `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background: #fff; } ${css}</style>
      </head><body><div class="wrap"><h1>T</h1>${body}</div></body></html>`);
    return spawnSync(path.join(BIN, 'tdoc-validate-template'), [f], { encoding: 'utf8' });
  };
  const FIG = '<div class="diagram-box"><svg viewBox="0 0 960 200" width="960" height="200"><rect x="0" y="0" width="80" height="40"/></svg></div>';
  const RE = /sized by the reader rather than by the document/;
  try {
    const bare = write('.diagram-box { overflow-x:auto }', FIG);
    assert(RE.test(bare.stdout + bare.stderr),
      'a figure with a pixel width and no CSS width must be rejected');

    const fluid = write('.diagram-box { overflow-x:auto } .diagram-box svg { width:100%; height:auto }', FIG);
    assert(!RE.test(fluid.stdout + fluid.stderr), 'width:100% must satisfy the check');

    // Declaring a min-width is the deliberate scroll case, and is also a width.
    const scrolls = write('.diagram-box { overflow-x:auto } .diagram-box svg { width:100%; min-width:660px }', FIG);
    assert(!RE.test(scrolls.stdout + scrolls.stderr), 'a deliberate scroll width must pass');

    // No intrinsic width means the figure is already fluid.
    const noattr = write('.diagram-box { overflow-x:auto }',
      '<div class="diagram-box"><svg viewBox="0 0 960 200"><rect x="0" y="0" width="80" height="40"/></svg></div>');
    assert(!RE.test(noattr.stdout + noattr.stderr), 'a figure with no pixel width has nothing to declare');

    // An inline glyph outside a scroll wrapper is not a figure.
    const glyph = write('.wrap p { margin:0 }', '<p><svg viewBox="0 0 16 16" width="16" height="16"><rect x="0" y="0" width="8" height="8"/></svg></p>');
    assert(!RE.test(glyph.stdout + glyph.stderr), 'an inline glyph is not a figure');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('a table whose cells never name background or radius is rejected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-cells-'));
  const write = (css, body) => {
    const f = path.join(dir, 'c' + Math.abs(css.length + body.length) + '.html');
    fs.writeFileSync(f, `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background: #fff; } ${css}</style>
      </head><body><div class="wrap"><h1>T</h1>${body}</div></body></html>`);
    return spawnSync(path.join(BIN, 'tdoc-validate-template'), [f], { encoding: 'utf8' });
  };
  const TABLE = '<table><tr><th>a</th></tr><tr><td>b</td></tr></table>';
  try {
    const bare = write('.wrap th, .wrap td { border-bottom:1px solid #eee; padding:8px; }', TABLE);
    assert(/reader's chip/.test(bare.stdout + bare.stderr),
      'a table setting only borders and padding must be rejected');

    const reset = write('.wrap th, .wrap td { background:transparent; border-radius:0; border-bottom:1px solid #eee; }', TABLE);
    assert(!/reader's chip/.test(reset.stdout + reset.stderr),
      'naming both properties must satisfy the check');

    // A deliberate fill is a choice the author made and can see; it passes.
    const chosen = write('.wrap th, .wrap td { background:#fafafa; border-radius:4px; }', TABLE);
    assert(!/reader's chip/.test(chosen.stdout + chosen.stderr),
      'a deliberately filled cell is a choice, not an inherited chip');

    // A document with no table has nothing to reset.
    const notable = write('.wrap p { margin:0 }', '<p>no table here</p>');
    assert(!/reader's chip/.test(notable.stdout + notable.stderr),
      'a document with no table must not be asked to reset cells');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('tdoc default-template validator accepts scoped widget CSS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-template-'));
  try {
    const html = path.join(dir, 'valid.html');
    fs.writeFileSync(html, `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background: #fff; } .cost-widget { display:grid } .cost-widget p { color:#333 }</style>
      </head><body><div class="wrap"><h1>Title</h1><div class="cost-widget"><p>x</p></div></div></body></html>`);
    const r = spawnSync(path.join(BIN, 'tdoc-validate-template'), [html], { encoding: 'utf8' });
    assert(r.status === 0, `valid default-template HTML rejected: ${r.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('validator rejects content that escapes the content root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-root-'));
  const run = (name, body) => {
    const html = path.join(dir, name);
    fs.writeFileSync(html, `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background: #fff; }</style>
      </head><body>${body}</body></html>`);
    return spawnSync(path.join(BIN, 'tdoc-validate-template'), [html], { encoding: 'utf8' });
  };
  try {
    // One stray </div> closes .wrap early and the rest of the document becomes a
    // sibling of it. Every check still passes — the doc has a content root, its
    // CSS is in contract — but the reading column stops applying and the page
    // renders full-bleed. Only the nesting shows it.
    const escaped = run('escaped.html',
      '<div class="wrap"><h1>T</h1><div class="tiles"><div class="tile">n</div></div></div>' +
      '<h2>Everything after this is outside</h2><p>and loses the column</p>');
    assert(escaped.status !== 0, 'content outside the root should be rejected');
    assert(/outside the content root/.test(escaped.stderr), escaped.stderr);

    const nested = run('nested.html',
      '<div class="wrap"><h1>T</h1><div class="tiles"><div class="tile">n</div></div>' +
      '<h2>Still inside</h2><p>keeps the column</p></div>');
    assert(nested.status === 0, `correctly nested doc rejected: ${nested.stderr}`);

    // <script>/<style> at body level are not content and must not trip it
    const scripts = run('scripts.html',
      '<div class="wrap"><h1>T</h1></div><template id="x"></template>');
    assert(scripts.status === 0, `template beside the root should pass: ${scripts.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('validator rejects a figure whose ink floats inside its own viewBox', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-viewbox-'));
  const page = (svg) => `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background: #fff; }</style>
      </head><body><div class="wrap"><h1>Title</h1>${svg}</div></body></html>`;
  const run = (name, svg) => {
    const html = path.join(dir, name);
    fs.writeFileSync(html, page(svg));
    return spawnSync(path.join(BIN, 'tdoc-validate-template'), [html], { encoding: 'utf8' });
  };
  try {
    // ink spans x=34..86 in a 120-wide box: 28% of the width wasted each side,
    // which reads as an indent against every paragraph on the page
    const padded = run('padded.html',
      '<svg viewBox="0 0 120 64" aria-label="Padded"><rect x="34" y="8" width="52" height="48"/></svg>');
    assert(padded.status !== 0, 'baked viewBox padding should be rejected');
    assert(/inside its own viewBox/.test(padded.stderr), padded.stderr);

    // same drawing, viewBox set to its bounds
    const flush = run('flush.html',
      '<svg viewBox="0 0 120 64" aria-label="Flush"><rect x="6" y="8" width="108" height="48"/></svg>');
    assert(flush.status === 0, `flush figure rejected: ${flush.stderr}`);

    // a non-zero viewBox origin is the documented way to tighten a drawing,
    // so the offset must be measured against min-x rather than assumed zero
    const shifted = run('shifted.html',
      '<svg viewBox="12 4 696 215" aria-label="Shifted"><rect x="14" y="6" width="692" height="210"/></svg>');
    assert(shifted.status === 0, `tightened viewBox rejected: ${shifted.stderr}`);

    // geometry inside a <path> is not parseable here, so those figures opt out
    // rather than being failed on a guess
    const opaque = run('opaque.html',
      '<svg viewBox="0 0 120 64" aria-label="Path"><path d="M34,8 L86,56"/><rect x="34" y="8" width="52" height="48"/></svg>');
    assert(opaque.status === 0, `figure containing <path> should skip the inset check: ${opaque.stderr}`);

    // clipping is a different fault and must still be caught
    const overflow = run('overflow.html',
      '<svg viewBox="0 0 120 64" aria-label="Over"><rect x="6" y="8" width="160" height="20"/></svg>');
    assert(overflow.status !== 0, 'overflow check regressed');
    assert(/overflows its viewBox/.test(overflow.stderr), overflow.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('tdoc default-template validator rejects global restyling by default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-template-'));
  try {
    const html = path.join(dir, 'custom.html');
    fs.writeFileSync(html, `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background: #fff; } h1 { font-size:72px } .wrap { max-width:1200px }</style>
      </head><body><div class="wrap"><h1>Title</h1></div></body></html>`);
    const rejected = spawnSync(path.join(BIN, 'tdoc-validate-template'), [html], { encoding: 'utf8' });
    assert(rejected.status !== 0, 'global h1/.wrap restyling should be rejected');
    assert(/default template/i.test(rejected.stderr), rejected.stderr);
    const explicit = spawnSync(path.join(BIN, 'tdoc-validate-template'), [html, '--custom-template'], { encoding: 'utf8' });
    assert(explicit.status === 0, `explicit custom template should pass: ${explicit.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('tdoc host validator rejects inert JavaScript even for a custom template', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-host-js-'));
  try {
    const html = path.join(dir, 'broken.html');
    fs.writeFileSync(html, `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background:#fff }</style></head>
      <body><div class="wrap"><button onclick="go()">Run</button>
      <a href="javascript:go()">again</a><canvas></canvas><script>go()</script></div></body></html>`);
    const r = spawnSync(path.join(BIN, 'tdoc-validate-template'),
      [html, '--custom-template'], { encoding: 'utf8' });
    assert(r.status !== 0, 'custom-template must not make host JavaScript executable');
    assert(/host <script> is inert/.test(r.stderr), r.stderr);
    assert(/event handlers are inert/.test(r.stderr), r.stderr);
    assert(/javascript: URLs are inert/.test(r.stderr), r.stderr);
    assert(/host <canvas> cannot render/.test(r.stderr), r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('tdoc host validator accepts the named editorial house-style background', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-style-'));
  try {
    const html = path.join(dir, 'editorial.html');
    fs.writeFileSync(html, `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background:#f7f6f5 } .wrap { font-family:Georgia,serif; color:#000 }</style>
      </head><body><div class="wrap"><h1>Title</h1></div></body></html>`);
    // A ground that belongs to another house style is a taste mismatch, not a
    // rendering fault: it is reported as a note and the document still stands.
    // --strict is how a caller that wants house conformance enforced asks.
    const wrong = spawnSync(path.join(BIN, 'tdoc-validate-template'), [html], { encoding: 'utf8' });
    assert(wrong.status === 0, `editorial background should pass as a note: ${wrong.stderr}`);
    assert(/house-style note/.test(wrong.stderr), `expected a house-style note, got: ${wrong.stderr}`);
    const strict = spawnSync(path.join(BIN, 'tdoc-validate-template'), [html, '--strict'], { encoding: 'utf8' });
    assert(strict.status !== 0, '--strict should fail on a house-style note');
    const right = spawnSync(path.join(BIN, 'tdoc-validate-template'),
      [html, '--style', 'editorial'], { encoding: 'utf8' });
    assert(right.status === 0, right.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('tdoc-new copies sandboxed widget files while keeping host HTML script-free', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-widget-new-'));
  try {
    const fakeBin = path.join(dir, 'fake-bin');
    const widgets = path.join(dir, 'widgets');
    fs.mkdirSync(fakeBin);
    fs.mkdirSync(widgets);
    const fakeCurl = path.join(fakeBin, 'curl');
    fs.writeFileSync(fakeCurl, '#!/bin/sh\nprintf \'{"service":"tdoc"}\'\n');
    fs.chmodSync(fakeCurl, 0o755);
    fs.writeFileSync(path.join(widgets, 'calculator.html'),
      '<!doctype html><html><body><output id="x"></output><script>document.querySelector("#x").textContent="ok"</script></body></html>');
    const host = `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background:#fff }</style></head><body><div class="wrap">
      <h1>Calculator</h1><iframe sandbox="allow-scripts" src="/d/widget-doc/v/1/widget/calculator"></iframe>
      </div></body></html>`;
    const env = { ...process.env, HOME: dir, TDOC_DIR: path.join(dir, 'tdocs'),
      PATH: `${fakeBin}:${process.env.PATH}` };
    const r = spawnSync(path.join(BIN, 'tdoc-new'),
      ['--slug', 'widget-doc', '--title', 'Widget', '--html-stdin', '--widgets-dir', widgets, '--quiet'],
      { input: host, env, encoding: 'utf8', timeout: 20000 });
    assert(r.status === 0, `tdoc-new widget handoff failed (exit ${r.status})\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    const copied = fs.readFileSync(path.join(dir, 'tdocs', 'widget-doc', 'v1', 'widgets', 'calculator.html'), 'utf8');
    assert(copied.includes('<script>'), 'widget JavaScript was not preserved in the island file');
    const savedHost = fs.readFileSync(path.join(dir, 'tdocs', 'widget-doc', 'v1', 'index.html'), 'utf8');
    assert(!savedHost.includes('<script>'), 'host unexpectedly gained JavaScript');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

t('tdoc-new validates the default template before replacing an existing doc', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-cli-'));
  try {
    const env = { ...process.env, TDOC_DIR: dir, TDOC_PORT: '0' };
    const docDir = path.join(dir, 'mydoc');
    fs.mkdirSync(path.join(docDir, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(docDir, 'v1', 'index.html'), '<!doctype html><body>ORIGINAL</body>');
    fs.writeFileSync(path.join(docDir, 'meta.json'), JSON.stringify({ slug: 'mydoc', versions: [{ n: 1 }] }));
    fs.writeFileSync(path.join(docDir, 'comments.json'), JSON.stringify([{ id: 'c1', text: 'precious' }]));
    // Host JavaScript is inert under CSP, so this is a contract failure rather
    // than a house-style note — the stage-validate-swap guard must refuse it
    // and leave the existing document and its comments untouched.
    const custom = `<!doctype html><html><head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>body { background:#fff }</style>
      </head><body><div class="wrap"><h1>Custom</h1><script>1</script></div></body></html>`;
    const r = spawnSync(path.join(BIN, 'tdoc-new'),
      ['--slug', 'mydoc', '--title', 'x', '--html-stdin', '--force'],
      { input: custom, env, encoding: 'utf8', timeout: 20000 });
    assert(r.status !== 0 && /default-template validation failed/i.test(r.stderr), r.stderr);
    assert(/ORIGINAL/.test(fs.readFileSync(path.join(docDir, 'v1', 'index.html'), 'utf8')),
      'existing doc was replaced before template validation');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- live behavior: --force must not destroy an existing doc on bad input ----
t('tdoc-new --force preserves the existing doc when new HTML is INVALID [the bug]', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-cli-'));
  try {
    const env = { ...process.env, TDOC_DIR: dir, TDOC_PORT: '0', TDOC_SKIP_UPDATE_CHECK: '1' };
    // seed an existing doc with a real comment we must not lose
    const docDir = path.join(dir, 'mydoc');
    fs.mkdirSync(path.join(docDir, 'v1'), { recursive: true });
    fs.writeFileSync(path.join(docDir, 'v1', 'index.html'), '<!doctype html><body>ORIGINAL</body>');
    fs.writeFileSync(path.join(docDir, 'meta.json'), JSON.stringify({ slug: 'mydoc', versions: [{ n: 1 }] }));
    fs.writeFileSync(path.join(docDir, 'comments.json'), JSON.stringify([{ id: 'c1', text: 'precious' }]));

    // run --force with MARKDOWN (no <body>) on stdin → must be rejected
    const r = spawnSync(path.join(BIN, 'tdoc-new'),
      ['--slug', 'mydoc', '--title', 'x', '--html-stdin', '--force'],
      { input: '# just markdown, no body tag', env, encoding: 'utf8', timeout: 20000 });

    assert(r.status !== 0, 'tdoc-new should have FAILED on markdown input');
    // the original doc + comment must still be intact
    const html = fs.readFileSync(path.join(docDir, 'v1', 'index.html'), 'utf8');
    assert(/ORIGINAL/.test(html), 'original HTML was destroyed by --force on invalid input!');
    const comments = JSON.parse(fs.readFileSync(path.join(docDir, 'comments.json'), 'utf8'));
    assert(comments[0] && comments[0].text === 'precious', 'comments were destroyed!');
    // and no stray stage dirs left behind
    const stray = fs.readdirSync(dir).filter(n => n.startsWith('.stage-'));
    assert(stray.length === 0, `stage dir not cleaned up: ${stray}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- slug validation (audit: path traversal via unvalidated slug) ----
// tdoc-publish/pull/unpublish used $SLUG in filesystem paths and curl URLs
// without validation, so a `..` slug escaped TDOC_DIR. Each must now reject a
// non-kebab-case slug BEFORE any side effect.
t('publish/pull/unpublish reject traversal + non-kebab slugs', () => {
  const env = { ...process.env, TDOC_DIR: '/tmp/tdoc-slugtest-nonexistent', HOME: '/tmp/tdoc-slugtest-home', TDOC_SKIP_UPDATE_CHECK: '1' };
  const bad = ['../private', 'a/../b', 'UPPER', 'has space', 'trailing-', '-leading', 'with/slash'];
  for (const cli of ['tdoc-publish', 'tdoc-pull', 'tdoc-unpublish']) {
    for (const slug of bad) {
      const r = spawnSync(path.join(BIN, cli), [slug], { env, encoding: 'utf8', timeout: 15000 });
      assert(r.status !== 0, `${cli} accepted bad slug '${slug}' (exit 0)`);
      assert(/invalid slug/i.test(r.stderr || ''), `${cli} '${slug}': expected 'invalid slug' rejection, got stderr: ${r.stderr}`);
    }
  }
});

t('tdoc-agent-reply --print-identity detects host runtime from env', () => {
  const bin = path.join(BIN, 'tdoc-agent-reply');
  const base = { ...process.env, HOME: '/tmp/tdoc-no-home-' + Date.now() };
  for (const k of Object.keys(base)) {
    if (/^(GROK_|CLAUDE_|CLAUDECODE$|CODEX_|CURSOR_|COMPOSER_|GEMINI_|XAI_|TDOC_AGENT_)/.test(k)) delete base[k];
  }
  const run = (extra) => spawnSync(bin, ['--print-identity'], {
    env: { ...base, ...extra }, encoding: 'utf8', timeout: 10000,
  });
  const grok = run({ GROK_SESSION_ID: 'sess' });
  assert(grok.status === 0, `grok exit ${grok.status} ${grok.stderr}`);
  assert(/"login":"grok"/.test(grok.stdout) && /"name":"Grok"/.test(grok.stdout), grok.stdout);

  const claude = run({ CLAUDE_SESSION_ID: 'sess' });
  assert(/"login":"claude"/.test(claude.stdout), claude.stdout);

  const codex = run({ CODEX_CLI: '1' });
  assert(/"login":"codex"/.test(codex.stdout), codex.stdout);

  const empty = run({});
  assert(/"login":"tdoc-agent"/.test(empty.stdout), empty.stdout);

  const override = spawnSync(bin, ['--print-identity', '--login', 'claude'], {
    env: { ...base, GROK_SESSION_ID: 'sess' }, encoding: 'utf8', timeout: 10000,
  });
  assert(/"login":"claude"/.test(override.stdout), `explicit --login should win: ${override.stdout}`);
});

t('publish accepts a valid kebab-case slug (passes validation, fails later on missing doc)', () => {
  const env = { ...process.env, TDOC_DIR: '/tmp/tdoc-slugtest-nonexistent', TDOC_SKIP_UPDATE_CHECK: '1' };
  const r = spawnSync(path.join(BIN, 'tdoc-publish'), ['valid-slug-123'], { env, encoding: 'utf8', timeout: 15000 });
  // It should get PAST slug validation (no 'invalid slug') and fail on the
  // missing doc instead — proving valid slugs aren't over-rejected.
  assert(!/invalid slug/i.test(r.stderr || ''), `valid slug was wrongly rejected: ${r.stderr}`);
});

t('user-facing CLIs invoke tdoc-update-nag', () => {
  for (const f of ['tdoc-publish', 'tdoc-pull', 'tdoc-unpublish', 'tdoc-new', 'tdoc-doctor']) {
    const src = readBin(f);
    assert(/tdoc-update-nag/.test(src), `${f} must call tdoc-update-nag so BYOK users see origin/main drift`);
  }
  assert(!/tdoc-update-nag/.test(readBin('tdoc-update')),
    'tdoc-update must not nag (it IS the update)');
});

t('tdoc-update-nag is silent when skipped or current (mock: skip)', () => {
  const nag = path.join(BIN, 'tdoc-update-nag');
  const r = spawnSync(nag, [], { env: { ...process.env, TDOC_SKIP_UPDATE_CHECK: '1' }, encoding: 'utf8' });
  assert(r.status === 0, `skip path must exit 0, got ${r.status}`);
  assert(!r.stdout, `skip path must be silent on stdout, got: ${r.stdout}`);
  assert(!r.stderr, `skip path must be silent on stderr, got: ${r.stderr}`);
});

t('tdoc-update-nag prints TDOC_UPDATE_AVAILABLE when behind (mock)', () => {
  const nag = path.join(BIN, 'tdoc-update-nag');
  const r = spawnSync(nag, [], { env: { ...process.env, TDOC_MOCK_UPDATE_BEHIND: '3' }, encoding: 'utf8' });
  assert(r.status === 0, `behind path must exit 0, got ${r.status}`);
  assert(/TDOC_UPDATE_AVAILABLE: 3/.test(r.stdout), `stdout machine line missing: ${r.stdout}`);
  assert(/tdoc-update --yes/.test(r.stderr), `stderr must encourage tdoc-update --yes, got: ${r.stderr}`);
  assert(/3 newer commit/.test(r.stderr), `stderr must mention commit count, got: ${r.stderr}`);
});

t('tdoc-update-nag --json is parseable', () => {
  const nag = path.join(BIN, 'tdoc-update-nag');
  const r = spawnSync(nag, ['--json'], { env: { ...process.env, TDOC_MOCK_UPDATE_BEHIND: '2' }, encoding: 'utf8' });
  assert(r.status === 0, `json path must exit 0, got ${r.status}`);
  const j = JSON.parse(r.stdout);
  assert(j.ok === false && j.behind === 2 && j.checked === true, `json body: ${r.stdout}`);
  assert(/tdoc-update --yes/.test(j.cmd), `cmd should be tdoc-update --yes: ${j.cmd}`);
});

t('tdoc-doctor --json preserves the machine report contract', () => {
  const doctor = path.join(BIN, 'tdoc-doctor');
  const r = spawnSync(doctor, ['--json'], {
    env: {
      ...process.env,
      TDOC_MOCK_UPDATE_BEHIND: '2',
      TDOC_MOCK_NO_WRANGLER: '1',
      TDOC_MOCK_NO_GH: '1',
      TDOC_MOCK_NOT_PUBLISHED: '1',
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert(r.status === 0, `doctor must exit 0, got ${r.status}: ${r.stderr}`);
  const j = JSON.parse(r.stdout);
  assert(j.update && j.update.ok === false && j.update.behind === 2, `update: ${JSON.stringify(j.update)}`);
  assert(Array.isArray(j.missing_steps), 'rest of doctor JSON must still be valid');
  assert(!j.missing_steps.some((s) => s.id === 'update'), '.update is not a missing_step');
});

t('tdoc-doctor defaults to a concise target, readiness, and next-action summary', () => {
  const doctor = path.join(BIN, 'tdoc-doctor');
  const r = spawnSync(doctor, [], {
    env: {
      ...process.env,
      TDOC_SKIP_UPDATE_CHECK: '1',
      TDOC_MOCK_NOT_PUBLISHED: '1',
      TDOC_PLATFORM: 'hosted',
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  assert(r.status === 0, `doctor must exit 0, got ${r.status}: ${r.stderr}`);
  assert(/^tdoc doctor$/m.test(r.stdout), `summary title missing: ${r.stdout}`);
  assert(/^Target\s+Hosted · tdoc\.dev$/m.test(r.stdout), `target missing: ${r.stdout}`);
  assert(/^Readiness\s+Ready to publish$/m.test(r.stdout), `readiness missing: ${r.stdout}`);
  assert(/^Next$/m.test(r.stdout) && /\/tdoc new <prompt>/.test(r.stdout),
    `next action missing: ${r.stdout}`);
  assert(!/"deps"|"cloudflare"|\{\s*$/.test(r.stdout), `default still looks like a JSON dump: ${r.stdout}`);
});

t('tdoc-update-nag diverged mock does not tell the user to --yes', () => {
  const nag = path.join(BIN, 'tdoc-update-nag');
  const r = spawnSync(nag, [], { env: { ...process.env, TDOC_MOCK_UPDATE_DIVERGED: '1' }, encoding: 'utf8' });
  assert(r.status === 0);
  assert(/TDOC_UPDATE_DIVERGED/.test(r.stdout), `stdout: ${r.stdout}`);
  assert(/cannot fast-forward/.test(r.stderr), `stderr: ${r.stderr}`);
  assert(/re-clone from scratch/.test(r.stderr), `stderr: ${r.stderr}`);
  assert(!/--yes/.test(r.stderr), 'diverged nag must not recommend --yes');
  assert(!/rm -rf/.test(r.stderr + r.stdout), 'diverged nag must not print a destroy/re-clone command');
});

t('tdoc-new --help/--quiet stay silent; otherwise nag stays off stdout', () => {
  const bin = path.join(BIN, 'tdoc-new');
  const env = { ...process.env, TDOC_MOCK_UPDATE_BEHIND: '3' };
  const help = spawnSync(bin, ['--help'], { env, encoding: 'utf8' });
  assert(help.status === 0);
  assert(!/TDOC_UPDATE|newer commit/.test(help.stdout + help.stderr), `help leaked nag: ${help.stdout}${help.stderr}`);
  const quiet = spawnSync(bin, ['--quiet'], { env, encoding: 'utf8' });
  assert(!/TDOC_UPDATE|newer commit/.test(quiet.stdout + quiet.stderr), `quiet leaked nag: ${quiet.stdout}${quiet.stderr}`);
  const noisy = spawnSync(bin, [], { env, encoding: 'utf8' });
  assert(/newer commit/.test(noisy.stderr), `stderr must nag: ${noisy.stderr}`);
  assert(!/TDOC_UPDATE_AVAILABLE/.test(noisy.stdout), `stdout must stay URL-only, got: ${noisy.stdout}`);
});

function gitIn(cwd, args) {
  return execFileSync('git', [
    '-c', 'commit.gpgsign=false',
    '-c', 'user.name=tdoc-test',
    '-c', 'user.email=tdoc-test@example.com',
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function commitFile(cwd, name, contents, msg) {
  fs.writeFileSync(path.join(cwd, name), contents);
  gitIn(cwd, ['add', name]);
  gitIn(cwd, ['commit', '-m', msg]);
}

// Real git graph (not TDOC_MOCK_*): copy nag into a throwaway checkout so
// `dirname $0/..` is the fixture, then fetch against a local bare origin.
function makeNagRepo(kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-nag-'));
  const bare = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  fs.mkdirSync(work);
  gitIn(work, ['init', '-b', 'main']);
  commitFile(work, 'README', 'base\n', 'base');
  gitIn(work, ['remote', 'add', 'origin', bare]);
  gitIn(work, ['push', '-u', 'origin', 'main']);
  if (kind === 'ahead' || kind === 'diverged') {
    commitFile(work, 'feat', 'ahead\n', 'ahead');
  }
  if (kind === 'behind' || kind === 'diverged') {
    const other = path.join(root, 'other');
    gitIn(root, ['clone', bare, other]);
    commitFile(other, 'mainline', 'on main\n', 'on main');
    gitIn(other, ['push', 'origin', 'main']);
  }
  const binDir = path.join(work, 'bin');
  fs.mkdirSync(binDir);
  const nag = path.join(binDir, 'tdoc-update-nag');
  fs.copyFileSync(path.join(BIN, 'tdoc-update-nag'), nag);
  fs.chmodSync(nag, 0o755);
  return { root, nag };
}

t('tdoc-update-nag real git: ahead-only is silent, behind nags, both diverge', () => {
  const cases = [
    { kind: 'ahead', want: 'silent' },
    { kind: 'behind', want: 'available' },
    { kind: 'diverged', want: 'diverged' },
  ];
  for (const { kind, want } of cases) {
    const { root, nag } = makeNagRepo(kind);
    try {
      const r = spawnSync(nag, [], { encoding: 'utf8', timeout: 15000 });
      assert(r.status === 0, `${kind}: exit ${r.status} stderr=${r.stderr}`);
      if (want === 'silent') {
        assert(!r.stdout, `${kind} stdout: ${r.stdout}`);
        assert(!r.stderr, `${kind} stderr: ${r.stderr}`);
      } else if (want === 'available') {
        assert(/TDOC_UPDATE_AVAILABLE/.test(r.stdout), `${kind} stdout: ${r.stdout}`);
        assert(/tdoc-update --yes/.test(r.stderr), `${kind} stderr: ${r.stderr}`);
        assert(!/DIVERGED/.test(r.stdout));
      } else {
        assert(/TDOC_UPDATE_DIVERGED/.test(r.stdout), `${kind} stdout: ${r.stdout}`);
        assert(/cannot fast-forward/.test(r.stderr), `${kind} stderr: ${r.stderr}`);
        assert(!/--yes/.test(r.stderr));
        assert(!/rm -rf/.test(r.stderr + r.stdout));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

// ---- tdoc-agent-reply must not report success on a rejected reply (#141) ----

t('tdoc-agent-reply gates on HTTP status and on 200-with-error bodies', () => {
  const src = readBin('tdoc-agent-reply');
  assert(/post_reply\(\)/.test(src), 'post_reply helper missing');
  assert(/http_code/.test(src) && /grep -qE '\^2/.test(src),
    'post_reply does not gate on 2xx HTTP status');
  assert(/json_error/.test(src),
    'post_reply does not reject a 200 body carrying an "error" key');
  // Both transports must go through the helper and propagate its failure.
  const calls = src.split('\n').filter(l => /^\s*post_reply /.test(l));
  assert(calls.length === 2, `expected 2 post_reply call sites, got ${calls.length}`);
  for (const c of calls) assert(/\|\| exit 1/.test(c), `call site swallows failure: ${c.trim()}`);
  // No raw curl POST to the reply endpoint left outside the helper.
  const raw = src.split('\n').filter(l =>
    /\bcurl\b/.test(l) && /api\/agent\/reply/.test(l) && !l.trim().startsWith('#'));
  assert(raw.length === 0, `raw curl to /api/agent/reply outside post_reply:\n      ${raw.join('\n      ')}`);
});

t('tdoc-agent-reply exits non-zero when the server rejects the reply', () => {
  const bin = path.join(BIN, 'tdoc-agent-reply');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-reply-home-'));
  const port = 7900 + Math.floor(Math.random() * 300);
  // Stub the reply endpoint: 200 with an error body, exactly what the server
  // returns for an unknown parent. That is the case the bug reported.
  const stub = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>{` +
    `s.writeHead(200,{'content-type':'application/json'});` +
    `s.end(JSON.stringify({error:'parent_not_found'}));` +
    `}).listen(${port},'127.0.0.1');`], { stdio: 'ignore' });
  try {
    const up = spawnSync('bash', ['-c',
      `for i in $(seq 1 100); do curl -sS -o /dev/null --max-time 1 ` +
      `-X POST http://127.0.0.1:${port}/ping && exit 0; sleep 0.05; done; exit 1`],
      { encoding: 'utf8', timeout: 15000 });
    assert(up.status === 0, 'stub server never came up');

    const r = spawnSync(bin, ['--slug', 'tornado-doc', '--parent', 'c_missing',
      '--text', 'applied', '--status', 'applied'], {
      env: { ...process.env, HOME: home, TDOC_PORT: String(port) },
      encoding: 'utf8', timeout: 20000,
    });
    assert(r.status !== 0,
      `rejected reply still exited ${r.status}; stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/parent_not_found/.test(r.stdout + r.stderr),
      `server error not surfaced: ${r.stdout} ${r.stderr}`);
    assert(/NOT posted/.test(r.stderr), `no failure line on stderr: ${r.stderr}`);
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('tdoc-agent-reply still exits 0 when the reply is accepted', () => {
  const bin = path.join(BIN, 'tdoc-agent-reply');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-reply-home-'));
  const port = 8300 + Math.floor(Math.random() * 300);
  const stub = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>{` +
    `s.writeHead(200,{'content-type':'application/json'});` +
    `s.end(JSON.stringify({id:'c_1',replies:[],reactions:{}}));` +
    `}).listen(${port},'127.0.0.1');`], { stdio: 'ignore' });
  try {
    const up = spawnSync('bash', ['-c',
      `for i in $(seq 1 100); do curl -sS -o /dev/null --max-time 1 ` +
      `-X POST http://127.0.0.1:${port}/ping && exit 0; sleep 0.05; done; exit 1`],
      { encoding: 'utf8', timeout: 15000 });
    assert(up.status === 0, 'stub server never came up');

    const r = spawnSync(bin, ['--slug', 'tornado-doc', '--parent', 'c_1', '--text', 'ok'], {
      env: { ...process.env, HOME: home, TDOC_PORT: String(port) },
      encoding: 'utf8', timeout: 20000,
    });
    assert(r.status === 0, `accepted reply exited ${r.status}; stderr=${r.stderr}`);
    assert(/"id":"c_1"/.test(r.stdout), `server body not passed through: ${r.stdout}`);
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});


// ---- tdoc-agent-reply must resolve the hosted base from .base (#226) ----
// Before the fix, `platform: "hosted"` fell into the cloudflare branch and read
// absent .subdomain/.worker, producing https://null.null.workers.dev -> 404.

t('tdoc-agent-reply posts to .base on a hosted config', () => {
  const bin = path.join(BIN, 'tdoc-agent-reply');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-reply-hosted-'));
  const port = 8700 + Math.floor(Math.random() * 300);
  fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
  // A real hosted config: .base and .upload_token, and deliberately NO
  // .subdomain / .worker — that absence is what the bug tripped over.
  fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({
    platform: 'hosted',
    base: `http://127.0.0.1:${port}`,
    public_host: '127.0.0.1',
    upload_token: 'tok_test',
  }));
  // Record the path the reply actually arrives on, so a request that never
  // leaves for the right host cannot pass.
  const stub = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>{` +
    `s.writeHead(200,{'content-type':'application/json'});` +
    `s.end(JSON.stringify({id:'c_hosted',path:q.url,replies:[],reactions:{}}));` +
    `}).listen(${port},'127.0.0.1');`], { stdio: 'ignore' });
  try {
    const up = spawnSync('bash', ['-c',
      `for i in $(seq 1 100); do curl -sS -o /dev/null --max-time 1 ` +
      `-X POST http://127.0.0.1:${port}/ping && exit 0; sleep 0.05; done; exit 1`],
      { encoding: 'utf8', timeout: 15000 });
    assert(up.status === 0, 'stub server never came up');

    const r = spawnSync(bin, ['--slug', 'tornado-doc', '--parent', 'c_1', '--text', 'ok'], {
      env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20000,
    });
    assert(r.status === 0, `hosted reply exited ${r.status}; stderr=${r.stderr}`);
    assert(/"id":"c_hosted"/.test(r.stdout),
      `reply did not reach the hosted base: stdout=${r.stdout} stderr=${r.stderr}`);
    assert(/"path":"\/api\/agent\/reply"/.test(r.stdout),
      `reply hit the wrong path: ${r.stdout}`);
    assert(!/workers\.dev/.test(r.stdout + r.stderr),
      `hosted config still derived a workers.dev host: ${r.stderr}`);
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('tdoc-agent-reply base resolution matches tdoc-pull across platforms', () => {
  const src = readBin('tdoc-agent-reply');
  // hosted and vercel both read .base; cloudflare/legacy still derive workers.dev.
  assert(/\[ "\$PLATFORM" = "hosted" \] \|\| \[ "\$PLATFORM" = "vercel" \]/.test(src),
    'hosted is not on the .base side of the platform branch');
  assert(/BASE="https:\/\/\$\{WORKER\}\.\$\{SUBDOMAIN\}\.workers\.dev"/.test(src),
    'cloudflare no longer derives the workers.dev base');
  assert(/PLATFORM="\$\{PLATFORM:-cloudflare\}"/.test(src),
    'legacy configs without .platform no longer default to cloudflare');
});

t('a legacy config with no .platform still resolves a workers.dev base', () => {
  // The grep above says the default is written down; this says it survives a
  // real run. #272's lesson: a claim tested by reading the source is a claim
  // about the source, not about what the command does.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-legacy-'));
  try {
    fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
    // No `platform` key at all — the shape configs had before hosted existed.
    fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({
      subdomain: 'acme', worker: 'tdoc', upload_token: 'tok',
    }));
    const r = spawnSync(path.join(BIN, 'tdoc-agent-reply'), [
      '--slug', 'legacy-doc', '--parent', 'c1', '--text', 'hi',
    ], {
      env: { ...process.env, HOME: home, TDOC_SKIP_UPDATE_CHECK: '1' },
      encoding: 'utf8', timeout: 60000,
    });
    // acme is not a real subdomain, so this cannot succeed. What matters is
    // WHICH host it tried: the legacy derivation, not localhost and not "null".
    const out = r.stdout + r.stderr;
    assert(/tdoc\.acme\.workers\.dev/.test(out),
      `legacy config did not derive workers.dev:\n      ${out.trim()}`);
    assert(!/null\.null/.test(out), `a missing field leaked as "null":\n      ${out.trim()}`);
    assert(!/localhost/.test(out), `fell through to localhost instead:\n      ${out.trim()}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('a hosted config missing .base falls through to localhost, not to "null"', () => {
  // json_file_get returns empty for both a missing key and an explicit null,
  // which is what the old `// empty` filters guaranteed. If that ever changed,
  // BASE would be the string "null" and every reply would 404 on
  // https://null — the #226 bug, wearing a different hat.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-nullbase-'));
  try {
    fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
    fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({
      platform: 'hosted', base: null, upload_token: 'tok',
    }));
    const r = spawnSync(path.join(BIN, 'tdoc-agent-reply'), [
      '--slug', 'nullbase-doc', '--parent', 'c1', '--text', 'hi',
    ], {
      env: { ...process.env, HOME: home, TDOC_SKIP_UPDATE_CHECK: '1', TDOC_PORT: '7999' },
      encoding: 'utf8', timeout: 60000,
    });
    const out = r.stdout + r.stderr;
    assert(/localhost:7999/.test(out),
      `an unusable base should fall through to local, got:\n      ${out.trim()}`);
    assert(!/https:\/\/null/.test(out), `"null" was used as a host:\n      ${out.trim()}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});


// ---- publish-first flow (S4): sign-in ahead of generation, no stray localhost ----

t('tdoc-publish --signin-only needs no slug and no-ops when already signed in', () => {
  const bin = path.join(BIN, 'tdoc-publish');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-signin-'));
  try {
    fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
    fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({
      platform: 'hosted', base: 'https://tdoc.dev', upload_token: 'tok',
    }));
    const r = spawnSync(bin, ['--signin-only'], {
      env: { ...process.env, HOME: home }, encoding: 'utf8', timeout: 20000,
    });
    assert(r.status === 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
    assert(/already signed in/.test(r.stderr), `expected a no-op message, got: ${r.stderr}`);
    // It must not have printed usage — --signin-only takes no slug.
    assert(!/usage:/i.test(r.stdout + r.stderr), 'usage printed for --signin-only');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('a normal publish still requires a slug', () => {
  const r = spawnSync(path.join(BIN, 'tdoc-publish'), [], { encoding: 'utf8', timeout: 20000 });
  assert(r.status !== 0, 'publish with no slug must not succeed');
});

t('the GitHub sign-in opens the browser and is NOT gated on a tty', () => {
  const src = readBin('tdoc-publish');
  assert(/should_open_browser\(\)/.test(src), 'no browser-open helper');
  // An agent runs this with stderr piped. A tty check would mean the auto-open
  // never fires in the exact situation it exists for.
  const helperStart = src.indexOf('should_open_browser()');
  const helper = src.slice(helperStart, src.indexOf('write_pending_signin "$user_code"', helperStart));
  assert(!/-t\s+2|-t\s+1/.test(helper), 'browser-open must not be gated on a tty');
  for (const guard of ['TDOC_NO_BROWSER', 'CI', 'SSH_CONNECTION']) {
    assert(helper.includes(guard), `browser-open should respect ${guard}`);
  }
  // Only ever hand a github.com URL to the opener.
  assert(/case "\$uri" in\s*\n\s*https:\/\/github\.com\/\*\)/.test(src),
    'the opener must be restricted to github.com URLs');
});

t('bin/tdoc-new still defaults to NOT publishing', () => {
  // /document-release, /retro, /investigate, /cso and /qa-only all call this.
  // If the publish-by-default flip leaked here, every security audit and retro
  // would auto-upload to tdoc.dev.
  const src = readBin('tdoc-new');
  assert(/^PUBLISH=0$/m.test(src), 'tdoc-new must default PUBLISH=0');
  assert(/--publish\)\s*PUBLISH=1/.test(src), '--publish must remain the opt-in');
});

t('the handoff line does not claim a plain publish is unlisted', () => {
  // A publish with no flags stores no access block and takes the legacy
  // policy (public + full history). Telling the user "unlisted" would
  // understate what a recipient can see. Keeping the default as-is is a
  // product decision (#245/#246 closed); the copy has to match it.
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const step = skill.slice(skill.indexOf('*Hosted (the default).*'), skill.indexOf('*Self-host.*'));
  assert(!/live and \*\*unlisted\*\*/.test(step), 'handoff still calls a plain publish unlisted');
  // The blockquote wraps, so match across the "> " continuation.
  assert(/page back[\s>]+through earlier versions/.test(step),
    'handoff should say earlier versions are reachable');
  assert(/--history owner/.test(step), 'handoff should point at the way to change it');
});

t('SKILL.md states the localhost rule and no longer promises localhost by default', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  assert(/never hand over a `localhost` URL unless the user asked/i.test(skill),
    'the localhost rule is not stated');
  // The delivery step must not open localhost unconditionally any more.
  assert(!/^7\. Open `http:\/\/localhost/m.test(skill),
    '/tdoc new still opens localhost as its delivery step');
  // Front matter must not advertise the abandoned default.
  const front = skill.slice(0, skill.indexOf('---', 4));
  assert(!/serve it at localhost/.test(front), 'description still says "serve it at localhost"');
  assert(!/own Cloudflare\s*\n?\s*Worker/.test(front), 'description still sells BYOK Cloudflare as the default');
  assert(/tdoc\.dev/.test(front), 'description should name the hosted destination');
});

t('SKILL.md and skills/tdoc/SKILL.md stay identical', () => {
  const root = path.join(__dirname, '..');
  const a = fs.readFileSync(path.join(root, 'SKILL.md'), 'utf8');
  const b = fs.readFileSync(path.join(root, 'skills', 'tdoc', 'SKILL.md'), 'utf8');
  assert(a === b, 'SKILL.md and its plugin-mode copy have drifted');
});


// ---- tdoc-update --auto: keep current without ever destroying work ----

t('tdoc-update defaults to the checkout that contains the invoked script', () => {
  const root = path.join(__dirname, '..');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-update-home-'));
  try {
    // A host-specific default such as ~/.claude/skills/tdoc would fail here:
    // fakeHome intentionally contains no parallel skill installation.
    const r = spawnSync(path.join(root, 'bin', 'tdoc-update'), ['--help'], {
      env: { ...process.env, HOME: fakeHome, SKILL_DIR: '' },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert(r.status === 0, `updater did not use its own checkout: ${r.stderr}`);
    assert(/usage: tdoc-update/.test(r.stdout), `unexpected updater output: ${r.stdout}`);
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
});

t('tdoc-update --auto never stashes and never redeploys', () => {
  const src = readBin('tdoc-update');
  assert(/--auto\)\s*AUTO=1/.test(src), '--auto flag missing');
  // The stash path is the one that can lose someone's edits.
  const stashIdx = src.indexOf('git stash push');
  const guardIdx = src.lastIndexOf('AUTO" = "1"', stashIdx);
  assert(guardIdx !== -1 && guardIdx < stashIdx,
    '--auto must bail out before the stash push');
  // Redeploy pushes to the user's own infrastructure.
  const redeployIdx = src.indexOf('bin/tdoc-publish');
  const exitIdx = src.lastIndexOf('AUTO" = "1"', redeployIdx);
  assert(exitIdx !== -1 && exitIdx < redeployIdx,
    '--auto must exit before the redeploy offer');
});

t('tdoc-update --auto declines on a diverged checkout', () => {
  const src = readBin('tdoc-update');
  assert(/LOCAL" != "\$BASE" \] && \[ "\$AUTO" = "1"/.test(src),
    '--auto must skip rather than fail on a diverged checkout');
});

t('SKILL.md probes for --auto before calling it', () => {
  // tdoc-update's arg loop has no catch-all: a version predating --auto would
  // ignore the flag and run the FULL interactive update, stashing local edits
  // on every skill run. The probe is what stops that.
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const call = skill.indexOf('bin/tdoc-update" --auto');
  assert(call !== -1, 'Step 0 should keep the skill current');
  const probe = skill.lastIndexOf("grep -q -- '--auto)'", call);
  assert(probe !== -1 && probe < call, 'the --auto call must be capability-probed');
  assert(skill.lastIndexOf('TDOC_SKIP_UPDATE_CHECK', call) !== -1,
    'there must be an off switch');
});

t('tdoc-update arg loop still has no catch-all (why the probe exists)', () => {
  // If this ever gains a `*)` that errors on unknown flags, the probe in
  // SKILL.md can be simplified — but until then it is load-bearing.
  const src = readBin('tdoc-update');
  const loop = src.slice(src.indexOf('for arg in "$@"'), src.indexOf('done', src.indexOf('for arg in "$@"')));
  assert(!/\*\)/.test(loop), 'arg loop gained a catch-all — revisit the SKILL.md probe');
});


// ---- hosted publish must not need jq (#256) ----

t('the hosted path uses no jq at all', () => {
  const src = readBin('tdoc-publish');
  // Everything hosted-reachable: the device flow, the token mint, the config
  // write and read, the upload payload, and the response parse.
  const hostedFns = [
    src.slice(src.indexOf('hosted_github_signin()'), src.indexOf('first_time_setup_hosted()')),
    src.slice(src.indexOf('first_time_setup_hosted()'), src.indexOf('require_jq_for_selfhost')),
    src.slice(src.indexOf('build_payload()'), src.indexOf('PLATFORM_FLAG=')),
  ].join('\n');
  const calls = hostedFns.split('\n').filter((l) => /\bjq\s+(-|["'$])/.test(l) && !l.trim().startsWith('#'));
  assert(calls.length === 0, `hosted path still shells out to jq:\n      ${calls.join('\n      ')}`);
});

t('jq is required for self-hosting, and only there', () => {
  const src = readBin('tdoc-publish');
  // No top-level hard fail any more — that turned a zero-setup path into an
  // install step on a machine that ships no jq.
  assert(!/^if ! command -v jq >\/dev\/null 2>&1; then$/m.test(src),
    'the global jq gate is back');
  assert(/require_jq_for_selfhost\(\)/.test(src), 'the self-host jq gate is missing');
  for (const fn of ['first_time_setup()', 'first_time_setup_vercel()']) {
    const i = src.indexOf(fn);
    assert(i !== -1, `${fn} not found`);
    const head = src.slice(i, i + 200);
    assert(/require_jq_for_selfhost/.test(head), `${fn} does not check for jq`);
  }
  // And the message must not send a hosted user to install anything.
  const msg = src.slice(src.indexOf('Self-hosting needs jq'), src.indexOf('Self-hosting needs jq') + 320);
  assert(/does not need it/.test(msg), 'the jq message should say hosted publishing is unaffected');
});

t('build_payload embeds the document without a shell round trip', () => {
  const src = readBin('tdoc-publish');
  const fn = src.slice(src.indexOf('build_payload()'), src.indexOf('PLATFORM_FLAG='));
  assert(/readFileSync\(htmlPath/.test(fn), 'the HTML must be read by node, not passed as an argument');
  assert(/JSON\.stringify\(out\)/.test(fn), 'the payload must be JSON-encoded by node');
  // Widgets and comments stay optional, the way the jq version had them.
  assert(/if \(commentsPath\)/.test(fn), 'comments must stay optional');
  assert(/Object\.keys\(widgets\)\.length/.test(fn), 'widgets must stay optional');
});

// ---- consent is asked after the work, not before it (#236 S9) ----

t('a first run defers the telemetry question and records nothing', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const step0 = skill.slice(skill.indexOf('## Step 0'), skill.indexOf('## Final Step'));

  // First run resolves to "deferred", not "on".
  // Checked as a line sequence rather than one regex. The regex version had
  // two alternatives matching the same input inside a star — exponential
  // backtracking, which CodeQL flagged as js/redos.
  const lines = step0.split('\n').map((l) => l.trim());
  const branch = lines.findIndex((l) => l.includes('TEL_PROMPTED" = "no" ]; then'));
  assert(branch !== -1, 'no first-run branch in the mode resolution');
  const body = lines.slice(branch + 1).filter((l) => l && !l.startsWith('#'));
  assert(body[0] === 'TEL_EFFECTIVE="deferred"',
    `a first run should resolve TEL_EFFECTIVE to deferred, got: ${body[0]}`);

  // And "deferred" must not slip through a `!= off` gate and write a sentinel.
  assert(!/TEL_EFFECTIVE" != "off" \]; then\s*\n\s*mkdir -p "\$TEL_HOME\/sentinels"/.test(step0),
    'the sentinel gate must require "on", not merely "not off" — deferred would pass');
  assert(/TEL_EFFECTIVE" = "on" \]; then\s*\n\s*mkdir -p "\$TEL_HOME\/sentinels"/.test(step0),
    'the sentinel should only be written when telemetry is on');

  // Step 0 must not contain the question any more.
  assert(!/ask the user ONCE with this text/.test(step0),
    'Step 0 still asks the consent question before doing the work');
});

t('the Final Step owns the consent question and logs nothing for that run', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const final = skill.slice(skill.indexOf('## Final Step'));
  assert(/is `deferred`/.test(final), 'the Final Step should handle the deferred first run');
  assert(/Hand over the finished work FIRST/.test(final),
    'the Final Step should deliver before asking');
  assert(/\.telemetry-prompted/.test(final) && /\.telemetry-mode/.test(final),
    'the Final Step should persist the answer');
  assert(/log nothing for this run/.test(final),
    'the deferred run must not be logged — that would be recording before consent');
});

// ---- the local server must hand its own node down to spawned CLIs (#259) ----

t('server spawns CLIs with the running interpreter on PATH', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  assert(/function childEnv\(\)/.test(src), 'childEnv helper missing');
  assert(/path\.dirname\(process\.execPath\)/.test(src),
    'childEnv does not derive the node directory from process.execPath');
  const spawns = src.split('\n').filter(l => /\bspawn\(bin\b/.test(l));
  assert(spawns.length >= 2, `expected at least 2 spawn sites, found ${spawns.length}`);
  for (const s of spawns) {
    assert(/env:\s*childEnv\(\)/.test(s),
      `spawn site does not pass childEnv(): ${s.trim()}`);
  }
});

t('a stripped PATH hides node from a child, and childEnv restores it', () => {
  // The failure this guards: the server is started by absolute path (launchd,
  // an editor, nohup from a non-interactive shell) so nvm/fnm/asdf shims are
  // not on PATH. The child then reports "node is not installed" on a machine
  // that has node. Prove both halves rather than trusting the code read.
  const bare = '/usr/bin:/bin:/usr/sbin:/sbin';
  const nodeDir = path.dirname(process.execPath);
  const look = (p) => spawnSync('sh', ['-c', 'command -v node || true'],
    { env: { PATH: p }, encoding: 'utf8', timeout: 10000 }).stdout.trim();

  if (look(bare)) {
    // node lives in /usr/bin on this machine; the bug cannot occur here.
    return;
  }
  assert(look(bare) === '', 'expected node to be invisible on a bare PATH');
  const restored = look(`${nodeDir}${path.delimiter}${bare}`);
  assert(restored !== '', 'prepending the interpreter directory did not expose node');
  assert(restored.startsWith(nodeDir),
    `child resolved a different node: ${restored} (wanted one under ${nodeDir})`);
});

// ---- the onboarding routing offer must stay an offer (#263) ----

t('onboarding offers the CLAUDE.md routing line and never writes it silently', () => {
  const ob = fs.readFileSync(path.join(__dirname, '..', 'ONBOARDING.md'), 'utf8');
  const step = ob.slice(ob.indexOf('## Step 6 — Offer the routing line'),
                        ob.indexOf('## Step 7'));
  assert(step.length > 200, 'routing step missing or truncated');

  // Asked at most once, ever.
  assert(/\.routing-prompted/.test(step), 'no .routing-prompted guard — would re-ask every install');
  // A no is remembered.
  assert(/\.routing-declined/.test(step), 'no .routing-declined marker — a decline would not stick');
  // A reinstall cannot append a second copy.
  assert(/<!-- tdoc:routing -->/.test(step), 'no idempotency marker for the appended line');
  // It is an offer: the user is asked, and the path is named in the question.
  assert(/AskUserQuestion/.test(step), 'step does not ask — writing CLAUDE.md unasked is the failure this guards');
  assert(/`<path>`/.test(step), 'the question does not name the file being edited');
  assert(step.indexOf('future document requests automatically use tdoc') < step.indexOf('durable rule'),
    'routing question must lead with the user outcome before agent internals');
  // And it must not quietly commit on the user's behalf.
  assert(/Do not commit/i.test(step), 'step does not forbid committing the edit');

  // The markers are registered where a future reader looks for them.
  const idem = ob.slice(ob.indexOf('## Idempotency'));
  for (const m of ['.routing-prompted', '.routing-declined', 'tdoc:routing']) {
    assert(idem.includes(m), `${m} not listed under Idempotency`);
  }
});

t('onboarding presents doctor status target-first without changing its JSON contract', () => {
  const ob = fs.readFileSync(path.join(__dirname, '..', 'ONBOARDING.md'), 'utf8');
  const doctor = ob.slice(ob.indexOf('## Step 3 — Run the doctor'),
                          ob.indexOf('## Step 4'));
  for (const text of ['**Target**', '**Readiness**', '**Next action**']) {
    assert(doctor.includes(text), `doctor presentation is missing ${text}`);
  }
  assert(doctor.indexOf('**Target**') < doctor.indexOf('**Readiness**'),
    'doctor status does not put target before readiness');
  assert(/Do not paste the full dependency\/provider dump/.test(doctor),
    'hosted onboarding still foregrounds irrelevant provider diagnostics');
  assert(/For `vercel`, `ready_to_publish: true` means the required local dependencies/.test(doctor),
    'Vercel readiness does not distinguish dependencies from provider configuration');
  assert(/existing machine-readable contract/.test(doctor),
    'human presentation guidance does not preserve the machine JSON contract');
});

t('first-doc no-history result stays scoped and carries its next action', () => {
  const first = fs.readFileSync(path.join(__dirname, '..', 'FIRST-DOC.md'), 'utf8');
  const noHistory = first.slice(first.indexOf('## If there is no history'),
                                first.indexOf('## Do not'));
  assert(/no AI history was found on this machine yet/.test(noHistory),
    'no-history result still reads like an absolute privacy or security judgment');
  assert(/use it for a week\s+and ask again/.test(noHistory),
    'no-history result lost its concrete next action');
});

// ---- the skill's self-update must be able to run at all ----

t('SKILL.md resolves its own directory at runtime, not at install time', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  // The failure this guards: TDOC_DIR was a __TDOC_DIR__ placeholder meant to be
  // substituted by an install script that does not exist, so every install
  // carried the literal string, `[ -x "$TDOC_DIR/bin/tdoc-update" ]` was false,
  // and the automatic update silently never ran on any machine.
  assert(!/__TDOC_DIR__/.test(skill),
    'SKILL.md still contains an install-time placeholder — it will never be substituted');
  assert(/TDOC_SKILL_ROOT=/.test(skill), 'no runtime resolution of the skill directory');
  assert(/tdoc-update" --auto/.test(skill) || /tdoc-update" --auto/.test(skill.replace(/\n\s*/g, ' ')),
    'the automatic update call is gone');
  assert(/SKILL_DIR="\$TDOC_SKILL_ROOT"\s+"\$TDOC_SKILL_ROOT\/bin\/tdoc-update" --auto/.test(skill),
    'the preamble does not pin old updaters to the resolved active checkout');

  // And the guard must actually pass against a real checkout.
  const root = path.join(__dirname, '..');
  const probe = spawnSync('sh', ['-c',
    `TDOC_SKILL_ROOT="${root}"; [ -x "$TDOC_SKILL_ROOT/bin/tdoc-update" ] && ` +
    `grep -q -- '--auto)' "$TDOC_SKILL_ROOT/bin/tdoc-update" && echo ok`],
    { encoding: 'utf8', timeout: 10000 });
  assert(probe.stdout.trim() === 'ok',
    'the resolved directory does not satisfy the update guard');
});

t('SKILL.md resolves the checkout for the active agent host', () => {
  const skill = fs.readFileSync(path.join(__dirname, '..', 'SKILL.md'), 'utf8');
  const resolvers = skill.match(/tdoc_resolve_skill_dir\(\) \{[\s\S]*?\n\}/g) || [];
  assert(resolvers.length === 2,
    `expected setup + telemetry resolvers, found ${resolvers.length}`);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-agent-roots-'));
  const roots = {
    claude: path.join(home, '.claude', 'skills', 'tdoc'),
    codex: path.join(home, '.codex', 'skills', 'tdoc'),
    agents: path.join(home, '.agents', 'skills', 'tdoc'),
  };
  for (const root of Object.values(roots)) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'fixture\n');
  }

  const resolve = (source, extraEnv = {}) => {
    const r = spawnSync('bash', ['-c', `${source}\ntdoc_resolve_skill_dir`], {
      env: { HOME: home, PATH: process.env.PATH || '/usr/bin:/bin', ...extraEnv },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert(r.status === 0, `resolver failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  try {
    for (const resolver of resolvers) {
      assert(resolve(resolver, { CODEX_SESSION_ID: 'codex-test' }) === roots.codex,
        'Codex did not prefer its Codex-specific installation');
      assert(resolve(resolver, { CLAUDECODE: '1' }) === roots.claude,
        'Claude did not prefer its Claude-specific installation');
      assert(resolve(resolver) === roots.agents,
        'an unknown/shared host did not prefer the shared .agents installation');

      fs.unlinkSync(path.join(roots.codex, 'SKILL.md'));
      assert(resolve(resolver, { CODEX_SESSION_ID: 'codex-test' }) === roots.agents,
        'Codex did not fall back to the shared .agents installation');
      fs.writeFileSync(path.join(roots.codex, 'SKILL.md'), 'fixture\n');

      const override = path.join(home, 'explicit-tdoc');
      assert(resolve(resolver, {
        CODEX_SESSION_ID: 'codex-test',
        TDOC_SKILL_DIR: override,
      }) === override, 'TDOC_SKILL_DIR no longer overrides host detection');
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});


// ---- access flags must not drag jq back onto the hosted path (#272) ----
// FIRST-DOC.md step 7 publishes the very first doc with
// `--visibility private --history owner`, so this is the path EVERY new user
// takes. #256 removed jq from hosted publishing but its test only looked
// inside the functions that had changed, and the access-block writer sits
// outside all of them — so the first doc still died with "jq: command not
// found" on a machine without jq. This test runs the real thing instead of
// grepping, so scope cannot drift again.

t('a hosted publish with access flags works with no jq on PATH', () => {
  const bin = path.join(BIN, 'tdoc-publish');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-nojq-'));
  const port = 8600 + Math.floor(Math.random() * 300);
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  // A PATH with everything the script needs EXCEPT jq. Masking jq with a
  // failing stub would not work: `command -v jq` succeeds on a file that
  // exists whether or not it runs.
  for (const dir of (process.env.PATH || '').split(':')) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name === 'jq') continue;
      const target = path.join(binDir, name);
      if (fs.existsSync(target)) continue;
      try { fs.symlinkSync(path.join(dir, name), target); } catch {}
    }
  }
  assert(!fs.existsSync(path.join(binDir, 'jq')), 'the jq-free PATH still has jq');

  const stub = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{` +
    `s.setHeader('content-type','application/json');` +
    `const u=q.url.split('?')[0];` +
    `if(u==='/api/upload'){const j=JSON.parse(b||'{}');` +
    `return s.end(JSON.stringify({ok:true,slug:j.slug,version:j.version,size:42,` +
    `access:(j.meta&&j.meta.access)||null}));}` +
    `s.statusCode=404;s.end('{}');});}).listen(${port},'127.0.0.1');`], { stdio: 'ignore' });

  try {
    const up = spawnSync('bash', ['-c',
      `for i in $(seq 1 100); do curl -sS -o /dev/null --max-time 1 -X POST ` +
      `http://127.0.0.1:${port}/api/upload && exit 0; sleep 0.05; done; exit 1`],
      { encoding: 'utf8', timeout: 15000 });
    assert(up.status === 0, 'stub server never came up');

    fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
    fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({
      platform: 'hosted', base: `http://127.0.0.1:${port}`,
      public_host: '127.0.0.1', upload_token: 'tok', github_login: 'tester',
    }));
    const docs = path.join(home, 'tdocs', 'first-doc', 'v1');
    fs.mkdirSync(docs, { recursive: true });
    fs.writeFileSync(path.join(docs, 'index.html'),
      '<!doctype html><body><div class="wrap"><h1>D</h1></div></body>');
    fs.writeFileSync(path.join(home, 'tdocs', 'first-doc', 'meta.json'), JSON.stringify({
      title: 'D', slug: 'first-doc', versions: [{ n: 1, created: '2026-01-01T00:00:00Z' }],
    }));
    fs.writeFileSync(path.join(home, 'tdocs', 'first-doc', 'comments.json'), '[]');

    // Exactly what FIRST-DOC.md step 7 tells the agent to run.
    const r = spawnSync(bin, ['--visibility', 'private', '--history', 'owner', 'first-doc'], {
      env: { ...process.env, PATH: binDir, HOME: home, TDOC_DIR: path.join(home, 'tdocs') },
      encoding: 'utf8', timeout: 60000,
    });
    assert(!/jq: command not found/.test(r.stdout + r.stderr),
      `the access path still needs jq:\n      ${(r.stdout + r.stderr).split('\n').filter((l) => /jq/.test(l)).join('\n      ')}`);
    assert(r.status === 0, `publish exited ${r.status}: ${r.stderr}`);
    assert(/Published:/.test(r.stdout), `no published URL: ${r.stdout}`);

    // And the policy it wrote must be the one that was asked for.
    const meta = JSON.parse(fs.readFileSync(path.join(home, 'tdocs', 'first-doc', 'meta.json'), 'utf8'));
    assert(meta.access.visibility === 'private',
      `expected private, got ${meta.access.visibility}`);
    assert(meta.access.history_visibility === 'owner',
      `expected owner history, got ${meta.access.history_visibility}`);
    assert(Array.isArray(meta.access.allowed_users), 'allowed_users must stay an array');

    // A later flag must MERGE, not replace: publishing again with only
    // --visibility has to leave history_visibility alone. Getting this wrong
    // would quietly re-expose the version history of a doc someone had
    // deliberately locked down.
    const r2 = spawnSync(bin, ['--visibility', 'unlisted', 'first-doc'], {
      env: { ...process.env, PATH: binDir, HOME: home, TDOC_DIR: path.join(home, 'tdocs') },
      encoding: 'utf8', timeout: 60000,
    });
    assert(r2.status === 0, `second publish exited ${r2.status}: ${r2.stderr}`);
    const meta2 = JSON.parse(fs.readFileSync(path.join(home, 'tdocs', 'first-doc', 'meta.json'), 'utf8'));
    assert(meta2.access.visibility === 'unlisted', 'the new visibility did not apply');
    assert(meta2.access.history_visibility === 'owner',
      `history_visibility was reset to ${meta2.access.history_visibility} instead of merging`);
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});


t('no jq call sits outside a self-host-only region (#272)', () => {
  // The behavioural test above proves ONE hosted path works without jq. This
  // one covers the whole file, because the bug it replaces was not a missing
  // line — it was a test scoped to the code that changed instead of to the
  // surface the claim covered. Anything added at top level, or in a new
  // helper, is caught here even if nobody thinks to exercise it.
  const src = readBin('tdoc-publish');
  const lines = src.split('\n');

  const fnRange = (name) => {
    const start = lines.indexOf(`${name}() {`);
    if (start === -1) return null;
    for (let j = start + 1; j < lines.length; j++) if (lines[j] === '}') return [start, j];
    return null;
  };

  // The platform dispatch is at column 0, so its closing `fi` is too;
  // everything nested inside is indented.
  const dispatch = lines.indexOf('if [ "$PLATFORM" = "hosted" ]; then');
  assert(dispatch !== -1, 'the platform dispatch moved — this guard needs updating');
  let dispatchEnd = -1;
  for (let j = dispatch + 1; j < lines.length; j++) if (lines[j] === 'fi') { dispatchEnd = j; break; }
  assert(dispatchEnd !== -1, 'could not find the end of the platform dispatch');
  let firstElif = -1;
  for (let j = dispatch + 1; j < dispatchEnd; j++) {
    if (lines[j].startsWith('elif [ "$PLATFORM"')) { firstElif = j; break; }
  }
  assert(firstElif !== -1, 'the dispatch has no self-host branch');

  const allowed = [['self-host dispatch', firstElif, dispatchEnd]];
  for (const fn of ['first_time_setup', 'first_time_setup_vercel', 'cf_api',
                    'resolve_wrangler_oauth_token', 'bundle_worker']) {
    const r = fnRange(fn);
    if (r) allowed.push([fn, r[0], r[1]]);
  }
  assert(allowed.length >= 4, 'the self-host functions moved — this guard needs updating');

  const stray = [];
  lines.forEach((l, i) => {
    if (!/\bjq\s+(-|["'$])/.test(l)) return;
    if (l.trim().startsWith('#')) return;
    if (allowed.some(([, a, b]) => i >= a && i <= b)) return;
    stray.push(`line ${i + 1}: ${l.trim().slice(0, 80)}`);
  });
  assert(stray.length === 0,
    `jq is reachable from the hosted path:\n      ${stray.join('\n      ')}`);
});


// ---- the rest of the hosted command set must not need jq either (#276) ----
// Four PRs removed jq from one script each (#228, #257, #273, #275) and each
// left the next one standing, because every bin script re-implemented its own
// config reads. tdoc-agent-reply is the worst of them: SKILL.md calls replying
// on every comment "mandatory", so a jq gate there takes the whole comment
// loop down on a stock macOS machine. These run the real binaries.

// Build a PATH carrying everything except jq. A failing stub would not do:
// `command -v jq` succeeds on any file that exists, runnable or not.
function jqFreePath(home) {
  const binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  for (const dir of (process.env.PATH || '').split(':')) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (name === 'jq') continue;
      const target = path.join(binDir, name);
      if (fs.existsSync(target)) continue;
      try { fs.symlinkSync(path.join(dir, name), target); } catch {}
    }
  }
  assert(!fs.existsSync(path.join(binDir, 'jq')), 'the jq-free PATH still has jq');
  return binDir;
}

// A stand-in worker: serves a comment list, accepts agent replies, accepts
// deletes. Routes are the ones the three scripts actually call.
function startStubWorker(port, state) {
  const child = spawn(process.execPath, ['-e',
    `const st=${JSON.stringify(state)};` +
    `require('http').createServer((q,s)=>{let b='';q.on('data',d=>b+=d);q.on('end',()=>{` +
    `s.setHeader('content-type','application/json');` +
    `const u=q.url.split('?')[0];` +
    `if(u==='/api/comments')return s.end(JSON.stringify(st.comments));` +
    `if(u==='/api/agent/reply'){st.lastReply=JSON.parse(b||'{}');` +
    `return s.end(JSON.stringify({ok:true,echo:st.lastReply}));}` +
    `if(u==='/api/doc')return s.end(JSON.stringify({ok:true,deleted:3}));` +
    `s.statusCode=404;s.end('{}');});}).listen(${port},'127.0.0.1');`], { stdio: 'ignore' });
  const up = spawnSync('bash', ['-c',
    `for i in $(seq 1 100); do curl -sS -o /dev/null --max-time 1 ` +
    `http://127.0.0.1:${port}/api/comments && exit 0; sleep 0.05; done; exit 1`],
    { encoding: 'utf8', timeout: 15000 });
  assert(up.status === 0, 'stub worker never came up');
  return child;
}

function hostedHome(port) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-nojq2-'));
  fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
  fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({
    platform: 'hosted', base: `http://127.0.0.1:${port}`,
    public_host: '127.0.0.1', upload_token: 'tok', github_login: 'tester',
  }));
  return home;
}

const noJq = (r) => !/jq: command not found|needs jq/.test(r.stdout + r.stderr);

t('tdoc-pull works with no jq on PATH, and still merges local-only comments', () => {
  const port = 8900 + Math.floor(Math.random() * 200);
  const remote = [{ id: 'r1', text: 'from worker', version: 1 }];
  const stub = startStubWorker(port, { comments: remote });
  const home = hostedHome(port);
  try {
    const binDir = jqFreePath(home);
    const doc = path.join(home, 'tdocs', 'pull-doc');
    fs.mkdirSync(doc, { recursive: true });
    // One comment the worker has, one it does not. The local-only one is the
    // whole point of the merge — losing it was a real data-loss bug once.
    fs.writeFileSync(path.join(doc, 'comments.json'), JSON.stringify([
      { id: 'r1', text: 'stale copy', version: 1 },
      { id: 'local-only', text: 'authored before publish', version: 1 },
    ]));

    const r = spawnSync(path.join(BIN, 'tdoc-pull'), ['pull-doc'], {
      env: { ...process.env, PATH: binDir, HOME: home, TDOC_DIR: path.join(home, 'tdocs'),
             TDOC_SKIP_UPDATE_CHECK: '1' },
      encoding: 'utf8', timeout: 60000,
    });
    assert(noJq(r), `tdoc-pull still needs jq:\n      ${r.stdout}\n      ${r.stderr}`);
    assert(r.status === 0, `tdoc-pull exited ${r.status}: ${r.stderr}`);

    const merged = JSON.parse(fs.readFileSync(path.join(doc, 'comments.json'), 'utf8'));
    assert(merged.length === 2, `expected 2 merged comments, got ${merged.length}`);
    assert(merged[0].text === 'from worker', 'the worker copy must win on a shared id');
    assert(merged.some((c) => c.id === 'local-only'), 'the local-only comment was dropped');
    assert(fs.existsSync(path.join(doc, 'comments.json.bak')), 'no backup was written');
    assert(/Pulled 2 comments/.test(r.stdout), `wrong count reported: ${r.stdout}`);
    assert(/Merged 1 local-only/.test(r.stdout), `merge not reported: ${r.stdout}`);
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('tdoc-pull refuses to clobber comments.json when the worker misbehaves', () => {
  // The array check is the guard that keeps a 500 or an HTML error page from
  // wiping local comments. It has to survive the move off jq.
  const port = 9150 + Math.floor(Math.random() * 200);
  const stub = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>{s.statusCode=500;s.end('<html>bad gateway</html>');})` +
    `.listen(${port},'127.0.0.1');`], { stdio: 'ignore' });
  const home = hostedHome(port);
  try {
    spawnSync('bash', ['-c', `for i in $(seq 1 100); do curl -sS -o /dev/null --max-time 1 ` +
      `http://127.0.0.1:${port}/ && break; sleep 0.05; done`], { timeout: 15000 });
    const binDir = jqFreePath(home);
    const doc = path.join(home, 'tdocs', 'pull-doc');
    fs.mkdirSync(doc, { recursive: true });
    const original = JSON.stringify([{ id: 'keep-me', text: 'precious', version: 1 }]);
    fs.writeFileSync(path.join(doc, 'comments.json'), original);

    const r = spawnSync(path.join(BIN, 'tdoc-pull'), ['pull-doc'], {
      env: { ...process.env, PATH: binDir, HOME: home, TDOC_DIR: path.join(home, 'tdocs'),
             TDOC_SKIP_UPDATE_CHECK: '1' },
      encoding: 'utf8', timeout: 60000,
    });
    assert(noJq(r), `tdoc-pull still needs jq:\n      ${r.stderr}`);
    assert(r.status !== 0, 'a non-array response must fail, not succeed');
    assert(fs.readFileSync(path.join(doc, 'comments.json'), 'utf8') === original,
      'local comments were clobbered by a bad worker response');
    // The file surviving is not enough. Node's own JSON.parse would also throw
    // on this input, so the file is safe either way — what the array guard buys
    // is that the user reads a sentence instead of a stack trace, and sees the
    // start of the response that confused it. Assert the sentence.
    assert(/did not return a comment array/.test(r.stderr),
      `no plain-language explanation:\n      ${r.stderr.trim()}`);
    assert(/bad gateway/.test(r.stderr),
      `the worker's actual response was not shown:\n      ${r.stderr.trim()}`);
    assert(!/at JSON\.parse|node:internal/.test(r.stderr),
      `a node stack trace reached the user:\n      ${r.stderr.trim()}`);
    assert(!fs.existsSync(path.join(doc, 'comments.json.bak')),
      'a bad response should not leave a spurious .bak behind');
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('tdoc-agent-reply posts with no jq on PATH, and builds the payload right', () => {
  const port = 9400 + Math.floor(Math.random() * 200);
  const stub = startStubWorker(port, { comments: [] });
  const home = hostedHome(port);
  try {
    const binDir = jqFreePath(home);
    // Quotes and non-ASCII in the reply text: hand-rolled JSON is where this
    // kind of port usually breaks, and replies are written in the user's own
    // language, so non-ASCII is the normal case rather than the edge one.
    const text = 'Rewrote the "intro" — 已改成中文.';
    const r = spawnSync(path.join(BIN, 'tdoc-agent-reply'), [
      '--slug', 'reply-doc', '--parent', 'c1', '--text', text,
      '--status', 'applied', '--applied-in', '2',
    ], {
      env: { ...process.env, PATH: binDir, HOME: home, TDOC_SKIP_UPDATE_CHECK: '1' },
      encoding: 'utf8', timeout: 60000,
    });
    assert(noJq(r), `tdoc-agent-reply still needs jq:\n      ${r.stdout}\n      ${r.stderr}`);
    assert(r.status === 0, `agent-reply exited ${r.status}: ${r.stderr}`);

    const echoed = JSON.parse(r.stdout).echo;
    assert(echoed.slug === 'reply-doc' && echoed.parent_id === 'c1', 'wrong identifiers');
    assert(echoed.text === text, `text was mangled: ${echoed.text}`);
    assert(echoed.status === 'applied', 'status was dropped');
    assert(echoed.applied_in === 2,
      `applied_in must be a number, got ${JSON.stringify(echoed.applied_in)}`);
    assert(typeof echoed.agent_login === 'string', 'agent_login must always be present');
    assert(!('agent_avatar_url' in echoed), 'an empty avatar must be omitted, not sent as ""');
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('tdoc-agent-reply still reports a 200-with-error as a failure', () => {
  // The worker rejects some replies with a 200 body carrying {"error": ...}.
  // Without this check a rejected reply is indistinguishable from a posted one,
  // which is how comments silently go unanswered.
  const port = 9650 + Math.floor(Math.random() * 200);
  const stub = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');` +
    `s.end(JSON.stringify({error:'parent_not_found'}));}).listen(${port},'127.0.0.1');`],
    { stdio: 'ignore' });
  const home = hostedHome(port);
  try {
    spawnSync('bash', ['-c', `for i in $(seq 1 100); do curl -sS -o /dev/null --max-time 1 ` +
      `http://127.0.0.1:${port}/ && break; sleep 0.05; done`], { timeout: 15000 });
    const binDir = jqFreePath(home);
    const r = spawnSync(path.join(BIN, 'tdoc-agent-reply'), [
      '--slug', 'reply-doc', '--parent', 'missing', '--text', 'hi',
    ], {
      env: { ...process.env, PATH: binDir, HOME: home, TDOC_SKIP_UPDATE_CHECK: '1' },
      encoding: 'utf8', timeout: 60000,
    });
    assert(noJq(r), `tdoc-agent-reply still needs jq:\n      ${r.stderr}`);
    assert(r.status !== 0, 'a 200-with-error must exit non-zero');
    assert(/parent_not_found/.test(r.stderr),
      `the worker's reason should reach the user: ${r.stderr}`);
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('tdoc-unpublish works with no jq on PATH', () => {
  const port = 9900 + Math.floor(Math.random() * 90);
  const stub = startStubWorker(port, { comments: [] });
  const home = hostedHome(port);
  try {
    const binDir = jqFreePath(home);
    const r = spawnSync(path.join(BIN, 'tdoc-unpublish'), ['gone-doc'], {
      env: { ...process.env, PATH: binDir, HOME: home, TDOC_SKIP_UPDATE_CHECK: '1' },
      encoding: 'utf8', timeout: 60000,
    });
    assert(noJq(r), `tdoc-unpublish still needs jq:\n      ${r.stdout}\n      ${r.stderr}`);
    assert(r.status === 0, `unpublish exited ${r.status}: ${r.stderr}`);
    assert(/Unpublished gone-doc/.test(r.stdout), `no confirmation: ${r.stdout}`);
    assert(/"deleted": 3/.test(r.stdout), `the worker response was not printed: ${r.stdout}`);
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('the hosted-capable scripts call jq nowhere at all (#276)', () => {
  // tdoc-publish has genuine self-host regions, so its guard has to reason
  // about ranges. These three have no self-host-only work in them: every line
  // runs on hosted, so the correct budget is zero. A range-based guard would
  // be the same mistake that let #272 through.
  for (const f of ['tdoc-pull', 'tdoc-agent-reply', 'tdoc-unpublish']) {
    const lines = readBin(f).split('\n');
    const stray = [];
    lines.forEach((l, i) => {
      if (!/\bjq\b/.test(l)) return;
      if (l.trim().startsWith('#')) return;   // prose about jq is fine
      stray.push(`line ${i + 1}: ${l.trim().slice(0, 80)}`);
    });
    assert(stray.length === 0, `${f} reaches for jq:\n      ${stray.join('\n      ')}`);
  }
});

t('the shared JSON helpers are sourced, not re-implemented per script', () => {
  // The defect #276 names is not any one jq call, it is that each script grew
  // its own config reader. Keep them on one implementation so the next fix
  // lands once.
  const lib = fs.readFileSync(path.join(BIN, 'lib', 'json.sh'), 'utf8');
  for (const fn of ['json_get', 'json_file_get', 'json_str', 'json_is_array',
                    'json_file_is_array', 'json_file_len', 'json_pretty', 'json_error']) {
    assert(new RegExp(`^${fn}\\(\\) \\{`, 'm').test(lib), `lib/json.sh lost ${fn}`);
  }
  assert(!/\bjq\b/.test(lib.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')),
    'lib/json.sh must not shell out to jq');

  for (const f of ['tdoc-pull', 'tdoc-agent-reply', 'tdoc-unpublish']) {
    const src = readBin(f);
    assert(/^\. "\$TDOC_BIN_DIR\/lib\/json\.sh"$/m.test(src),
      `${f} does not source the shared helpers`);
    assert(/^TDOC_BIN_DIR="\$\(cd "\$\(dirname "\$0"\)" && pwd\)"$/m.test(src),
      `${f} does not resolve its own bin dir before sourcing`);
  }
});

t('lib/json.sh survives the inputs that actually show up', () => {
  const lib = path.join(BIN, 'lib', 'json.sh');
  const run = (script, input) => spawnSync('bash', ['-c', `. "${lib}"; ${script}`],
    { input: input ?? '', encoding: 'utf8', timeout: 20000 });

  // A missing key, a null, and unparseable input all have to read as empty —
  // that is what the `// empty` jq filters they replaced did, and the callers
  // test the result with [ -z ].
  assert(run('json_get a.b', '{"a":{"b":"x"}}').stdout === 'x', 'nested read failed');
  assert(run('json_get a.b', '{"a":{}}').stdout === '', 'missing key must read empty');
  assert(run('json_get a', '{"a":null}').stdout === '', 'null must read empty');
  assert(run('json_get a', 'not json').stdout === '', 'garbage must read empty, not crash');
  assert(run('json_get a', 'not json').status === 0, 'garbage must not fail the caller');
  assert(run('json_get a.b', '{"a":"scalar"}').stdout === '',
    'descending into a scalar must read empty');

  // Numbers and booleans come back as their text, since config values land in
  // shell variables either way.
  assert(run('json_get n', '{"n":42}').stdout === '42', 'numbers must stringify');
  assert(run('json_get b', '{"b":false}').stdout === 'false', 'false must not read as empty');

  assert(run('json_str \'a "b" 中\'').stdout === '"a \\"b\\" 中"', 'json_str mis-encodes');
  assert(run('json_is_array', '[]').status === 0, '[] is an array');
  assert(run('json_is_array', '{}').status !== 0, '{} is not an array');
  assert(run('json_is_array', '<html>').status !== 0, 'an error page is not an array');
  assert(run('json_error', '{"error":"nope"}').stdout === 'nope', 'json_error missed .error');
  assert(run('json_error', '{"ok":true}').status !== 0, 'json_error fired without an error');
  assert(run('json_error', '[{"error":"x"}]').status !== 0, 'an array is not an error object');
  // An error page must reach the user rather than being swallowed as invalid.
  assert(run('json_pretty', '<html>500</html>').stdout === '<html>500</html>',
    'json_pretty ate a non-JSON body');
});



// ---- tdoc-pull has to prove who it is (#278) ----
// It was the only CLI request that sent no Authorization header at all, with
// the token sitting in the same config file it had just read `.base` out of.
// On a private doc the worker therefore saw an anonymous visitor and denied
// the owner their own comments.

t('tdoc-pull sends the account token', () => {
  const port = 8150 + Math.floor(Math.random() * 200);
  // A worker that behaves like the real one: no token, no private doc.
  const stub = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>{` +
    `s.setHeader('content-type','application/json');` +
    `const a=q.headers.authorization||'';` +
    `if(a!=='Bearer sekret'){s.statusCode=403;return s.end('{"error":"access_denied"}');}` +
    `s.end(JSON.stringify([{id:'c1',text:'owner can see this',version:1}]));` +
    `}).listen(${port},'127.0.0.1');`], { stdio: 'ignore' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-pullauth-'));
  try {
    spawnSync('bash', ['-c', `for i in $(seq 1 100); do curl -sS -o /dev/null --max-time 1 ` +
      `http://127.0.0.1:${port}/ && break; sleep 0.05; done`], { timeout: 15000 });
    fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
    fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({
      platform: 'hosted', base: `http://127.0.0.1:${port}`, upload_token: 'sekret',
      public_host: '127.0.0.1', github_login: 'owner',
    }));
    const doc = path.join(home, 'tdocs', 'priv-doc');
    fs.mkdirSync(doc, { recursive: true });

    const r = spawnSync(path.join(BIN, 'tdoc-pull'), ['priv-doc'], {
      env: { ...process.env, HOME: home, TDOC_DIR: path.join(home, 'tdocs'),
             TDOC_SKIP_UPDATE_CHECK: '1' },
      encoding: 'utf8', timeout: 60000,
    });
    assert(r.status === 0, `pull was denied — the token was not sent: ${r.stderr}`);
    const got = JSON.parse(fs.readFileSync(path.join(doc, 'comments.json'), 'utf8'));
    assert(got.length === 1 && got[0].text === 'owner can see this',
      `wrong comments pulled: ${JSON.stringify(got)}`);
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('a denied pull explains it is an access problem, not a network one', () => {
  // "network error or bad slug?" sent people looking at their wifi. A denial
  // has one likely cause and one fix, so say both.
  const port = 8400 + Math.floor(Math.random() * 200);
  const stub = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');` +
    `s.statusCode=403;s.end('{"error":"access_denied"}');}).listen(${port},'127.0.0.1');`],
    { stdio: 'ignore' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-pulldenied-'));
  try {
    spawnSync('bash', ['-c', `for i in $(seq 1 100); do curl -sS -o /dev/null --max-time 1 ` +
      `http://127.0.0.1:${port}/ && break; sleep 0.05; done`], { timeout: 15000 });
    fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
    fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({
      platform: 'hosted', base: `http://127.0.0.1:${port}`, upload_token: 'stale',
    }));
    const doc = path.join(home, 'tdocs', 'priv-doc');
    fs.mkdirSync(doc, { recursive: true });
    const original = JSON.stringify([{ id: 'keep', text: 'local', version: 1 }]);
    fs.writeFileSync(path.join(doc, 'comments.json'), original);

    const r = spawnSync(path.join(BIN, 'tdoc-pull'), ['priv-doc'], {
      env: { ...process.env, HOME: home, TDOC_DIR: path.join(home, 'tdocs'),
             TDOC_SKIP_UPDATE_CHECK: '1' },
      encoding: 'utf8', timeout: 60000,
    });
    assert(r.status !== 0, 'a denial must fail');
    assert(/access_denied/.test(r.stderr) && /private/.test(r.stderr),
      `the denial was not explained:\n      ${r.stderr.trim()}`);
    assert(/tdoc publish priv-doc/.test(r.stderr),
      `no way out was offered:\n      ${r.stderr.trim()}`);
    // Both causes, neither asserted. The first live run of this message named
    // the wrong one — the token owned the doc, the worker was just older than
    // the fix — and sent the owner off to re-publish for nothing.
    assert(/different account/.test(r.stderr),
      `the wrong-account cause is missing:\n      ${r.stderr.trim()}`);
    assert(/predates token-authenticated reads|redeploy/.test(r.stderr),
      `the stale-worker cause is missing:\n      ${r.stderr.trim()}`);
    assert(!/does not own it/.test(r.stderr),
      `the message still asserts one cause as fact:\n      ${r.stderr.trim()}`);
    assert(!/network error/.test(r.stderr),
      `a denial was still blamed on the network:\n      ${r.stderr.trim()}`);
    assert(fs.readFileSync(path.join(doc, 'comments.json'), 'utf8') === original,
      'a denial must not touch local comments');
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

t('tdoc-pull still works against a config that has no token', () => {
  // Self-host configs written before tokens, and local-only setups. Sending no
  // header must stay a supported shape rather than becoming "Bearer ".
  const port = 8480 + Math.floor(Math.random() * 100);
  const stub = spawn(process.execPath, ['-e',
    `require('http').createServer((q,s)=>{s.setHeader('content-type','application/json');` +
    `if('authorization' in q.headers){s.statusCode=400;return s.end('{"error":"sent_empty_bearer"}');}` +
    `s.end('[]');}).listen(${port},'127.0.0.1');`], { stdio: 'ignore' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-pullnotoken-'));
  try {
    spawnSync('bash', ['-c', `for i in $(seq 1 100); do curl -sS -o /dev/null --max-time 1 ` +
      `http://127.0.0.1:${port}/ && break; sleep 0.05; done`], { timeout: 15000 });
    fs.mkdirSync(path.join(home, '.tdoc'), { recursive: true });
    fs.writeFileSync(path.join(home, '.tdoc', 'published.json'), JSON.stringify({
      platform: 'hosted', base: `http://127.0.0.1:${port}`,
    }));
    fs.mkdirSync(path.join(home, 'tdocs', 'open-doc'), { recursive: true });
    const r = spawnSync(path.join(BIN, 'tdoc-pull'), ['open-doc'], {
      env: { ...process.env, HOME: home, TDOC_DIR: path.join(home, 'tdocs'),
             TDOC_SKIP_UPDATE_CHECK: '1' },
      encoding: 'utf8', timeout: 60000,
    });
    assert(r.status === 0, `a token-less config broke: ${r.stderr}`);
    assert(!/sent_empty_bearer/.test(r.stdout + r.stderr),
      'an empty token was sent as a header instead of being omitted');
  } finally {
    stub.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
});


console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
