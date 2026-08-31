// Terminal onboarding recovery regressions.
//
// Runs the real tdoc-publish script with an isolated HOME. Provider tests use
// a PATH that deliberately lacks the selected CLI; cancellation tests use a
// local GitHub-device-flow stand-in and send SIGINT to the publish process.

const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const PUBLISH = path.join(__dirname, '..', 'bin', 'tdoc-publish');
let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, err) { console.log(`  ✗ ${name}\n    ${err}`); fail++; }
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e.message); } }
function assert(condition, message) { if (!condition) throw new Error(message); }

function isolatedHome(slug = 'recovery-doc') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-terminal-recovery-'));
  const docs = path.join(home, 'tdocs');
  fs.mkdirSync(path.join(docs, slug), { recursive: true });
  return { home, docs, slug };
}

function pathWithoutProvider(home) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.symlinkSync('/bin/bash', path.join(bin, 'bash'));
  // The missing-provider branch only checks for jq; it does not invoke it.
  fs.writeFileSync(path.join(bin, 'jq'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return `${bin}:/usr/bin:/bin`;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function startDeviceServer(port) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/auth/device/start') {
      return res.end(JSON.stringify({
        user_code: 'ABCD-1234',
        device_code: 'device-token',
        verification_uri: 'https://github.com/login/device',
        interval: 5,
        expires_in: 900,
      }));
    }
    if (req.url === '/api/auth/device/poll') {
      return res.end(JSON.stringify({ error: 'authorization_pending' }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function cancelPublish(args, expectedRetry, port, slug = 'recovery-doc') {
  return new Promise((resolve, reject) => {
    const fixture = isolatedHome(slug);
    const pending = path.join(fixture.home, '.tdoc', 'pending-signin.json');
    const config = path.join(fixture.home, '.tdoc', 'published.json');
    let stderr = '';
    let interrupted = false;
    const child = spawn(PUBLISH, args, {
      detached: true,
      env: {
        ...process.env,
        HOME: fixture.home,
        TDOC_DIR: fixture.docs,
        TDOC_HOSTED_BASE: `http://127.0.0.1:${port}`,
        TDOC_NO_BROWSER: '1',
        TDOC_SKIP_UPDATE_CHECK: '1',
        TDOC_PLATFORM: '',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      reject(new Error(`publish did not reach device wait; stderr:\n${stderr}`));
    }, 15000);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (!interrupted && stderr.includes('Waiting for GitHub approval')) {
        interrupted = true;
        process.kill(-child.pid, 'SIGINT');
      }
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      try {
        assert(interrupted, `publish exited before SIGINT; code=${code} signal=${signal}\n${stderr}`);
        assert(code === 130, `SIGINT should exit 130, got code=${code} signal=${signal}\n${stderr}`);
        assert(stderr.includes('GitHub sign-in canceled. No credential was saved.'),
          `cancel state was not explicit:\n${stderr}`);
        assert(stderr.includes(`[tdoc] Retry: ${expectedRetry}`),
          `retry command did not preserve the invocation:\n${stderr}`);
        assert(!/denied/i.test(stderr), `SIGINT was mislabeled as denied:\n${stderr}`);
        assert(!fs.existsSync(pending), 'pending-signin.json survived cancellation');
        assert(!fs.existsSync(config), 'a publish credential was saved after cancellation');
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        fs.rmSync(fixture.home, { recursive: true, force: true });
      }
    });
  });
}

(async () => {
  console.log('terminal onboarding recovery');

  for (const provider of ['cloudflare', 'vercel']) {
    await t(`missing ${provider} CLI preserves --platform in retry`, () => {
      const fixture = isolatedHome();
      try {
        const result = spawnSync(PUBLISH, ['--platform', provider, fixture.slug], {
          env: {
            ...process.env,
            HOME: fixture.home,
            TDOC_DIR: fixture.docs,
            PATH: pathWithoutProvider(fixture.home),
            TDOC_SKIP_UPDATE_CHECK: '1',
            TDOC_PLATFORM: '',
          },
          encoding: 'utf8',
          timeout: 20000,
        });
        assert(result.status === 1, `expected exit 1, got ${result.status}: ${result.stderr}`);
        const retry = `/tdoc publish --platform ${provider} ${fixture.slug}`;
        assert(result.stderr.includes(retry), `missing exact retry ${retry}:\n${result.stderr}`);
      } finally {
        fs.rmSync(fixture.home, { recursive: true, force: true });
      }
    });
  }

  const port = await freePort();
  const server = await startDeviceServer(port);
  try {
    await t('SIGINT during sign-in-only clears state and prints its exact retry', () =>
      cancelPublish(['--signin-only'], '/tdoc publish --signin-only', port, 'signin'));

    const flags = [
      '--platform', 'hosted', '--visibility', 'private', '--history', 'owner',
      '--commenting', 'owner', '--allow-user', 'octocat', 'recovery-doc',
    ];
    await t('SIGINT during publish preserves the current slug and flags', () =>
      cancelPublish(
        flags,
        '/tdoc publish --platform hosted --visibility private --history owner --commenting owner --allow-user octocat recovery-doc',
        port,
      ));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
