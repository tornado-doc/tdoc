#!/usr/bin/env node
// Renders tools/home-card/card.html to the homepage share card (1200x630 PNG).
//
//   node tools/home-card/render.mjs [out.png]
//
// Default output is assets/tdoc_home-card-v1.png, served at that name by
// server/server.js and (inlined by bin/tdoc-bundle) by worker/worker.js as the
// og:image of /, /pricing, /start, /templates and /privacy. The name is
// cache-busted like tdoc_logo-v2.png: X and other crawlers keep an image by
// URL, so a redesign ships as -v2 (rename the file here, in tdoc-bundle,
// test/helpers/worker-harness.js and HOME_CARD_PATH in both servers).
// The card uses the landing page's system-ui stack; render on macOS so it
// matches the site (SF Pro).
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || path.join(here, '..', '..', 'assets', 'tdoc_home-card-v1.png'));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(pathToFileURL(path.join(here, 'card.html')).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
  console.log(out);
} finally {
  await browser.close();
}
