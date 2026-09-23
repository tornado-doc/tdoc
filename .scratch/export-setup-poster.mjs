#!/usr/bin/env node
// One-off: render the real /setup shell HTML and screenshot the Mac desk.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, 'server/runtime');
const ASSETS = path.join(ROOT, 'assets');
const OUT_DIR = path.join(ROOT, '.scratch');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(RUNTIME, 'manifest.json'), 'utf8'));
const SHELL_JS = MANIFEST['shell/src/main.jsx'].file;
const SHELL_CSS = MANIFEST['shell/src/main.jsx'].css[0];

const MIME = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const boot = {
  page: 'setup',
  step: 'connect',
  identity: { login: 'julie', name: 'Julie', avatar_url: '' },
  oidcAuth: true,
  oidcLabel: 'Email',
  debug: false,
};

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tdoc setup export</title>
<link rel="stylesheet" href="/${SHELL_CSS}">
</head>
<body>
<div id="tdoc-app-root"></div>
<script>window.__TDOC_APP_BOOT__ = ${JSON.stringify(boot)};</script>
<script type="module" src="/${SHELL_JS}"></script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  if (p === '/' || p === '/setup') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  if (p === '/api/onboarding') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // Not paired → waiting connect step → ConnectReplay loops on the real desk.
    res.end(JSON.stringify({ record: { started_at: new Date().toISOString() }, paired: false }));
    return;
  }
  if (p === '/api/onboarding/event' || p.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p.startsWith('/shell.') || p.endsWith('.js') || p.endsWith('.css')) {
    sendFile(res, path.join(RUNTIME, path.basename(p)));
    return;
  }
  // Built shell asks for /mac/finder.png; repo files are assets/mac-finder.png.
  if (p.startsWith('/mac/')) {
    const leaf = p.slice('/mac/'.length); // finder.png | wallpaper.jpg
    const mapped = path.join(ASSETS, `mac-${leaf}`);
    if (fs.existsSync(mapped)) {
      sendFile(res, mapped);
      return;
    }
  }
  // Mac icons + wallpaper + logo live under /mac/... and root asset names.
  const assetName = p.replace(/^\//, '');
  const candidates = [
    path.join(ASSETS, assetName),
    path.join(ASSETS, path.basename(p)),
    path.join(RUNTIME, path.basename(p)),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      sendFile(res, c);
      return;
    }
  }
  res.writeHead(404);
  res.end('not found ' + p);
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
});

async function shoot(name, waitMs) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await page.goto(`${base}/setup`, { waitUntil: 'networkidle' });
  await page.waitForSelector('.sg-pane-art .rp-canvas, .sg-pane-art', { timeout: 20000 });
  await page.waitForTimeout(waitMs);
  const fullPath = path.join(OUT_DIR, `setup-poster-${name}-full.png`);
  await page.screenshot({ path: fullPath, type: 'png' });
  const deskPath = path.join(OUT_DIR, `setup-poster-${name}-desk.png`);
  await page.locator('.sg-pane-art').screenshot({ path: deskPath, type: 'png' });
  console.log(fullPath);
  console.log(deskPath);
  await page.close();
}

// Approve sheet (~9.5–10.5s) and post-approve “Device login approved” (~11–12s).
await shoot('approve', 9800);
await shoot('approved', 11200);

await browser.close();
server.close();
