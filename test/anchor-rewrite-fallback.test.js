// A comment whose sentence was rewritten must stay where the sentence was.
//
// Republishing a document rewrites its prose. The anchor stores the commented
// text and its two neighbours, and the probe only ever searched for the text —
// so once an author reworded that sentence, every comment on it resolved to
// nothing and the whole set collapsed into one pile (#460). Five comments
// spread across a long document arrived stacked on top of each other, which
// reads as "the comments are gone" even though every one of them was saved.
//
// The neighbours usually survive the rewrite. This suite publishes v1, comments
// on a sentence, publishes a v2 that rewords exactly that sentence, and asks
// where the comment went:
//
//   - it lands beside the surviving neighbour, not at the foot of the page
//   - it reads unanchored, because a neighbour is a guess and the card must
//     say so rather than point confidently at somebody else's words
//   - it paints no highlight — an approximate range must not underline prose
//     the person never selected
//
// and the opposite case, where the neighbours are gone too, must still take the
// seat at the end rather than invent a position.
//
// Run with: node test/anchor-rewrite-fallback.test.js

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { requirePlaywrightOrSkip, reservePort } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('anchor-rewrite-fallback.test.js');

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

// Tall on purpose: the seat sits near the bottom, so a document that fits on one
// screen cannot tell "landed beside its neighbour" apart from "took the seat".
const filler = (tag) => Array.from({ length: 14 }, (_, i) =>
  `<p>${tag} 段落 ${i + 1}：这一段只是把文档撑高，好让位置的差别量得出来。</p>`).join('\n');

