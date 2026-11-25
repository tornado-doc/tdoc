// A test process's own temp folder, removed with everything in it when the
// process ends: done, failed, thrown, process.exit, Ctrl-C or a kill. What the
// test makes under os.tmpdir(), and what its children make under TMPDIR (the
// CLI, a server, a browser's profile), goes in it. Require it before anything
// is made; fixture-server.js and worker-harness.js do.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-'));
process.env.TMPDIR = root;

function remove() {
  const rm = () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  try { rm(); } catch {
    // A folder a test made unreadable.
    try { spawnSync('chmod', ['-R', 'u+rwx', root], { stdio: 'ignore' }); rm(); } catch {}
  }
}
process.on('exit', remove);
for (const [signal, number] of [['SIGHUP', 1], ['SIGINT', 2], ['SIGTERM', 15]]) process.once(signal, () => process.exit(128 + number));
module.exports = { root };
