// Markdown subset for comment bodies (parseRichText). Run: node test/rich-text.test.js

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
function ok(n) { console.log(`  ✓ ${n}`); pass++; }
function bad(n, e) { console.log(`  ✗ ${n}\n    ${e && e.message ? e.message : e}`); fail++; }
async function t(n, fn) { try { await fn(); ok(n); } catch (e) { bad(n, e); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

(async () => {
  console.log('rich text (comment markdown subset)');
  const modPath = path.join(__dirname, '..', 'shell', 'src', 'document', 'rich-text.js');
  const { parseRichText } = await import(pathToFileURL(modPath).href);

  await t('bold, inline code, and links', () => {
    const nodes = parseRichText('see **bold** and `code` plus https://tdoc.dev/x');
    const flat = JSON.stringify(nodes);
    assert(flat.includes('"type":"strong","value":"bold"'), flat);
    assert(flat.includes('"type":"code","value":"code"'), flat);
    assert(flat.includes('"type":"link","value":"https://tdoc.dev/x"'), flat);
  });

  await t('fenced code stays literal', () => {
    const nodes = parseRichText('before\n```\n**not bold**\n```\nafter');
    const fence = nodes.find((n) => n.type === 'fence');
    assert(fence && fence.value.includes('**not bold**'), JSON.stringify(nodes));
  });

  await t('dash lists become list tokens', () => {
    const nodes = parseRichText('- one\n- two');
    assert(nodes.length === 1 && nodes[0].type === 'list', JSON.stringify(nodes));
    assert(nodes[0].items.length === 2, JSON.stringify(nodes[0]));
  });

  await t('MentionText wires parseRichText (no dangerouslySetInnerHTML)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'shell', 'src', 'document', 'mention-field.jsx'), 'utf8');
    assert(src.includes('parseRichText'), 'MentionText must use parseRichText');
    assert(!src.includes('dangerouslySetInnerHTML'), 'no HTML injection');
    assert(!/from ['"]marked['"]|from ['"]markdown-it['"]|from ['"]remark/.test(src), 'no markdown library');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
