// Preview Worker (#148) — isolated from production tdoc / tdoc.dev.
//
// Guards: own storage, no Durable Object, 14-day content lifetime, bundle
// strip of `export class CommentsStore` so Cloudflare will mint preview URLs.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e}`); fail++; }
function t(n, fn) { try { fn(); ok(n); } catch (e) { bad(n, e.message); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

const root = path.join(__dirname, '..');
const tpl = fs.readFileSync(path.join(root, 'worker', 'wrangler.preview.toml.template'), 'utf8');
const prod = fs.readFileSync(path.join(root, 'worker', 'wrangler.toml.template'), 'utf8');
const worker = fs.readFileSync(path.join(root, 'worker', 'worker.js'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'bin', 'tdoc-bundle'), 'utf8');

console.log('preview worker (#148)');

t('preview Worker is a different script than production tdoc', () => {
  assert(/name\s*=\s*"tdoc-preview"/.test(tpl), 'must name the Worker tdoc-preview');
  assert(/name\s*=\s*"tdoc"/.test(prod), 'production template must stay name = tdoc');
  assert(tpl.includes('preview_urls = true'), 'must opt in to Cloudflare preview URLs');
  assert(tpl.includes('workers_dev = true'), 'preview URLs only exist on workers.dev');
});

t('preview storage is not production tdoc-docs / META', () => {
  assert(tpl.includes('bucket_name = "tdoc-preview-docs"'), 'must use preview R2 bucket');
  assert(!/bucket_name\s*=\s*"tdoc-docs"/.test(tpl), 'must not bind production R2');
  assert(tpl.includes('PLACEHOLDER_PREVIEW_KV_ID'), 'KV id must be filled per-account, not hardcoded prod');
  assert(!tpl.includes('80fd771188f649a093a9f0c812f540fb'), 'must not embed production META id');
});

t('preview Worker does not implement a Durable Object', () => {
  assert(!/durable_objects/.test(tpl), 'preview wrangler must omit COMMENTS DO binding');
  assert(!/CommentsStore/.test(tpl), 'preview wrangler must not mention CommentsStore');
  assert(!/\[\[migrations\]\]/.test(tpl), 'preview wrangler must omit DO migrations');
  assert(bundle.includes("export class CommentsStore {"), 'bundle must know the export to strip');
  assert(bundle.includes('TDOC_PREVIEW'), 'tdoc-bundle must honor TDOC_PREVIEW=1');
});

t('preview content lifetime is 14 days (KV wrap + documented R2 rule)', () => {
  assert(tpl.includes('TDOC_PREVIEW = "1"'), 'preview env flag must be on');
  assert(worker.includes('PREVIEW_KV_TTL_SECONDS = 14 * 24 * 60 * 60'), 'KV TTL must be 14 days');
  assert(worker.includes('function applyPreviewKvTtl(env)'), 'fetch must wrap META.put on preview');
  assert(worker.includes('applyPreviewKvTtl(env);'), 'fetch must call the TTL wrap');
  assert(tpl.includes('expire-preview-14d'), 'template must name the R2 lifecycle rule');
});

t('TDOC_PREVIEW=1 bundle un-exports CommentsStore and stays valid JS', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-preview-bundle-'));
  try {
    execFileSync(process.execPath, [path.join(root, 'bin', 'tdoc-bundle')], {
      env: { ...process.env, SKILL_DIR: root, OUT_DIR: tmp, TDOC_PREVIEW: '1', TDOC_GENERATED_BY: 'preview-worker.test' },
      stdio: 'pipe',
    });
    const out = fs.readFileSync(path.join(tmp, '_worker.bundled.js'), 'utf8');
    assert(!/export class CommentsStore \{/.test(out), 'preview bundle must not export CommentsStore');
    assert(/class CommentsStore \{/.test(out), 'class can remain as unused source');
    const mjs = path.join(tmp, '_worker.bundled.mjs');
    fs.copyFileSync(path.join(tmp, '_worker.bundled.js'), mjs);
    execFileSync(process.execPath, ['--check', mjs], { stdio: 'pipe' });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
