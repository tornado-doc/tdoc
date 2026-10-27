const { spawnSync } = require('child_process');
const { knownClis, RUNNERS, findOnPath } = require('./agent-runners.js');

// Share only supported provider names, a version number and a bounded state.
// Never send executable paths, provider configuration or command output.
function inspectLocalRuntimes(setup = {}, env = process.env) {
  return knownClis().map((cli) => {
    const bin = findOnPath(RUNNERS[cli].bin, env);
    if (!bin) return { cli, state: 'not_installed' };
    const result = spawnSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 3000, maxBuffer: 16384 });
    const version = result.status === 0 ? String(result.stdout || '').match(/\b\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?\b/)?.[0] : null;
    const checked = setup.runtimes?.find((r) => r.cli === cli);
    // Replacing/upgrading a runtime invalidates the old connection check.
    const ready = result.status === 0 && (setup.clis || []).includes(cli) && (!checked?.version || checked.version === version);
    return { cli, state: ready ? 'ready' : 'needs_check', ...(version ? { version } : {}) };
  });
}

module.exports = { inspectLocalRuntimes };