const V1 = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>rewrite</title></head><body>
<h1>rewrite</h1>
${filler('前')}
<p id="keep-before">锚点前面这一句在两个版本里一字不改，是唯一的坐标。</p>
<p id="target">这句话会在第二版里被整段改写，一个字都不留下。</p>
<p id="keep-after">锚点后面这一句同样保持原样，可以从另一侧定位。</p>
${filler('后')}
<p id="orphan-before">孤儿评论的上文，第二版里会连它一起删掉。</p>
<p id="orphan">这句连同它的邻居会在第二版里彻底消失。</p>
<p id="orphan-after">孤儿评论的下文，第二版里也一并删掉。</p>
</body></html>`;

// Same document with the two commented sentences rewritten. The first one's
// neighbours are untouched; the second one's neighbours go with it.
const V2 = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>rewrite</title></head><body>
<h1>rewrite</h1>
${filler('前')}
<p id="keep-before">锚点前面这一句在两个版本里一字不改，是唯一的坐标。</p>
<p id="target">完全不同的措辞，与上一版没有任何共同的字。</p>
<p id="keep-after">锚点后面这一句同样保持原样，可以从另一侧定位。</p>
${filler('后')}
<p>孤儿那三段整体换成了这一句，上下文一起没了。</p>
</body></html>`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-rewrite-'));
  const slug = 'rewrite';
  for (const [n, html] of [[1, V1], [2, V2]]) {
    fs.mkdirSync(path.join(root, slug, `v${n}`), { recursive: true });
    fs.writeFileSync(path.join(root, slug, `v${n}`, 'index.html'), html);
  }
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(root, slug, 'meta.json'), JSON.stringify({
    slug, title: 'rewrite', versions: [{ n: 1, created: now }, { n: 2, created: now }],
  }, null, 2));
  const commentsFile = path.join(root, slug, 'comments.json');
  fs.writeFileSync(commentsFile, '[]');

  const port = await reservePort();
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, TDOC_DIR: root, TDOC_PORT: String(port), TDOC_E2E_USER: 'tester' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const at = (n) => `http://127.0.0.1:${port}/d/${slug}/v/${n}`;
  let browser;

  // Pins arrive by postMessage; reading them is more honest than reading the
  // rail, which only draws what is currently on screen.
  async function pinsOn(url) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.addInitScript(() => {
      window.__pins = [];
      window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'tdoc:pins' && event.data.pins) window.__pins = event.data.pins;
      }, true);
    });
    try {
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      const frame = page.frames().find((f) => f.url().includes('/frame'));
      const geometry = await frame.evaluate(() => {
        const box = (id) => {
          const el = document.getElementById(id);
          if (!el) return null;
          const rect = el.getBoundingClientRect();
          return Math.round(rect.top + (window.scrollY || 0));
        };
        const highlight = window.CSS && CSS.highlights && CSS.highlights.get('tdoc-anchor');
        return {
          docHeight: document.documentElement.scrollHeight,
          keepBefore: box('keep-before'),
          keepAfter: box('keep-after'),
          highlighted: highlight ? highlight.size : 0,
        };
      });
      return { pins: await page.evaluate(() => window.__pins), ...geometry };
    } finally {
      await page.close();
    }
  }

  // Comment on a sentence the way a person does: select it, type, submit.
  async function commentOn(elementId, body) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await page.goto(at(1), { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      const frame = page.frames().find((f) => f.url().includes('/frame'));
      await frame.evaluate((id) => {
        const node = document.getElementById(id).firstChild;
        node.parentElement.scrollIntoView({ block: 'center' });
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, node.textContent.length);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, view: window }));
      }, elementId);
      await page.waitForTimeout(400);
      assert(await page.$('.tdoc-popup textarea'), `the composer never opened on #${elementId}`);
      await page.fill('.tdoc-popup textarea', body);
      await page.click('.tdoc-popup .submit');
      await page.waitForTimeout(900);
    } finally {
      await page.close();
    }
  }

  console.log('anchor rewrite fallback — a reworded sentence keeps its comments in place');
  try {
    await waitForServer(port);
    browser = await chromium.launch({ headless: true });

    await commentOn('target', 'this sentence gets rewritten');
    await commentOn('orphan', 'this sentence and its neighbours vanish');
    const saved = JSON.parse(fs.readFileSync(commentsFile, 'utf8'));
    assert(saved.length === 2, `expected 2 saved comments, got ${saved.length}`);
    const [rewritten, orphaned] = saved;

    const v1 = await pinsOn(at(1));
    await test('both comments anchor exactly on the version they were written on', () => {
      const ids = v1.pins.map((p) => p.id);
      assert(ids.includes(rewritten.id) && ids.includes(orphaned.id),
        `v1 lost a pin: ${JSON.stringify(ids)}`);
      const stillLost = v1.pins.filter((p) => p.lost).map((p) => p.id);
      assert(!stillLost.length, `v1 should anchor both exactly, but ${JSON.stringify(stillLost)} read unanchored`);
    });

    const v2 = await pinsOn(at(2));
    const seatY = Math.max(0, v2.docHeight - 160);
    const pinOf = (id) => v2.pins.find((p) => p.id === id);

    await test('a comment on a rewritten sentence lands beside its surviving neighbour', () => {
      const pin = pinOf(rewritten.id);
      assert(pin, 'the comment vanished from v2 entirely');
      // Between the two untouched neighbours, give or take a line — not at the
      // foot of the page, which is where every lost comment used to pile up.
      const low = Math.min(v2.keepBefore, v2.keepAfter) - 80;
      const high = Math.max(v2.keepBefore, v2.keepAfter) + 80;
      assert(pin.docY >= low && pin.docY <= high,
        `landed at ${pin.docY}, expected between ${low} and ${high} `
        + `(#keep-before ${v2.keepBefore}, #keep-after ${v2.keepAfter}, seat ${seatY})`);
      assert(Math.abs(pin.docY - seatY) > 100, `it took the seat at ${seatY} instead of the neighbourhood`);
    });

    await test('that comment reads unanchored, because a neighbour is a guess', () => {
      assert(pinOf(rewritten.id).lost === true,
        'the pin claims to be anchored — the card would offer no Re-anchor and show no dashed edge');
    });

    await test('an approximate spot paints no highlight over prose nobody selected', () => {
      assert(v2.highlighted === 0,
        `${v2.highlighted} range(s) highlighted in v2, but neither anchor's text survives`);
    });

    await test('a comment whose neighbours are gone too still takes the seat', () => {
      const pin = pinOf(orphaned.id);
      assert(pin, 'the orphaned comment vanished from v2 entirely');
      assert(pin.lost === true, 'a seated comment must read unanchored');
      assert(Math.abs(pin.docY - seatY) <= 8,
        `expected the seat at ${seatY}, got ${pin.docY} — it guessed a position it cannot justify`);
    });

    await test('no comment is dropped at the top of the page', () => {
      const stuck = v2.pins.filter((p) => p.docY <= 0).map((p) => p.id);
      assert(!stuck.length,
        `${JSON.stringify(stuck)} landed at y=0 — a match on a node with no layout, not a position`);
    });
  } finally {
    if (browser) await browser.close();
    try { server.kill('SIGTERM'); } catch (e) { /* already gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
