// Prove the vendored renderer and binary module imports work in workerd. Node
// allows runtime WASM compilation, so the ordinary Worker harness misses this.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFileSync } = require('node:child_process');

(async () => {
  const root = path.join(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-preview-workerd-'));
  const previewDir = path.join(root, 'server', 'preview');
  const binary = path.join(root, 'node_modules', '.bin', 'workerd');
  assert.ok(fs.existsSync(binary), 'workerd devDependency is required for preview rendering test');
  execFileSync(process.execPath, [path.join(root, 'bin', 'tdoc-bundle')], { env: { ...process.env, OUT_DIR: dir }, stdio: 'pipe' });
  const deployedSource = fs.readFileSync(path.join(dir, '_worker.bundled.js'), 'utf8');
  assert.ok(deployedSource.startsWith('import TDOC_PREVIEW_WASM from "./resvg.wasm";'));
  assert.ok(deployedSource.includes('const PREVIEW_FONTS = [TDOC_PREVIEW_FONT_REGULAR, TDOC_PREVIEW_FONT_BOLD];'));
  assert.ok(fs.statSync(path.join(dir, 'resvg.wasm')).size > 1_000_000);
  for (const name of ['resvg.wasm', 'NotoSansSC-Regular.ttf', 'NotoSansSC-Bold.ttf']) {
    fs.copyFileSync(path.join(previewDir, name), path.join(dir, name));
  }
  const renderer = fs.readFileSync(path.join(previewDir, 'resvg.mjs'), 'utf8')
    .replace(/export\s*\{\s*Resvg2 as Resvg,\s*initWasm\s*\};?\s*$/, 'return { Resvg: Resvg2, initWasm };');
  const source = `import WASM from './resvg.wasm';
import REGULAR from './NotoSansSC-Regular.ttf';
import BOLD from './NotoSansSC-Bold.ttf';
const R = (() => { ${renderer} })();
let ready;
export default { async fetch() {
  try {
    if (!ready) ready = R.initWasm(WASM);
    await ready;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#fff"/><text x="80" y="160" font-size="60">季度报告</text></svg>';
    const image = new R.Resvg(svg, { font: { fontBuffers: [new Uint8Array(REGULAR), new Uint8Array(BOLD)] } });
    try { const rendered = image.render(); try { return new Response(rendered.asPng(), { headers: { 'Content-Type': 'image/png' } }); } finally { rendered.free(); } }
    finally { image.free(); }
  } catch (error) { return new Response(String(error && error.stack || error), { status: 500 }); }
} };`;
  fs.writeFileSync(path.join(dir, 'worker.mjs'), source);
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  fs.writeFileSync(path.join(dir, 'config.capnp'), `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (services = [(name = "main", worker = .w)], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "main")]);
const w :Workerd.Worker = (modules = [(name = "worker", esModule = embed "worker.mjs"), (name = "resvg.wasm", wasm = embed "resvg.wasm"), (name = "NotoSansSC-Regular.ttf", data = embed "NotoSansSC-Regular.ttf"), (name = "NotoSansSC-Bold.ttf", data = embed "NotoSansSC-Bold.ttf")], compatibilityDate = "2025-01-01");
`);
  const child = spawn(binary, ['serve', 'config.capnp'], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  try {
    let response;
    for (let i = 0; i < 40; i++) {
      try { response = await fetch(`http://127.0.0.1:${port}/`); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
    assert.ok(response, `workerd did not start: ${stderr}`);
    if (response.status !== 200) assert.fail(`workerd returned ${response.status}: ${await response.text()}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.length > 5_000);
    console.log('✓ workerd imports compiled WASM and font data modules and renders a CJK PNG');
  } finally {
    child.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exit(1); });
