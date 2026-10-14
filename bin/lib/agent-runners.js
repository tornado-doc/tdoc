// agent-runners — run a local CLI agent headlessly on one prompt.
//
// The one entry point is runAgent({ cli, prompt, cwd, ... }), with two
// backends behind it:
//
//   'cli' (default)  Each CLI is a small adapter (binary name, argv,
//                    conservative defaults) and nothing else: the daemon does
//                    not parse output or drive a conversation, it waits for
//                    the exit code.
//   'oar' (opt-in)   @botiverse/oar, Raft's runtime library for Claude Code /
//                    Codex / Cursor / …: runtime.session({ cwd }) +
//                    promptAndWait(session, text, { timeoutMs }). Same job,
//                    richer observation (events, usage, resume).
//
// Why OAR is not the default (2026-10, @botiverse/oar 0.63): its claude
// adapter hard-codes --dangerously-skip-permissions and refuses
// --permission-mode (launch-args.ts), and its codex adapter defaults the
// sandbox to danger-full-access ("YOLO default", session.ts). This daemon runs
// prompts that strangers influence (the comments), so its default has to be
// LESS than that, which only the CLI backend can express today. OAR is also
// ESM-only, wants Node >= 24 and an npm install in the skill checkout, which
// the skill otherwise never needs. Pick it with --runner oar when a session
// runs with skip-permissions anyway; the seam stays, so the day OAR takes a
// permission policy the default can flip without touching the daemon.
//
// Conservative by default:
//   claude  -p, --permission-mode dontAsk (anything not pre-allowed is denied
//           rather than hung on a prompt nobody will answer), an allow-list
//           of the tools the tdoc edit flow needs.
//   codex   exec --sandbox workspace-write (network on: the flow talks to
//           tdoc.dev), approvals never reach a person in exec mode.
// The prompt goes on stdin for both: no argv length limit, no quoting.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CLAUDE_ALLOWED_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(bash:*)', 'Bash(node:*)', 'Bash(curl:*)'];

const RUNNERS = {
  claude: {
    bin: 'claude',
    label: 'Claude Code',
    args({ cwd, permissionMode, allowedTools, addDirs }) {
      const argv = ['-p', '--output-format', 'text', '--permission-mode', permissionMode || 'dontAsk'];
      const tools = allowedTools || CLAUDE_ALLOWED_TOOLS;
      if (tools.length && permissionMode !== 'bypassPermissions') argv.push('--allowedTools', tools.join(','));
      for (const d of addDirs || []) if (d && d !== cwd) argv.push('--add-dir', d);
      return argv;
    },
  },
  codex: {
    bin: 'codex',
    label: 'Codex',
    args({ cwd, permissionMode, addDirs }) {
      // permissionMode maps onto the sandbox: the default is workspace-write;
      // 'bypassPermissions' is the explicit way to turn the sandbox off.
      const argv = ['exec', '--skip-git-repo-check', '-C', cwd];
      if (permissionMode === 'bypassPermissions') argv.push('--dangerously-bypass-approvals-and-sandbox');
      else argv.push('--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true');
      for (const d of addDirs || []) if (d && d !== cwd) argv.push('--add-dir', d);
      return argv;
    },
  },
};

// The first executable named `bin` on PATH, or null. `which` without a
// dependency, so a missing CLI is reported before anything is acked.
function findOnPath(bin, env = process.env) {
  const dirs = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, bin);
    try {
      const st = fs.statSync(full);
      if (st.isFile()) { fs.accessSync(full, fs.constants.X_OK); return full; }
    } catch {}
  }
  return null;
}

function knownClis() { return Object.keys(RUNNERS); }

// Which of the known CLIs are installed here (in RUNNERS order).
function detectClis(env = process.env) {
  return knownClis().filter((cli) => findOnPath(RUNNERS[cli].bin, env));
}

