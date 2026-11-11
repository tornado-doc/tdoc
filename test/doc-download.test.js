// Download as PDF / Word / Markdown / CSV / Excel, offline:
//   - Markdown: the server's text conversion as a file (/export.md): the
//     document's own text, headings at their levels, lists, tables with a
//     header rule, code fences, links; no preamble, no comments; the same
//     gate as reading the doc; an attachment named <slug>.md
//   - Word: the .docx built in the browser (docx-export.mjs) from a sample
//     doc: every part well-formed, headings, lists, links, code, tables,
//     images embedded, an interactive island as a line linking to the doc
//   - Sheets: CSV of one tab (formula-safe) and an Excel workbook of all tabs
//   - the frame answers tdoc:exportHtml and says what the doc is
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parseHtml } = require('./helpers/mini-dom.js');
const { loadWorker, makeEnv, issue } = require('./helpers/worker-harness.js');

const ROOT = path.join(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures', 'doc-download');
const SAMPLE = fs.readFileSync(path.join(FIX, 'q3-plan.html'), 'utf8');
const SHEET = fs.readFileSync(path.join(FIX, 'expenses.html'), 'utf8');
const SHELL = require(path.join(ROOT, 'server', 'shell.js'));

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name}\n    ${e && e.stack ? e.stack : e}`); fail++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// A stored zip (what zipStore writes) → { name: Buffer }.
function unzip(bytes) {
  const buf = Buffer.from(bytes);
  const out = {};
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const method = buf.readUInt16LE(at + 8);
    const crc = buf.readUInt32LE(at + 14);
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const extra = buf.readUInt16LE(at + 28);
    const name = buf.slice(at + 30, at + 30 + nameLen).toString('utf8');
    const data = buf.slice(at + 30 + nameLen + extra, at + 30 + nameLen + extra + size);
    assert(method === 0, `${name}: not stored`);
    if (typeof zlib.crc32 === 'function') assert(zlib.crc32(data) === crc, `${name}: bad CRC`);
    out[name] = data;
    at += 30 + nameLen + extra + size;
  }
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert(end > 0 && buf.readUInt16LE(end + 10) === Object.keys(out).length, 'central directory count');
  return out;
}

// Tags balance and every attribute is quoted: enough to catch a part Word
// would refuse as corrupt.
function wellFormed(name, text) {
  const stack = [];
  const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>|<\?[^?]*\?>|<([^?/A-Za-z])/g;
  let m;
  while ((m = re.exec(text))) {
    if (m[5] != null) throw new Error(`${name}: stray < at ${m.index}`);
    if (!m[2]) continue;
    if (m[4]) continue;
    if (m[1]) {
      const open = stack.pop();
      if (open !== m[2]) throw new Error(`${name}: </${m[2]}> closes <${open}>`);
    } else stack.push(m[2]);
  }
  assert(!stack.length, `${name}: unclosed ${stack.join(', ')}`);
  const stripped = text.replace(re, '');
  assert(!/[<>]/.test(stripped), `${name}: raw < or > in text`);
}

(async () => {
  console.log('Download as PDF / Word / Markdown / CSV / Excel');

  // ---- Markdown ----
  await t('Markdown: the document\'s text, structured, with no preamble or comments', async () => {
    const md = SHELL.documentMarkdown(SAMPLE, { title: 'Q3 launch plan', baseUrl: 'https://tdoc.dev/d/q3-plan/v/1/', docUrl: 'https://tdoc.dev/d/q3-plan/v/1' });
    for (const want of [
      '# Q3 launch plan\n\nWe ship the **importer** first, then *billing*. Read [the spec](https://example.com/spec) or the [team notes](https://tdoc.dev/d/q3-plan/v/1/notes); run `tdoc-pull q3` to see comments.',
      '## Milestones\n\n- Importer — July\n  - CSV and XLSX\n  - Google Sheets link\n- Billing — August\n\n3. Beta invite\n4. Public launch',
      '> Ship the smallest thing that a team will pay for.',
      '| Owner | Item | Due |\n| --- | --- | --- |\n| Ana | Importer | 2026-07-15 |\n| Bo | Billing \\| invoices | 2026-08-20 |',
      '### Setup\n\n```bash\nnpm install\n  tdoc-new --slug q3 \\\n    --from-csv owners.csv\n```',
      '[image: Revenue by month]',
      '*[Figure or interactive content: see the online document: https://tdoc.dev/d/q3-plan/v/1]*',
      '| Line | Amount | Tags |\n| --- | --- | --- |\n| Ads | 1,200 | growth q3 |',
    ]) assert(md.includes(want), `markdown lacks:\n${want}\n--- got:\n${md}`);
    assert(md.indexOf('# Q3 launch plan') === 0 && md.split('# Q3 launch plan').length === 2, 'title once, at the top');
    for (const never of ['stolen', 'tdoc document', 'Comments (', 'font:', 'Document text']) assert(!md.includes(never), `markdown carries ${never}`);
    // A doc without its own h1 gets the title as one.
    assert(SHELL.documentMarkdown('<p>Just text</p>', { title: 'Notes' }) === '# Notes\n\nJust text\n', 'title heading');
  });

  await t('Markdown: the agent text (Accept: text/markdown) is unchanged by the download mode', async () => {
    const view = SHELL.agentBlocksFromHtml(SAMPLE);
    const text = JSON.stringify(view.blocks);
    assert(!text.includes('**') && !text.includes('](') && !view.blocks.some((b) => b.t === 'code' || b.t === 'end' || b.t === 'embed'), 'rich blocks leaked into the agent view');
    assert(view.blocks.some((b) => b.t === 'p' && b.text.includes('the spec (https://example.com/spec)')), 'agent links kept as text (url)');
  });

  await t('Markdown: author text cannot become syntax; links cannot break out; fences outgrow their contents', async () => {
    const md = SHELL.documentMarkdown('<h2>a *b* [c](d)</h2><p>Use <code>a_b</code> and <code>x``y</code>, <b> bold </b>&lt;tag&gt; 2 * 3 &amp; _u_ ![x] \\ok</p>'
      + '<p><a href="https://e.com/a b(c)">see ](https://evil.example) </a> <a href="javascript:alert(1)">js</a></p><pre>a ```` b</pre>', { title: 'T*' });
    for (const want of ['# T\\*', '## a \\*b\\* \\[c\\](d)', 'Use `a_b` and ``` x``y ```, **bold** \\<tag\\> 2 \\* 3 \\& \\_u\\_ \\!\\[x\\] \\\\ok',
      '[see \\](https://evil.example) ](https://e.com/a%20b%28c%29) js', '`````\na ```` b\n`````']) {
      assert(md.includes(want), `lacks ${want}\n--- got:\n${md}`);
    }
    assert(!md.includes('javascript:'), 'a javascript: link survived');
  });

  await t('Markdown: an unclosed or misnested <code> never turns escaping off', async () => {
    const a = SHELL.documentMarkdown('<p><code>&lt;img src=x onerror=alert(1)&gt;</p><p>[x](javascript:alert(2))</p>');
    assert(a === '\\<img src=x onerror=alert(1)\\>\n\n\\[x\\](javascript:alert(2))\n', JSON.stringify(a));
    const b = SHELL.documentMarkdown('<p><code><b>&lt;img src=x onerror=alert(1)&gt;</code></b></p>');
    assert(b === '**\\<img src=x onerror=alert(1)\\>**\n', JSON.stringify(b));
    for (const md of [a, b]) assert(!/(^|[^\\])<img/.test(md) && !/(^|[^\\])\[x\]\(javascript:/.test(md), md);
    // A paired span is literal inside; the text after it is escaped again.
    const c = SHELL.documentMarkdown('<p><code>a_b &lt;i&gt;</code> &lt;i&gt; <code>`x`</code></p>');
    assert(c === '`a_b <i>` \\<i\\> `` `x` ``\n', JSON.stringify(c));
    // Image alt text is escaped too.
    const d = SHELL.documentMarkdown('<p><img src="https://e.com/i.png" alt="a](javascript:x) *b*"></p>');
    assert(d === '![a\\](javascript:x) \\*b\\*](https://e.com/i.png)\n', JSON.stringify(d));
  });

  await t('Markdown: linear time on hostile input (unclosed blocks, tags, declarations, marks; huge tables)', async () => {
    const cases = [
      ['2 MB of unclosed <svg>', '<p>x</p>' + '<svg>'.repeat(400000), 200],
      ['unclosed <script', '<p>x</p>' + '<script '.repeat(250000), 200],
      ['unterminated tags', '<p>' + '<a '.repeat(700000), 200],
      ['unterminated declarations', '<p>' + '<!x'.repeat(700000), 200],
      ['comments without an end', '<p>' + '<!--'.repeat(500000), 200],
      ['<head> with no end', '<p>' + '<head '.repeat(350000), 200],
      ['unclosed bold', '<p>' + '<b>x '.repeat(400000), 1500],
      ['250k bold pairs', '<p>' + '<b>x</b> '.repeat(250000), 2000],
      ['200k table rows', '<table>' + '<tr><td>1</td></tr>'.repeat(200000) + '</table>', 2000],
    ];
    for (const [name, html, budget] of cases) {
      const start = process.hrtime.bigint();
      SHELL.documentMarkdown(html, { title: 'T' });
      SHELL.agentBlocksFromHtml(html.slice(0, 256 * 1024));
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      assert(ms < budget, `${name}: ${ms.toFixed(0)} ms (budget ${budget})`);
    }
  });

  // ---- the route ----
  const mod = await loadWorker();
  const worker = mod.default;
  const env = makeEnv(mod.CommentsStore);
  const call = (p, o = {}) => worker.fetch(require('./helpers/worker-harness.js').req(p, o), env, {});
  const alice = await issue(worker, env, 'alice');
  const eve = await issue(worker, env, 'eve');
  const created = '2026-01-01T00:00:00.000Z';
  const seed = async (slug, title, access) => {
    await env.META.put(`meta:${slug}`, JSON.stringify({ title, slug, created, versions: [{ n: 1, created }], access, hosted: { account_id: alice.account_id, github_login: 'alice' } }));
    await env.DOCS.put(`docs/${slug}/v1/index.html`, SAMPLE);
  };
  await seed('q3-plan', 'Q3 launch plan', { visibility: 'public' });
  await seed('q3-secret', 'Secret plan', { visibility: 'private', allowed_users: [] });

  await t('/d/<slug>/v/<n>/export.md: an attachment named <slug>.md, Markdown, not cached', async () => {
    const r = await call('/d/q3-plan/v/1/export.md');
    assert(r.status === 200, `status ${r.status}`);
    assert((r.headers.get('content-type') || '').startsWith('text/markdown'), r.headers.get('content-type'));
    assert(r.headers.get('content-disposition') === 'attachment; filename="q3-plan.md"', r.headers.get('content-disposition'));
    assert(/no-store/.test(r.headers.get('cache-control') || ''), 'cache-control');
    const md = await r.text();
    assert(md.startsWith('# Q3 launch plan\n') && md.includes('[team notes](https://tdoc.dev/d/q3-plan/v/1/notes)') && !md.includes('stolen'), md.slice(0, 300));
    // HEAD reads the object's metadata, never the document.
    const get = env.DOCS.get;
    let reads = 0;
    env.DOCS.get = async (...a) => { reads++; return get.apply(env.DOCS, a); };
    try {
      const head = await call('/d/q3-plan/v/1/export.md', { method: 'HEAD' });
      assert(head.status === 200 && (await head.text()) === '' && head.headers.get('content-disposition'), 'HEAD');
      assert((await call('/d/q3-plan/v/7/export.md', { method: 'HEAD' })).status === 404, 'HEAD of a missing version');
      assert(reads === 0, `HEAD read the document ${reads} time(s)`);
    } finally { env.DOCS.get = get; }
  });

  await t('/export.md has the gate of reading the doc: a private doc is its readers\' only', async () => {
    for (const opts of [{}, { token: eve.token }, { cookie: eve.cookie }]) {
      const r = await call('/d/q3-secret/v/1/export.md', opts);
      assert(r.status === 401 || r.status === 403 || r.status === 404, `expected denial, got ${r.status}`);
      const body = await r.text();
      assert(!body.includes('Q3 launch plan') && !body.includes('importer'), 'denial leaks the doc');
      assert(!r.headers.get('content-disposition'), 'denial is an attachment');
    }
    for (const opts of [{ token: alice.token }, { cookie: alice.cookie }]) {
      const r = await call('/d/q3-secret/v/1/export.md', opts);
      assert(r.status === 200 && (await r.text()).includes('**importer**'), `owner ${r.status}`);
    }
    assert((await call('/d/q3-plan/v/9/export.md')).status === 404, 'missing version');
    assert((await call('/d/Bad..Slug/v/1/export.md')).status >= 400, 'bad slug');
  });

  await t('/export.md converts a version once (edge cache by content hash and title), after the gate', async () => {
    const store = new Map();
    globalThis.caches = { default: {
      match: async (k) => (store.has(k) ? new Response(store.get(k)) : undefined),
      put: async (k, r) => { store.set(k, await r.text()); },
    } };
    try {
      const sha = 'a1b2c3d4e5f60718';
      await env.META.put('meta:cached', JSON.stringify({ title: 'Cached', slug: 'cached', created, versions: [{ n: 1, created, sha }], access: { visibility: 'private', allowed_users: [] }, hosted: { account_id: alice.account_id, github_login: 'alice' } }));
      await env.DOCS.put('docs/cached/v1/index.html', SAMPLE);
      const first = await (await call('/d/cached/v/1/export.md', { cookie: alice.cookie })).text();
      assert(store.size === 1 && [...store.keys()][0].includes('/__markdown-cache/cached/v1/' + sha), [...store.keys()].join());
      const get = env.DOCS.get;
      let reads = 0;
      env.DOCS.get = async (...a) => { reads++; return get.apply(env.DOCS, a); };
      try {
        const again = await call('/d/cached/v/1/export.md', { cookie: alice.cookie });
        assert(again.status === 200 && (await again.text()) === first && reads === 0, `cache hit read R2 ${reads}x`);
        assert(again.headers.get('content-disposition') === 'attachment; filename="cached.md"', 'hit headers');
        const denied = await call('/d/cached/v/1/export.md', { cookie: eve.cookie });
        assert(denied.status >= 400 && !(await denied.text()).includes('importer'), 'the cache answered a reader the gate refuses');
      } finally { env.DOCS.get = get; }
      // A new title is a new file.
      await env.META.put('meta:cached', JSON.stringify({ title: 'Renamed', slug: 'cached', created, versions: [{ n: 1, created, sha }], access: { visibility: 'private', allowed_users: [] }, hosted: { account_id: alice.account_id, github_login: 'alice' } }));
      await call('/d/cached/v/1/export.md', { cookie: alice.cookie });
      assert(store.size === 2, 'title change reused the old file');
    } finally { delete globalThis.caches; }
  });

  // ---- Word ----
  const { htmlToDocx, zipStore, crc32 } = await import(path.join(ROOT, 'shell', 'src', 'document', 'docx-export.mjs'));
  const png = Buffer.from(SAMPLE.match(/base64,([^"]+)/)[1], 'base64');
  const loads = [];
  const files = unzip(await htmlToDocx(parseHtml(SAMPLE), {
    title: 'Q3 launch plan',
    docUrl: 'https://tdoc.dev/d/q3-plan',
    baseUrl: 'https://tdoc.dev/d/q3-plan/v/1/frame',
    loadImage: async (src) => { loads.push(src); return src.startsWith('data:image/png') ? { bytes: new Uint8Array(png), type: 'png', width: 40, height: 20 } : null; },
    renderSvg: async (node) => (node.getAttribute('aria-label') === 'Signups chart' ? { bytes: new Uint8Array(png), type: 'png', width: 400, height: 200 } : null),
  }));
  const docXml = files['word/document.xml'].toString('utf8');
  const relsXml = files['word/_rels/document.xml.rels'].toString('utf8');
  const numXml = files['word/numbering.xml'].toString('utf8');

  await t('Word: a .docx package Word opens (parts, content types, well-formed XML, CRCs)', async () => {
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/_rels/document.xml.rels']) {
      assert(files[part], `missing ${part}`);
      wellFormed(part, files[part].toString('utf8'));
    }
    assert(Object.keys(files)[0] === '[Content_Types].xml', 'content types first');
    assert(files['[Content_Types].xml'].toString().includes('<Default Extension="png" ContentType="image/png"/>'), 'png content type');
    assert(files['docProps/core.xml'].toString().includes('<dc:title>Q3 launch plan</dc:title>'), 'title in properties');
    const z = unzip(zipStore([{ name: 'a.txt', data: 'hello' }]));
    assert(z['a.txt'].toString() === 'hello' && crc32(Buffer.from('hello')) === 0x3610a686, 'zip + crc32');
  });

  await t('Word: headings, inline marks, links, lists, quote and code map to Word structure', async () => {
    for (const want of [
      '<w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">Q3 launch plan</w:t>',
      '<w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t xml:space="preserve">Milestones</w:t>',
      '<w:pStyle w:val="Heading3"/></w:pPr><w:r><w:t xml:space="preserve">Setup</w:t>',
      '<w:rPr><w:b/></w:rPr><w:t xml:space="preserve">importer</w:t>',
      '<w:rPr><w:i/></w:rPr><w:t xml:space="preserve">billing</w:t>',
      '<w:rPr><w:rStyle w:val="CodeChar"/></w:rPr><w:t xml:space="preserve">tdoc-pull q3</w:t>',
      '<w:pStyle w:val="Quote"/></w:pPr><w:r><w:t xml:space="preserve">Ship the smallest thing that a team will pay for.</w:t>',
      '<w:pStyle w:val="Code"/></w:pPr><w:r><w:t xml:space="preserve">npm install</w:t></w:r><w:r><w:br/></w:r><w:r><w:t xml:space="preserve">  tdoc-new --slug q3 \\</w:t>',
    ]) assert(docXml.includes(want), `document.xml lacks ${want}`);
    assert(/<w:hyperlink r:id="(rId\d+)"[^>]*><w:r><w:rPr><w:rStyle w:val="Hyperlink"\/><\/w:rPr><w:t xml:space="preserve">the spec<\/w:t>/.test(docXml), 'link run');
    assert(relsXml.includes('Target="https://example.com/spec" TargetMode="External"') && relsXml.includes('Target="https://tdoc.dev/d/q3-plan/v/1/notes" TargetMode="External"'), 'link targets (relative resolved)');
    // Bullets at two levels, then a numbered list counting from 3.
    assert(/Importer — July<\/w:t>/.test(docXml) && /<w:ilvl w:val="1"\/><w:numId w:val="2"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">CSV and XLSX/.test(docXml), 'nested bullet');
    assert(/<w:numId w:val="3"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">Beta invite/.test(docXml), 'numbered item');
    assert(/<w:abstractNum w:abstractNumId="3">.*?<w:lvl w:ilvl="0"><w:start w:val="3"\/><w:numFmt w:val="decimal"\/>/.test(numXml), 'numbered list starts at 3');
    // The paragraph inside "Billing" is still a list item, not a stray paragraph.
    assert(/<w:numPr><w:ilvl w:val="0"\/><w:numId w:val="1"\/><\/w:numPr><\/w:pPr><w:r><w:t xml:space="preserve">Billing — August/.test(docXml), 'p in li');
    assert(!docXml.includes('stolen') && !docXml.includes('font:'), 'script or style text in the file');
  });

  await t('Word: tables (header row repeats, colspan), images embedded, islands become a link line', async () => {
    assert(docXml.includes('<w:tr><w:trPr><w:tblHeader/></w:trPr>'), 'header row repeats');
    assert(docXml.includes('<w:gridSpan w:val="2"/>') && docXml.includes('Everyone'), 'colspan');
    assert(docXml.includes('Billing | invoices'), 'pipe kept in a cell');
    assert((docXml.match(/<w:tbl>/g) || []).length === 2, 'the prose table and the embedded sheet');
    assert(docXml.includes('growth q3') && docXml.includes('=HYPERLINK(&quot;x&quot;)'), 'sheet cells as text');
    assert(files['word/media/image1.png'] && files['word/media/image2.png'], 'two images embedded');
    assert(/<wp:extent cx="3048000" cy="1524000"\/><wp:docPr id="1" name="Picture 1" descr="Revenue by month"\/>/.test(docXml), 'the img keeps its 320x160 size');
    assert(docXml.includes('descr="Signups chart"'), 'inline svg drawn as a picture');
    assert(docXml.includes('Interactive content “Forecast model”: see it in the online document') && relsXml.includes('Target="https://tdoc.dev/d/q3-plan" TargetMode="External"'), 'island placeholder links to the doc');
    assert(docXml.includes('<w:pStyle w:val="Caption"/></w:pPr><w:r><w:t xml:space="preserve">Revenue by month (illustrative).'), 'figcaption');
    assert(loads.length === 1 && loads[0].startsWith('data:image/png'), `images fetched: ${loads}`);
  });

  await t('Word: an image that cannot be fetched is its alt text, linked; unsafe XML characters dropped', async () => {
    const z = unzip(await htmlToDocx(parseHtml('<p>A\u0001B <img src="https://cdn.example.com/x.webp" alt="Map & key"></p><canvas></canvas>'), { title: 'T', docUrl: 'https://tdoc.dev/d/t', loadImage: async () => null }));
    const xml = z['word/document.xml'].toString();
    wellFormed('document.xml', xml);
    assert(xml.includes('<w:pStyle w:val="Title"/>'), 'title heading for a doc with no h1');
    assert(xml.includes('>AB </w:t>') && xml.includes('[Image: Map &amp; key]'), xml);
    assert(z['word/_rels/document.xml.rels'].toString().includes('Target="https://cdn.example.com/x.webp"'), 'linked to its source');
    assert(xml.includes('Interactive content: see it in the online document'), 'canvas placeholder');
  });

  await t('Word: colspan and list start are clamped integers', async () => {
    const z = unzip(await htmlToDocx(parseHtml('<h1>x</h1><table><tr><td colspan="99999999">a</td></tr><tr><td colspan="-4">b</td><td colspan="2.9">c</td></tr></table><ol start="99999999999999"><li>n</li></ol><ol start="abc"><li>m</li></ol>'), { title: 'x' }));
    const xml = z['word/document.xml'].toString();
    const num = z['word/numbering.xml'].toString();
    wellFormed('document.xml', xml);
    assert((xml.match(/<w:gridCol /g) || []).length === 1000 && xml.includes('<w:gridSpan w:val="1000"/>') && xml.includes('<w:gridSpan w:val="2"/>'), 'colspan clamp');
    assert(num.includes('<w:startOverride w:val="2147483647"/>') && num.includes('<w:startOverride w:val="1"/>'), 'start clamp');
  });

  await t('Word: image fetches carry no cookies except for this doc\'s files, and are capped', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'shell', 'src', 'document', 'doc-download.js'), 'utf8');
    assert(/credentials: mine \? 'same-origin' : 'omit'/.test(src) && src.includes("redirect: 'error',") && src.includes('url.pathname.startsWith(own)') && src.includes("const own = `/d/${encodeURIComponent(slug)}/`"), 'credentials');
    assert(/IMAGE_LIMITS = Object\.freeze\(\{ count: 100, bytes: 50 \* 1024 \* 1024, each: 20 \* 1024 \* 1024, ms: 15_000 \}\)/.test(src), 'limits');
    assert(src.includes('response.body?.getReader()') && !src.includes('response.blob()') && src.includes('controller.abort()'), 'stream read with a cap and a timeout');
  });

  // ---- Sheets ----
  const S = await import(path.join(ROOT, 'shell', 'src', 'document', 'sheet-export.mjs'));
  const sheets = S.sheetsFromDocument(parseHtml(SHEET));

  await t('CSV: the tab on screen, RFC 4180, BOM, formula-like text neutralised', async () => {
    assert(sheets.length === 2 && sheets[0].name === 'Q3' && sheets[1].name === 'Q4 [plan]', JSON.stringify(sheets.map((s) => s.name)));
    const guard = S.sheetCsv({ columns: [{ name: 'a' }], rows: [['\uFF1D1+1'], ['\uFF20x'], ['-5'], ['+x']] });
    assert(guard === "\uFEFFa\r\n'\uFF1D1+1\r\n'\uFF20x\r\n-5\r\n'+x\r\n", JSON.stringify(guard));
    const csv = S.sheetCsv(S.activeSheet(sheets, ''));
    assert(csv === '\uFEFFItem,Amount,Paid,Tags\r\n"Laptop, 14""","1,899.00",✓,"hardware, ana"\r\nCoffee,12.5,,office\r\n\'-SUM(A1),-3,✓,\r\n', JSON.stringify(csv));
    assert(S.activeSheet(sheets, 'Q4 [plan]') === sheets[1], 'the tab named in the view');
    assert(S.sheetFileName('expenses', sheets[1], sheets, 'csv') === 'expenses-q4-plan.csv' && S.sheetFileName('x', sheets[0], [sheets[0]], 'csv') === 'x.csv', 'file names');
  });

  await t('Excel: every tab, numbers and checkboxes as values, names Excel accepts', async () => {
    const XLSX = require(path.join(ROOT, 'node_modules', 'xlsx', 'dist', 'xlsx.mini.min.js'));
    const book = XLSX.read(S.xlsxBytes(XLSX, sheets), { type: 'array' });
    assert(JSON.stringify(book.SheetNames) === '["Q3","Q4 (plan)"]', JSON.stringify(book.SheetNames));
    const q3 = XLSX.utils.sheet_to_json(book.Sheets.Q3, { header: 1 });
    assert(JSON.stringify(q3) === JSON.stringify([['Item', 'Amount', 'Paid', 'Tags'], ['Laptop, 14"', 1899, true, 'hardware, ana'], ['Coffee', 12.5, false, 'office'], ['-SUM(A1)', -3, true, '']]), JSON.stringify(q3));
    assert(!book.Sheets.Q3.A4.f, 'text is never a formula');
    assert(JSON.stringify(S.workbookNames([{ name: 'A/B' }, { name: 'a b' }, { name: 'x'.repeat(40) }])) === JSON.stringify(['A B', 'a b 2', 'x'.repeat(31)]), 'names');
  });

  // ---- wiring ----
  await t('the frame sends its HTML and its shape; the menu offers each format to everyone; one Markdown converter', async () => {
    const probe = fs.readFileSync(path.join(ROOT, 'server', 'frame-probe.js'), 'utf8');
    assert(/d\.type === 'tdoc:exportHtml'\) \{\s*post\(\{ type: 'tdoc:exportHtml', requestId: d\.requestId, html: serializeDocument\(\) \}\)/.test(probe), 'exportHtml answer');
    assert(probe.includes('sheets: shape.sheets, sheetDoc: shape.sheetDoc'), 'shape in ready');
    const toolbar = fs.readFileSync(path.join(ROOT, 'shell', 'src', 'document', 'document-toolbar.jsx'), 'utf8');
    for (const action of ['download-pdf', 'download-docx', 'download-md', 'download-csv', 'download-xlsx', 'download', 'copy']) assert(toolbar.includes(`data-action="${action}"`), action);
    const flags = fs.readFileSync(path.join(ROOT, 'shell', 'src', 'feature-flags.js'), 'utf8');
    assert(!flags.includes('docDownload'), 'Download ships to everyone: no flag');
    const shell = fs.readFileSync(path.join(ROOT, 'shell', 'src', 'document-shell.jsx'), 'utf8');
    assert(!shell.includes("isFeatureOn('docDownload')") && shell.includes('onDownloadAs={downloadAs}'), 'menu not gated');
    // Copy as Markdown and Download Markdown are the same text: both /export.md.
    assert(/const copyMarkdown = async \(\) => \{\s*const text = fetch\(`\$\{versionBase\}\/export\.md`/.test(shell) && shell.includes('onCopyMarkdown={copyMarkdown}'), 'Copy as Markdown uses /export.md');
    assert(!probe.includes('function htmlToMarkdown') && !probe.includes("'tdoc:copyDoc'") && !shell.includes('tdoc:copyDoc'), 'the frame\'s second Markdown converter is gone');
    assert(shell.includes("import('./document/doc-download.js')"), 'converters load on demand, not with the page');
    assert(!/from '\.\/document\/(docx-export|sheet-export|doc-download)/.test(shell), 'a converter is in the page bundle');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
