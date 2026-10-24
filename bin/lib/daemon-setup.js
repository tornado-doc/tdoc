// Managed setup for the local document agent. No model/provider settings are changed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { detectClis, runAgent } = require('./agent-runners.js');

const home = () => process.env.HOME || os.homedir();
const dir = () => process.env.TDOC_DAEMON_DIR || path.join(home(), '.tdoc', 'daemon');
const root = () => process.env.TDOC_SKILL_DIR || path.resolve(__dirname, '../..');
const settingsFile = () => path.join(dir(), 'setup.json');
function readSetup() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return null; } }
function run(bin, args) {
  const r = spawnSync(bin, args, { stdio: 'inherit', env: { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` } });
  if (r.error || r.status !== 0) throw new Error(`${bin} did not finish successfully${r.error ? `: ${r.error.message}` : ''}`);
}
function serviceFile(platform = process.platform) {
  return platform === 'darwin' ? path.join(home(), 'Library/LaunchAgents/dev.tdoc.daemon.plist')
    : path.join(home(), '.config/systemd/user/tdoc-daemon.service');
}
function stopService() {
  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, serviceFile()], { stdio: 'ignore' });
  } else if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'stop', 'tdoc-daemon.service'], { stdio: 'ignore' });
  }
}
function installService(clis) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Background setup supports macOS and Linux. On Windows, use WSL.');
  fs.mkdirSync(dir(), { recursive: true });
  const file = serviceFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  stopService();
  const script = path.join(root(), 'bin/lib/daemon.js');
  const envPath = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || '/usr/bin:/bin'}`;
  if (process.platform === 'darwin') {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const argv = [process.execPath, script, 'start', '--cli', clis.join(',')];
    fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>dev.tdoc.daemon</string><key>ProgramArguments</key><array>${argv.map((s) => `<string>${esc(s)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(envPath)}</string><key>HOME</key><string>${esc(home())}</string><key>TDOC_SKILL_DIR</key><string>${esc(root())}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardOutPath</key><string>${esc(path.join(dir(), 'service.log'))}</string><key>StandardErrorPath</key><string>${esc(path.join(dir(), 'service.err.log'))}</string></dict></plist>\n`);
    run('launchctl', ['bootstrap', `gui/${process.getuid()}`, file]);
  } else {
    const quote = (s) => '"' + String(s).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    fs.writeFileSync(file, `[Unit]\nDescription=tdoc local document agent\nAfter=network-online.target\n[Service]\nExecStart=${[process.execPath, script, 'start', '--cli', clis.join(',')].map(quote).join(' ')}\nEnvironment=${quote(`PATH=${envPath}`)} ${quote(`HOME=${home()}`)} ${quote(`TDOC_SKILL_DIR=${root()}`)}\nRestart=on-failure\nRestartSec=15\n[Install]\nWantedBy=default.target\n`);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'tdoc-daemon.service']);
  }
}
async function setup(args, deps = {}) {
  console.log('[tdoc] Connecting this computer. This uses your existing AI account for one small connection check.');
  // Pair in the person's browser; never copy a browser credential into the terminal.
  (deps.signIn || (() => run('bash', [path.join(root(), 'bin/tdoc-publish'), '--signin-only'])))();
  if (!deps.signIn) {
    const configPath = process.env.TDOC_CONFIG || path.join(home(), '.tdoc', 'published.json');
    let config; try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { throw new Error('Sign-in did not save a tdoc account. Run setup again.'); }
    if (config.platform !== 'hosted') throw new Error('Automatic computer setup needs a tdoc.dev account. Your current publishing profile is self-hosted; it was kept unchanged.');
  }
  const found = (deps.detect || detectClis)();
  const asked = args.cli ? String(args.cli).split(',').filter(Boolean) : found;
  if (!asked.length) throw new Error('Install and sign in to Claude Code or Codex, then run tdoc setup again.');
  for (const cli of asked) if (!found.includes(cli)) throw new Error(`${cli} is not available on PATH. Install it and run tdoc setup again.`);
  fs.mkdirSync(dir(), { recursive: true });
  const cwd = path.join(dir(), 'connection-check');
  fs.mkdirSync(cwd, { recursive: true });
  const ready = [];
  for (const cli of asked) {
    console.log(`[tdoc] Checking ${cli}…`);
    const result = await (deps.probe || runAgent)({ cli, cwd, prompt: 'Reply with exactly TDOC_READY. Do not use tools, read files, or change anything.', timeoutMs: 90000, allowedTools: [], addDirs: [], writeDirs: [cwd] });
    if (result.ok && /\bTDOC_READY\b/.test(result.tail)) ready.push(cli);
    else console.error(`[tdoc] ${cli} could not answer. Open ${cli}, check its sign-in and plan, then run tdoc setup again.`);
  }
  if (!ready.length) throw new Error('No AI passed the connection check. No background service was started.');
  const previous = readSetup();
  fs.writeFileSync(settingsFile(), JSON.stringify({ clis: ready, checked_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  try { (deps.install || installService)(ready); } catch (e) {
    // A failed service install must not register a new, apparently-online device.
    if (previous) fs.writeFileSync(settingsFile(), JSON.stringify(previous));
    else fs.unlinkSync(settingsFile());
    throw e;
  }
  console.log('[tdoc] Background service started. Return to tdoc; this computer will appear automatically.');
  console.log('[tdoc] Runs while this computer is awake and you are signed in. Pause: tdoc stop. Resume: tdoc setup.');
}
function uninstall() {
  stopService();
  if (process.platform === 'linux') spawnSync('systemctl', ['--user', 'disable', 'tdoc-daemon.service'], { stdio: 'ignore' });
  try { fs.unlinkSync(serviceFile()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  console.log('[tdoc] Background service removed. Your docs, sign-in and logs were kept.');
}
module.exports = { setup, uninstall, stopService, readSetup, serviceFile, installService };
