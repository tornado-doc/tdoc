const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'tdoc-backup');
let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.message}`); }
}
const digest = (body) => crypto.createHash('sha256').update(body).digest('hex');

function fixture(root) {
  const put = (name, body) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return { path: name, bytes: Buffer.byteLength(body), sha256: digest(body), content_type: 'application/json' };
  };
  const team = put('team.json', '{"name":"Acme"}');
  const folders = put('folders.json', '{"folders":[]}');
  const html = put('docs/plan/v1/index.html', '<h1>Plan</h1>');
  const meta = put('docs/plan/meta.json', '{"title":"Plan"}');
  fs.writeFileSync(path.join(root, 'docs/plan/manifest.json'), JSON.stringify({
    format: 'tdoc-document-backup', version: 1, slug: 'plan', objects: [html, meta],
  }));
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    format: 'tdoc-portability-backup', version: 1, objects: [team, folders],
    documents: [{ slug: 'plan', manifest: 'docs/plan/manifest.json' }],
  }));
}

console.log('tdoc-backup portability CLI');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-backup-cli-'));
try {
  const source = path.join(tmp, 'source'); fs.mkdirSync(source); fixture(source);
  t('verifies every root and document object', () => {
    const result = spawnSync(process.execPath, [CLI, 'verify', source], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 docs, 5 files/);
  });
  t('reports a corrupt copy instead of accepting it', () => {
    fs.appendFileSync(path.join(source, 'docs/plan/v1/index.html'), 'changed');
    const result = spawnSync(process.execPath, [CLI, 'verify', source], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /size mismatch|checksum mismatch/);
    fs.writeFileSync(path.join(source, 'docs/plan/v1/index.html'), '<h1>Plan</h1>');
  });
  t('downloads with the standard AWS CLI and verifies the result', () => {
    const fakeBin = path.join(tmp, 'bin'); fs.mkdirSync(fakeBin);
    const aws = path.join(fakeBin, 'aws');
    fs.writeFileSync(aws, `#!/bin/sh\ncp -R "$TDOC_TEST_BACKUP_SOURCE"/. "$4"/\nprintf '%s\\n' "$@" > "$TDOC_TEST_AWS_ARGS"\n`);
    fs.chmodSync(aws, 0o755);
    const destination = path.join(tmp, 'download');
    const argsFile = path.join(tmp, 'aws-args');
    const result = spawnSync(process.execPath, [CLI, 'download', 's3://acme-backup/tdoc/t_0123456789abcdef', destination, '--endpoint', 'https://acct.r2.cloudflarestorage.com', '--region', 'auto'], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, TDOC_TEST_BACKUP_SOURCE: source, TDOC_TEST_AWS_ARGS: argsFile },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /backup verified/);
    const passed = fs.readFileSync(argsFile, 'utf8');
    assert.match(passed, /--endpoint-url/);
    assert.match(passed, /https:\/\/acct\.r2\.cloudflarestorage\.com/);
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

if (failed) process.exitCode = 1;
else console.log('\nall passed');
