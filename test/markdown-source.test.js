// Edit as Markdown's conversion (flag markdownEditMode;
// shell/src/document/markdown-source.js): a plain doc round-trips; unchanged
// Markdown gives back the very same HTML; an edit leaves every other block
// byte for byte and keeps the edited block's attributes; blocks Markdown
// can't show stay HTML behind a placeholder (moved, copied, deleted); a doc
// made only of them is refused with a reason; nothing typed in Markdown
// becomes markup outside the allow-list.
const assert = require('assert/strict');

(async () => {
  console.log('markdown source (Edit as Markdown)');
  const { toMarkdown, fromMarkdown, markdownToHtml, sanitizeHtml, parseFragment } = await import('../shell/src/document/markdown-source.js');
  let failed = 0;
  const t = (name, fn) => {
    try { fn(); console.log(`  ✓ ${name}`); } catch (error) { failed++; console.log(`  ✗ ${name}\n    ${error.stack || error.message}`); }
  };

  const PLAIN = '\n<h1>Launch notes</h1>\n<p id="intro" data-tdoc-aid="a1">We ship the <strong>new</strong> reader on <em>Monday</em> &amp; more, see <a href="https://tdoc.dev">tdoc</a> or <code>tdoc help</code>.</p>\n<h2>Plan</h2>\n<ul><li>one</li><li>two <b>bold</b></li></ul>\n<ol><li>first</li><li>second</li></ol>\n<blockquote><p>quoted</p></blockquote>\n<pre><code class="language-js">const a = 1 &lt; 2;\n</code></pre>\n<table><thead><tr><th>Area</th><th>Owner</th></tr></thead><tbody><tr><td>Reader</td><td>Ana</td></tr></tbody></table>\n<hr>\n<p>It\'s 100% done!</p>\n';
  const CARDS = '<div class="tdoc-cards"><div class="tdoc-card"><h3>A</h3><p>x</p></div></div>';
  const NOTE = '<aside class="note"><p>Careful</p></aside>';
  const SHEET = '<table data-tdoc-sheet=""><thead><tr><th>A</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>';
  const MIXED = `<p>Intro</p>\n${CARDS}\n${NOTE}\n<p>Has <span style="color:red">red</span> words</p>\n${SHEET}\n<details><summary>More</summary><p>hidden</p></details>\n<figure><img src="/a.png" alt="A"><figcaption>Fig</figcaption></figure>\n<p>Outro</p>\n`;

  t('a plain doc is all Markdown, readable, with no placeholders', () => {
    const r = toMarkdown(PLAIN);
    assert.equal(r.ok, true);
    assert.equal(r.kept, 0);
    for (const line of ['# Launch notes', 'We ship the **new** reader on *Monday* & more, see [tdoc](https://tdoc.dev) or `tdoc help`.', '- one\n- two **bold**', '1. first\n2. second', '> quoted', '```js\nconst a = 1 < 2;\n```', '| Area | Owner |', '---', "It's 100% done!"]) {
      assert.ok(r.markdown.includes(line), `missing ${JSON.stringify(line)} in\n${r.markdown}`);
    }
  });

  t('unchanged Markdown gives back the very same HTML', () => {
    for (const html of [PLAIN, MIXED, '', '<p>only</p>']) {
      const r = toMarkdown(html);
      assert.equal(r.ok, true);
      assert.equal(fromMarkdown(r.markdown, r.snapshot).bodyHtml, html);
    }
  });

  t('Markdown read back gives the same blocks (plain doc, through marked)', () => {
    const r = toMarkdown(PLAIN);
    const back = toMarkdown(markdownToHtml(r.markdown));
    assert.equal(back.markdown, r.markdown);
  });

  t('an edit keeps every other block byte for byte and the edited block\'s attributes', () => {
    const r = toMarkdown(PLAIN);
    const out = fromMarkdown(r.markdown.replace('on *Monday*', 'on *Tuesday*') + '\nA new line.\n', r.snapshot).bodyHtml;
    assert.match(out, /<p id="intro" data-tdoc-aid="a1">We ship the <strong>new<\/strong> reader on <em>Tuesday<\/em> &amp; more/);
    for (const block of ['<h1>Launch notes</h1>', '<ul><li>one</li><li>two <b>bold</b></li></ul>', '<pre><code class="language-js">const a = 1 &lt; 2;\n</code></pre>', '<table><thead><tr><th>Area</th><th>Owner</th></tr></thead><tbody><tr><td>Reader</td><td>Ana</td></tr></tbody></table>']) {
      assert.ok(out.includes(block), `changed: ${block}`);
    }
    assert.ok(out.includes('<p>A new line.</p>'));
  });

  t('a heading turned into a paragraph drops the heading\'s attributes, not its words', () => {
    const r = toMarkdown('<h2 id="x">Title</h2>\n<p>Body</p>');
    const out = fromMarkdown(r.markdown.replace('## Title', 'Title'), r.snapshot).bodyHtml;
    assert.ok(out.includes('<p>Title</p>') && !out.includes('id="x"'), out);
  });

  t('blocks Markdown can\'t show are placeholders, runs grouped, and come back byte for byte', () => {
    const r = toMarkdown(MIXED);
    assert.equal(r.ok, true);
    const keeps = r.markdown.match(/<!-- tdoc:keep \d+ [^\n]*-->/g);
    assert.equal(keeps.length, 1, r.markdown);
    assert.match(keeps[0], /^<!-- tdoc:keep 1 · cards: A x \(\+5 more\) -->$/);
    const out = fromMarkdown(r.markdown.replace('Intro', 'Intro, edited').replace('Outro', 'Outro, edited'), r.snapshot).bodyHtml;
    for (const block of [CARDS, NOTE, '<p>Has <span style="color:red">red</span> words</p>', SHEET, '<details><summary>More</summary><p>hidden</p></details>', '<figure><img src="/a.png" alt="A"><figcaption>Fig</figcaption></figure>']) {
      assert.ok(out.includes(block), `not kept: ${block}`);
    }
    assert.ok(out.includes('<p>Intro, edited</p>') && out.includes('<p>Outro, edited</p>'));
  });

  t('a placeholder moved or copied brings its HTML; deleted, it is counted', () => {
    const r = toMarkdown(`<p>A</p>\n${CARDS}\n<p>B</p>`);
    const keep = r.markdown.match(/<!-- tdoc:keep 1[^\n]*-->/)[0];
    const moved = fromMarkdown(`B\n\n${keep}\n\nA\n`, r.snapshot);
    assert.ok(moved.bodyHtml.indexOf(CARDS) > moved.bodyHtml.indexOf('B'), moved.bodyHtml);
    assert.equal(moved.removedKept, 0);
    const copied = fromMarkdown(`${r.markdown}\n${keep}\n`, r.snapshot);
    assert.equal(copied.bodyHtml.split(CARDS).length - 1, 2);
    const deleted = fromMarkdown('A\n\nB\n', r.snapshot);
    assert.ok(!deleted.bodyHtml.includes('tdoc-cards'));
    assert.equal(deleted.removedKept, 1);
  });

  t('a placeholder with an unknown number, or typed inline, stays text', () => {
    const r = toMarkdown('<p>A</p>');
    const out = fromMarkdown('A\n\n<!-- tdoc:keep 9 · cards -->\n\nx <!-- tdoc:keep 1 --> y\n', r.snapshot).bodyHtml;
    assert.ok(out.includes('&lt;!-- tdoc:keep 9 · cards --&gt;'), out);
    assert.ok(out.includes('x &lt;!-- tdoc:keep 1 --&gt; y'), out);
  });

  t('a doc made only of blocks Markdown can\'t show is refused, with the reason', () => {
    const r = toMarkdown(`${CARDS}\n${SHEET}`);
    assert.equal(r.ok, false);
    assert.match(r.reason, /Markdown can't show/);
    assert.equal(toMarkdown('<div><p>unclosed').ok, false);
  });

  t('a doc wrapped in one plain container: its blocks are Markdown, the wrapper stays', () => {
    const html = '<div class="page">\n<h1>T</h1>\n<p>Body</p>\n</div>\n<script>x()</script>';
    const r = toMarkdown(html);
    assert.equal(r.ok, true);
    assert.equal(r.markdown, '# T\n\nBody\n');
    assert.equal(fromMarkdown('# T\n\nBody two\n', r.snapshot).bodyHtml, '<div class="page">\n<h1>T</h1>\n<p>Body two</p>\n</div>\n<script>x()</script>');
  });

  t('two lists in a row (which Markdown reads as one): the second stays HTML', () => {
    const r = toMarkdown('<ul><li>a</li></ul><ul><li>b</li></ul>');
    assert.equal(r.ok, true);
    assert.match(r.markdown, /^- a\n\n<!-- tdoc:keep 1 · list: b -->\n$/);
    const out = fromMarkdown(r.markdown.replace('- a', '- a2'), r.snapshot).bodyHtml;
    assert.ok(out.includes('<ul><li>b</li></ul>'), out);
  });

  t('nothing typed in Markdown becomes markup outside the allow-list', () => {
    const r = toMarkdown('<p>A</p>');
    const evil = [
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      '[x](javascript:alert(1))',
      '![x](data:text/html,<script>alert(1)</script>)',
      '[x](  JAVASCRIPT:alert(1))',
      '<iframe src="https://evil"></iframe>',
      '<a href="https://ok" onclick="alert(1)">y</a>',
      '<div style="position:fixed">z</div>',
    ].join('\n\n');
    const out = fromMarkdown(`A\n\n${evil}\n`, r.snapshot).bodyHtml;
    const nodes = parseFragment(out);
    const walk = (list) => list.forEach((n) => {
      if (n.type !== 'el') return;
      assert.ok(['p', 'a', 'img', 'em', 'strong', 'code'].includes(n.tag), `tag ${n.tag}`);
      n.attrs.forEach(([k, v]) => {
        assert.ok(!/^on/.test(k) && k !== 'style', `attr ${k}`);
        if (k === 'href' || k === 'src') assert.ok(!/^\s*(javascript|data):/i.test(v), `${k}=${v}`);
      });
      walk(n.children);
    });
    walk(nodes);
    assert.ok(!/<script|<iframe|onerror=|onclick=|javascript:/i.test(out.replace(/&lt;[^&]*&gt;/g, '')), out);
  });

  t('the sanitizer unwraps unknown tags and keeps safe links', () => {
    assert.equal(sanitizeHtml('<p onclick="x">a <span>b</span> <a href="https://t.dev" target="_blank">c</a><style>p{}</style></p>'), '<p>a b <a href="https://t.dev">c</a></p>');
    assert.equal(sanitizeHtml('<a href="mailto:a@b.c">m</a><a href="/d/x#y">r</a>'), '<a href="mailto:a@b.c">m</a><a href="/d/x#y">r</a>');
  });

  t('linear enough: 2,000 blocks convert and round-trip within budget', () => {
    const html = Array.from({ length: 2000 }, (_, i) => (i % 50 === 0 ? CARDS : `<p>Paragraph ${i} with <strong>bold</strong> text.</p>`)).join('\n');
    const t0 = Date.now();
    const r = toMarkdown(html);
    const out = fromMarkdown(r.markdown.replace('Paragraph 7 ', 'Paragraph seven '), r.snapshot).bodyHtml;
    const ms = Date.now() - t0;
    assert.ok(out.includes('<p>Paragraph seven with <strong>bold</strong> text.</p>'));
    assert.equal(out.length, html.length + 4);
    assert.ok(ms < 8000, `${ms} ms`);
  });

  if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
})();
