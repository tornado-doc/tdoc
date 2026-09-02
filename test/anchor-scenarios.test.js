// Anything the cursor can select must be able to carry a comment.
//
// A text comment is saved by the shell and re-found by the frame probe on the
// next load. When the probe cannot re-find it there is no pin, and on a wide
// viewport the gutter is pins-only — so the comment is saved, invisible, and
// unreachable. Nothing warned anyone at any point (#387).
//
// The probe used to refuse in three ways a person selecting text would not
// predict: a run shorter than two characters, text that occurs more than once
// where the saved context could not tell the copies apart, and a selection
// crossing a <br> (#339). Visual documents hit all three at once — the same
// short label sits in a card and again in the figure beside it.
//
// Each case posts a real comment through the composer, reloads, and asks two
// questions: did a pin come back, and did the highlight land on the copy that
// was selected. A pin in the wrong place is not a pass.
//
// Run with: node test/anchor-scenarios.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('anchor-scenarios.test.js');

let pass = 0, fail = 0;
function ok(name) { console.log(`  ✓ ${name}`); pass++; }
function bad(name, error) { console.log(`  ✗ ${name}\n    ${error.message || error}`); fail++; }
async function test(name, operation) {
  try { await operation(); ok(name); } catch (error) { bad(name, error); }
}
function assert(condition, message) { if (!condition) throw new Error(message); }

function waitForServer(port, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    (function poll() {
      const request = http.get({ host: '127.0.0.1', port, path: '/' }, (response) => {
        response.resume(); resolve();
      });
      request.on('error', () => {
        if (Date.now() >= deadline) reject(new Error('local anchor server did not start'));
        else setTimeout(poll, 80);
      });
    })();
  });
}