// Run one CLI on one prompt in `cwd`; resolves when it exits, never rejects.
// `onLine` (optional) sees each output line; the whole output also goes to
// `logPath` when given. `tail` keeps the last few KB for an error message.
function runAgent({ cli, prompt, cwd, env = process.env, timeoutMs = 30 * 60 * 1000, logPath = null, permissionMode = null, allowedTools = null, addDirs = [], onLine = null }) {
  const runner = RUNNERS[cli];
  if (!runner) return Promise.resolve({ ok: false, code: null, signal: null, timedOut: false, error: `unknown cli: ${cli}`, tail: '', durationMs: 0 });
  const bin = findOnPath(runner.bin, env);
  if (!bin) return Promise.resolve({ ok: false, code: null, signal: null, timedOut: false, error: `${runner.bin} is not on PATH`, tail: '', durationMs: 0 });
  const argv = runner.args({ cwd, permissionMode, allowedTools, addDirs });
  const started = Date.now();
  return new Promise((resolve) => {
    let tail = '';
    let timedOut = false;
    let out = null;
    if (logPath) {
      try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); out = fs.createWriteStream(logPath, { flags: 'a' }); } catch {}
    }
    const child = spawn(bin, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const take = (chunk) => {
      const text = String(chunk);
      tail = (tail + text).slice(-4000);
      if (out) out.write(text);
      if (onLine) for (const line of text.split('\n')) if (line) onLine(line);
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 10000).unref();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(killer);
      if (out) out.end();
      resolve({ ok: false, code: null, signal: null, timedOut, error: e.message, tail, durationMs: Date.now() - started });
    });
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      if (out) out.end();
      const ok = code === 0 && !timedOut;
      resolve({
        ok, code, signal, timedOut, tail,
        error: ok ? null : (timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `exit ${code === null ? signal : code}`),
        durationMs: Date.now() - started,
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

// ---- the OAR backend --------------------------------------------------------
// Resolved at call time so the CLI backend never pays for the import. The
// package is looked up from this checkout (`npm i @botiverse/oar` in the
// skill dir) or wherever TDOC_OAR_MODULE points.
async function loadOar(env = process.env) {
  const spec = env.TDOC_OAR_MODULE || '@botiverse/oar';
  try {
    const target = /^[./~]|^\//.test(spec) ? require('url').pathToFileURL(path.resolve(spec)).href : spec;
    return await import(target);
  } catch (e) {
    throw new Error(`the OAR runner needs @botiverse/oar (npm i @botiverse/oar in ${path.resolve(__dirname, '..', '..')}, or set TDOC_OAR_MODULE): ${e.message}`);
  }
}

// OAR has no permission knob below skip-permissions, so this backend passes
// the daemon's intent as a denylist and otherwise runs OAR's way.
const OAR_DISALLOWED_TOOLS = ['WebFetch', 'WebSearch', 'NotebookEdit'];

async function runAgentWithOar({ cli, prompt, cwd, env = process.env, timeoutMs = 30 * 60 * 1000, logPath = null, onLine = null }) {
  const started = Date.now();
  let out = null;
  if (logPath) {
    try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); out = fs.createWriteStream(logPath, { flags: 'a' }); } catch {}
  }
  const emit = (text) => { if (out) out.write(text); if (onLine) for (const line of String(text).split('\n')) if (line) onLine(line); };
  let session = null;
  try {
    const oar = await loadOar(env);
    const runtime = oar.defaultRuntimes.require(cli);
    const installation = runtime.installation ? await runtime.installation() : null;
    if (!installation || installation.kind !== 'available') {
      return { ok: false, code: null, signal: null, timedOut: false, error: `${cli} is not installed (OAR: ${installation ? installation.kind : 'no probe'})`, tail: '', durationMs: Date.now() - started };
    }
    // Only the daemon's own variables ride along: OAR takes `env` as deltas
    // over its inherited environment.
    const delta = {};
    for (const k of ['TDOC_SKILL_DIR', 'TDOC_DIR', 'TDOC_DAEMON', 'TDOC_AGENT']) if (env[k]) delta[k] = env[k];
    session = await runtime.session(installation, { cwd, env: delta, ...(cli === 'claude' ? { disallowedTools: OAR_DISALLOWED_TOOLS } : {}) });
    let text = '';
    const stop = session.events((ev) => {
      if (ev.kind === 'text_delta' && ev.agentPath.length === 0) { text += ev.text; emit(ev.text); }
      else if (ev.kind === 'tool_call_started') emit(`\n[tool] ${ev.tool}\n`);
    });
    const run = await oar.promptAndWait(session, prompt, { timeoutMs });
    if (typeof stop === 'function') stop();
    const tail = text.slice(-4000);
    if (run.kind === 'rejected') return { ok: false, code: null, signal: null, timedOut: false, error: `OAR rejected the prompt: ${run.code} ${run.reason}`, tail, durationMs: Date.now() - started };
    const timedOut = run.kind === 'interrupted' && run.by === 'timeout';
    const ok = run.kind === 'ended' && run.outcome.kind === 'completed';
    return {
      ok, code: ok ? 0 : 1, signal: null, timedOut, tail,
      error: ok ? null : (timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : `turn ${run.outcome.kind}${run.outcome.failure ? ` (${run.outcome.failure})` : ''}`),
      durationMs: Date.now() - started,
    };
  } catch (e) {
    return { ok: false, code: null, signal: null, timedOut: false, error: e.message, tail: '', durationMs: Date.now() - started };
  } finally {
    if (session) { try { await session.dispose(); } catch {} }
    if (out) out.end();
  }
}

// The seam the daemon calls. `runner` picks the backend; everything else is
// the same whichever runs the agent.
function runAgentVia(opts) {
  return (opts.runner || process.env.TDOC_DAEMON_RUNNER || 'cli') === 'oar' ? runAgentWithOar(opts) : runAgent(opts);
}

module.exports = { RUNNERS, CLAUDE_ALLOWED_TOOLS, OAR_DISALLOWED_TOOLS, runAgent, runAgentWithOar, runAgentVia, loadOar, findOnPath, detectClis, knownClis };
