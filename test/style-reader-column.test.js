// Each house style carries the reading column (authoring/style/*.md). A page
// built from a style's CSS alone — never baked, or written in another app —
// must read like a published tdoc, so the style's copy of the column rules has
// to stay equal to server/reader.css, the template tdoc-bake stamps in. This
// file is the drift guard: one source of values, four copies held to it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert/strict');

const ROOT = path.join(__dirname, '..');
const STYLES = ['default', 'technical', 'paper', 'editorial'];
let pass = 0, fail = 0;
function t(n, fn) { try { fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n}\n    ${e.message}`); fail++; } }

// {selector: {prop: value}} for top-level rules (no @media), comments stripped.
function rules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  css = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  const out = {};
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const sel = m[1].replace(/\s+/g, ' ').replace(/\s*([>,])\s*/g, '$1').trim();
    const decls = out[sel] || (out[sel] = {});
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).replace(/\s+/g, ' ').trim();
    }
  }
  return out;
}

const READER = fs.readFileSync(path.join(ROOT, 'server/reader.css'), 'utf8');
const reader = rules(READER);
const COLUMN = [
  ':where(body>.wrap,body>main,body>article,body>.content,body>.container)',
  ':where(body:not(:has(>.wrap,>main,>article,>.content,>.container)))',
];
const REQUIRED = [...COLUMN, ':where(body img,body video,body iframe,body svg,body canvas)',
  ':where(body table)', ':where(body th,body td)', ':where(body th)', '.tdoc-table-scroll', '.tdoc-table-scroll>table', ':where(body pre)'];

function styleCss(name) {
  const md = fs.readFileSync(path.join(ROOT, `authoring/style/${name}.md`), 'utf8');
  return [...md.matchAll(/```css\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n');
}
// The style's reading-column rules: every :where() rule plus the tdoc scroll
// wrapper. Plain author selectors (.wrap h1, body{background}) are the style's
// own look and are not compared.
function columnRules(css) {
  return Object.fromEntries(Object.entries(rules(css)).filter(([s]) => s.startsWith(':where(') || s.startsWith('.tdoc-table-scroll')));
}

console.log('house styles carry the reader column (no drift from reader.css)\n');

t('reader.css still defines every rule the styles copy', () => {
  for (const s of REQUIRED) assert(reader[s], `reader.css lost ${s}`);
});

for (const name of STYLES) {
  const css = styleCss(name);
  const col = columnRules(css);
  t(`${name}: carries the full reading column`, () => {
    for (const s of REQUIRED) assert(col[s], `style/${name}.md is missing ${s}`);
  });
  t(`${name}: column values equal reader.css (width, padding, margins)`, () => {
    for (const s of COLUMN) assert.deepEqual(col[s], reader[s], `${s} drifted from reader.css`);
  });
  // Table geometry, not just the scroller: cell padding, spacing and size set
  // how wide a table is, so they decide whether it scrolls at phone width.
  // Colours (cell chips) stay the style's own.
  t(`${name}: table geometry equals reader.css (spacing, cell padding, size)`, () => {
    for (const [sel, props] of [[':where(body table)', ['border-collapse', 'border-spacing', 'font-size']],
      [':where(body th,body td)', ['padding', 'border']], [':where(body th)', ['font-weight']]]) {
      for (const p of props) assert.equal(col[sel] && col[sel][p], reader[sel][p], `${sel} { ${p} } missing or drifted`);
    }
  });
  t(`${name}: every copied declaration exists in reader.css with the same value`, () => {
    for (const [sel, decls] of Object.entries(col)) {
      assert(reader[sel], `${sel} is not a reader.css rule`);
      for (const [p, v] of Object.entries(decls)) assert.equal(v, reader[sel][p], `${sel} { ${p} } differs from reader.css`);
    }
  });
  t(`${name}: column rules stay zero-specificity (author CSS wins)`, () => {
    for (const sel of Object.keys(col)) if (!sel.startsWith('.tdoc-table-scroll')) assert(/^:where\(.*\)$/.test(sel), sel);
  });
}

// Baking a doc that already carries the style's column must change nothing a
// reader sees: one reader block, the same declarations, and a second bake is a
// no-op. The rendered half lives in style-reader-column-render.test.js.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-style-col-'));
try {
  for (const name of STYLES) {
    t(`${name}: tdoc-bake on a style-only doc is idempotent and validates`, () => {
      const f = path.join(tmp, `${name}.html`);
      fs.writeFileSync(f, `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title><style>${styleCss(name)}</style></head><body><div class="wrap"><h1>${name}</h1><p>Prose.</p></div></body></html>`);
      const bake = () => cp.execFileSync('node', [path.join(ROOT, 'bin/tdoc-bake'), f], { encoding: 'utf8' });
      assert(bake().startsWith('baked'));
      const once = fs.readFileSync(f, 'utf8');
      assert.equal((once.match(/id="tdoc-reader"/g) || []).length, 1);
      assert(bake().startsWith('skip'));
      assert.equal(fs.readFileSync(f, 'utf8'), once, 'second bake rewrote the file');
      cp.execFileSync('python3', [path.join(ROOT, 'bin/tdoc-validate-template'), f, '--style', name], { stdio: ['ignore', 'pipe', 'pipe'] });
    });
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