// A document shaped like the ones this breaks on: cards, a two-column grid, a
// figure whose labels repeat text from the prose, and a paragraph pair to
// select across.
const DOC = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>anchors</title>
<style>body{background:#fff}.card{border:1px solid #111;padding:12px;margin:16px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}</style>
</head><body><div class="wrap">
<h1>anchors</h1>
<p id="plain">搜索实用 内容的读者会先看到这一行普通段落。</p>
<section class="card" data-tdoc-artifact id="a1"><h3>Useful Documenter</h3>
<p id="brline">行程 / before-after<br>攻略 · 垂类爱好者</p></section>
<div class="grid">
  <section class="card" data-tdoc-artifact id="a2"><h3 id="h2card">垂类专业者</h3></section>
  <section class="card" data-tdoc-artifact id="a3"><p id="repeat">搜索实用</p></section>
</div>
<figure data-tdoc-artifact><svg viewBox="0 0 320 50" width="100%" role="img" aria-label="flow">
  <text id="svgtext" x="4" y="20" font-size="12">搜索实用</text>
  <text x="150" y="20" font-size="12">垂类专业者</text></svg></figure>
<p id="blockA">这一行的结尾接着</p><p id="blockB">下一段的开头，选中会跨两个块。</p>
<div id="matrix">
  <p id="row1">✓ 支持 · 每月</p>
  <p id="row2">✓ 支持 · 每月</p>
  <p id="row3">✓ 支持 · 每月</p>
  <p id="row4">✓ 支持 · 每月</p>
  <p id="row5">✓ 支持 · 每月</p>
  <p id="row6">✓ 支持 · 每月</p>
  <p id="row7">✓ 支持 · 每月</p>
  <p id="row8">✓ 支持 · 每月</p>
  <p id="row9">✓ 支持 · 每月</p>
  <p id="row10">✓ 支持 · 每月</p>
  <p id="row11">✓ 支持 · 每月</p>
  <p id="row12">✓ 支持 · 每月</p>
</div>
</div></body></html>`;

// Each case says where to select and which element the highlight must come
// back in — naming the element, not an offset, so the assertion survives the
// document being restyled.
const CASES = [
  ['a short run in a paragraph', 'plain',
    () => { const n = document.querySelector('#plain').firstChild; const r = document.createRange(); r.setStart(n, 2); r.setEnd(n, 4); return r; }],
  ['a single character', 'plain',
    () => { const n = document.querySelector('#plain').firstChild; const r = document.createRange(); r.setStart(n, 2); r.setEnd(n, 3); return r; }],
  ['a heading inside a card', 'h2card',
    () => { const n = document.querySelector('#h2card').firstChild; const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 3); return r; }],
  ['a selection crossing a <br>', 'brline',
    () => { const p = document.querySelector('#brline'); const r = document.createRange(); r.setStart(p.childNodes[0], 8); r.setEnd(p.childNodes[2], 4); return r; }],
  ['text that also appears in another card', 'repeat',
    () => { const n = document.querySelector('#repeat').firstChild; const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 4); return r; }],
  ['the same text where it appears in the prose', 'plain',
    () => { const n = document.querySelector('#plain').firstChild; const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 4); return r; }],
  ['the same text again, inside an SVG figure', 'svgtext',
    () => { const n = document.querySelector('#svgtext').firstChild; const r = document.createRange(); r.setStart(n, 0); r.setEnd(n, 4); return r; }],
  ['a selection spanning two blocks', 'blockA',
    () => { const a = document.querySelector('#blockA').firstChild; const b = document.querySelector('#blockB').firstChild; const r = document.createRange(); r.setStart(a, 3); r.setEnd(b, 4); return r; }],
  // Three rows that read identically — a comparison matrix, which is a shape
  // tdoc's own visuals reach for. Context cannot separate the last two: their
  // neighbourhoods are the same characters. Only the occurrence recorded when
  // the selection was made can, and picking the wrong row is worse than not
  // anchoring, because it looks anchored.
  ['a row in a block of rows that all read the same', 'row9',
    () => { const n = document.querySelector('#row9').firstChild; const r = document.createRange(); r.setStart(n, 2); r.setEnd(n, 4); return r; }],
];

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-anchors-'));
  const slug = 'anchors';
  fs.mkdirSync(path.join(root, slug, 'v1'), { recursive: true });
  fs.writeFileSync(path.join(root, slug, 'v1', 'index.html'), DOC);
  fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({
    slug, title: 'anchors', versions: [{ n: 1, created: new Date().toISOString() }],
  }, null, 2));
  const commentsFile = path.join(root, slug, 'comments.json');

  // Not a fixed port: another process answering would quietly become the
  // subject of the suite.
  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'tester' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const url = `http://127.0.0.1:${port}/d/${slug}/v/1`;
  let browser;

  console.log('anchor scenarios — everything selectable can carry a comment');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });

    for (const [name, expectedId, pick] of CASES) {
      // One comment at a time, so "is there a pin" has exactly one answer.
      fs.writeFileSync(commentsFile, '[]');
      // eslint-disable-next-line no-await-in-loop
      await test(name, async () => {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        try {
          await page.goto(url, { waitUntil: 'networkidle' });
          await page.waitForTimeout(600);
          const frame = page.frames().find((f) => f.url().includes('/frame'));
          assert(frame, 'author frame never loaded');
          await frame.evaluate((source) => {
            // eslint-disable-next-line no-new-func
            const range = new Function(`return (${source})()`)();
            // A selection below the fold puts the composer off screen, and the
            // test cannot click what it cannot reach.
            const anchorEl = range.startContainer.parentElement;
            if (anchorEl && anchorEl.scrollIntoView) anchorEl.scrollIntoView({ block: 'center' });
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
            document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
          }, pick.toString());
          await page.waitForTimeout(350);
          assert(await page.$('.tdoc-popup textarea'), 'the composer never opened for this selection');
          await page.fill('.tdoc-popup textarea', 'anchor probe');
          await page.click('.tdoc-popup .submit');
          await page.waitForTimeout(900);

          const saved = JSON.parse(fs.readFileSync(commentsFile, 'utf8'))[0];
          assert(saved, 'the comment was not saved at all');

          await page.goto(url, { waitUntil: 'networkidle' });
          await page.waitForTimeout(1100);
          // Pins are only drawn for anchors inside the viewport, so bring the
          // anchor into view before asking whether it has one — otherwise this
          // measures where the page happens to be scrolled.
          const frameAfter = page.frames().find((f) => f.url().includes('/frame'));
          await frameAfter.evaluate((id) => {
            const el = document.getElementById(id);
            if (el) el.scrollIntoView({ block: 'center' });
          }, expectedId);
          await page.waitForTimeout(700);
          const pins = await page.$$eval('.tdoc-pin', (nodes) => nodes.map((n) => n.dataset.id));
          assert(pins.includes(saved.id),
            `saved but no pin — the comment is invisible on a wide viewport (anchor ${JSON.stringify(saved.anchor.text)})`);

          // …and on the copy that was selected, not another one.
          const frame2 = page.frames().find((f) => f.url().includes('/frame'));
          // Which element the highlight covers — asked as "does it touch this
          // element", not "which node does it start in". A range that begins
          // at the end of the preceding text node covers the same characters;
          // locateAt resolves an offset that is both one node's end and the
          // next one's start to the former, so the container is not the
          // question. What it lands ON is.
          const landed = await frame2.evaluate((id) => {
            const highlight = window.CSS && CSS.highlights && CSS.highlights.get('tdoc-anchor');
            if (!highlight) return { covers: false, text: null, why: 'nothing is highlighted' };
            const target = document.getElementById(id);
            if (!target) return { covers: false, text: null, why: `no #${id} in the document` };
            for (const range of highlight) {
              if (range.intersectsNode(target)) return { covers: true, text: range.toString() };
            }
            return { covers: false, text: [...highlight].map((r) => r.toString()).join(' | ') };
          }, expectedId);
          assert(landed.covers,
            `the anchor did not come back on the copy that was selected (#${expectedId}) — `
            + `${landed.why || `it highlighted ${JSON.stringify(landed.text)} somewhere else`}`);
        } finally {
          await page.close();
        }
      });
    }
  } finally {
    if (browser) await browser.close();
    try { server.kill('SIGTERM'); } catch (e) { /* already gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
