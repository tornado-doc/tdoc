// A small DOM over the vendored parse5 (server/html-parser/parse5.js), enough
// for the sheet markup reader/writer (shared/sheet-markup.mjs) to run in an
// offline test: tables, rows, cells, attributes, text, [attr] selectors and
// serialization. Not a general DOM.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let parse5;
function parser() {
  if (!parse5) {
    const ctx = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'html-parser', 'parse5.js'), 'utf8') + ';this.TdocParse5=TdocParse5;', ctx);
    parse5 = ctx.TdocParse5;
  }
  return parse5;
}

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area', 'base', 'wbr', 'source']);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i !== -1) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.childNodes.forEach((c) => { c.parentNode = null; }); this.childNodes = []; if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v))); }
}
class Text extends Node {
  constructor(doc, data) { super(doc); this.nodeType = 3; this.data = data; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  get outerHTML() { return esc(this.data); }
}
class Element extends Node {
  constructor(doc, tag) { super(doc); this.nodeType = 1; this.localName = tag; this.attrs = new Map(); }
  get tagName() { return this.localName.toUpperCase(); }
  getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
  setAttribute(n, v) { this.attrs.set(n, String(v)); }
  hasAttribute(n) { return this.attrs.has(n); }
  removeAttribute(n) { this.attrs.delete(n); }
  get children() { return this.childNodes.filter((c) => c.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get nextElementSibling() {
    const sibs = this.parentNode ? this.parentNode.children : [];
    return sibs[sibs.indexOf(this) + 1] || null;
  }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  // Supports `tag`, `[attr]`, `tag[attr]` and `tag[attr="v"]`, comma lists.
  matches(sel) {
    return sel.split(',').some((one) => {
      const m = /^\s*([a-z0-9]*)((?:\[[^\]]+\])*)\s*$/i.exec(one);
      if (!m) throw new Error(`mini-dom selector not supported: ${one}`);
      if (m[1] && m[1].toLowerCase() !== this.localName) return false;
      const attrs = m[2].match(/\[[^\]]+\]/g) || [];
      return attrs.every((a) => {
        const am = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(a);
        if (!this.attrs.has(am[1])) return false;
        return am[2] === undefined || this.attrs.get(am[1]) === am[2];
      });
    });
  }
  querySelectorAll(sel) { return [...this.walk()].filter((e) => e.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  get tHead() { return this.children.find((c) => c.localName === 'thead') || null; }
  get tBodies() { return this.children.filter((c) => c.localName === 'tbody'); }
  get rows() { return this.children.filter((c) => c.localName === 'tr'); }
  get cells() { return this.children.filter((c) => c.localName === 'td' || c.localName === 'th'); }
  get innerHTML() { return this.childNodes.map((c) => c.outerHTML).join(''); }
  get outerHTML() {
    const attrs = [...this.attrs].map(([k, v]) => (v === '' ? ` ${k}` : ` ${k}="${escAttr(v)}"`)).join('');
    if (VOID.has(this.localName)) return `<${this.localName}${attrs}>`;
    return `<${this.localName}${attrs}>${this.innerHTML}</${this.localName}>`;
  }
}
class Document extends Element {
  constructor() { super(null, '#document'); this.ownerDocument = this; }
  createElement(tag) { return new Element(this, String(tag).toLowerCase()); }
  createTextNode(data) { return new Text(this, data); }
}

function convert(doc, p5, into) {
  for (const child of p5.childNodes || []) {
    if (child.nodeName === '#text') into.appendChild(doc.createTextNode(child.value));
    else if (child.tagName) {
      const el = doc.createElement(child.tagName);
      for (const a of child.attrs) el.setAttribute(a.name, a.value);
      into.appendChild(el);
      convert(doc, child.content || child, el);
    }
  }
}

function parseHtml(html) {
  const doc = new Document();
  convert(doc, parser().parse(html), doc);
  return doc;
}

module.exports = { parseHtml };
