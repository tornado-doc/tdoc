// "Convert to Sheet" (⋯ menu): a prose doc that holds sheet tables becomes a
// sheet doc, the kind shared/doc-type.mjs calls "sheet" and the sheets viewer
// shows as a standalone full-page sheet (no "Open the doc").
//
// The sheet-only rule already allows a title (<h1>) and a note (.sheet-note,
// whatever it holds) around the sheet tables, so nothing about detection
// changes: the conversion keeps the title and every sheet table in place,
// verbatim (data-name, data-row and data-key are what a cell comment is
// anchored by, so those comments stay on their cells), and moves the rest of
// the prose, in order, into one note right under the title:
//   - a short intro (one or two plain text blocks, at most NOTE_SHORT
//     characters, no headings, media or tables): a visible
//     <div class="sheet-note">, read above the grid;
//   - anything longer: a collapsed <details class="sheet-note"> with a
//     "Notes" summary, so the sheet is what the page opens on and nothing of
//     the doc is lost.
// It is a new version like any save; the old one stays in the history.
//
// Pure DOM, no shell state: convertToSheetHtml(html) -> { html, moved } or
// throws (no sheet table, or a result shared/doc-type.mjs would not call a
// sheet: nothing is saved then).

import { htmlIsSheetOnly } from '../../../shared/doc-type.mjs';

const SHEET = 'table[data-tdoc-sheet]';
// Containers the conversion looks inside: the page's structure, whose own
// boxes (a <main>'s width, a .tdoc-table-scroll) the sheet keeps. A sheet or
// the title inside anything else (a <details>, a list item, a figure, a
// plain table's cell) is lifted out to just before it first.
const STRUCTURAL = new Set(['BODY', 'MAIN', 'ARTICLE', 'SECTION', 'DIV', 'HEADER', 'FOOTER', 'HGROUP']);
// Kept where they are and never looked inside.
const KEEP = SHEET + ',[data-tdoc-provider],script,style,template,noscript,.sheet-note';
// Content that is not text but is still more than a sheet (the rule's media,
// plus form controls and embeds a doc may hold).
const MEDIA = 'img,svg,video,audio,canvas,iframe,figure,object,embed,picture,math,input,textarea,select,button,table,hr';
export const NOTE_SHORT = 280;
const NOTE_BLOCKS = new Set(['P', 'BLOCKQUOTE']);
const squash = (t) => String(t || '').replace(/\s+/g, ' ').trim();

// Does the moved prose hold a comment's anchor: its quoted words, or (an
// element comment with no words, an image) any media?
function carriesComments(moved, anchors) {
  const live = (anchors || []).filter((a) => a && !a.sheet && a.kind !== 'document');
  if (!live.length) return false;
  const text = squash(moved.map((n) => n.textContent || '').join(' '));
  const media = moved.some((n) => n.nodeType === 1 && (n.matches(MEDIA) || n.querySelector(MEDIA)));
  return live.some((a) => {
    const words = squash(a.text);
    return words ? text.includes(words) : media;
  });
}

function meaningful(node) {
  if (node.nodeType === 3) return /\S/.test(node.data.replace(/ /g, ' '));
  if (node.nodeType !== 1) return false;
  if (/\S/.test((node.textContent || '').replace(/ /g, ' '))) return true;
  return node.matches(MEDIA) || !!node.querySelector(MEDIA);
}

// `comments`: the doc's open comment anchors (optional). A note that would
// fold away prose one of them is on is written open, so its highlight and
// pin stay in view.
export function convertToSheetHtml(html, { comments = [], Parser = globalThis.DOMParser } = {}) {
  const doc = new Parser().parseFromString(String(html || ''), 'text/html');
  const body = doc.body;
  const outside = (el) => !el.closest('[data-tdoc-provider]');
  const sheets = Array.from(body.querySelectorAll(SHEET)).filter(outside);
  if (!sheets.length) throw new Error('This doc has no sheet to keep.');
  // The doc's title: its first <h1>. Any other <h1> is prose like the rest.
  const title = Array.from(body.querySelectorAll('h1')).find((h) => outside(h) && !h.closest(SHEET)) || null;

  // A sheet's own box: the .tdoc-table-scroll that holds only it.
  const unitOf = (el) => {
    const p = el.parentElement;
    if (el.matches(SHEET) && p && p !== body && p.classList.contains('tdoc-table-scroll')
      && Array.from(p.childNodes).every((n) => n === el || !meaningful(n))) return p;
    return el;
  };
  // Lift each kept piece out of anything that is not page structure.
  for (const el of [title, ...sheets].filter(Boolean)) {
    const unit = unitOf(el);
    let outer = null;
    for (let a = unit.parentElement; a && a !== body; a = a.parentElement) if (!STRUCTURAL.has(a.tagName)) outer = a;
    if (outer) outer.parentNode.insertBefore(unit, outer);
  }

  const keepers = new Set([title, ...sheets].filter(Boolean));
  const holdsKeeper = (el) => [...keepers].some((k) => el.contains(k));
  const moved = [];
  // Walk the structure that holds the title and the sheets; everything else
  // with content goes to the note, in document order.
  const walk = (container) => {
    for (const node of Array.from(container.childNodes)) {
      if (node.nodeType === 1) {
        if (keepers.has(node) || node.matches(KEEP)) continue;
        if (holdsKeeper(node)) { walk(node); continue; }
      }
      if (meaningful(node)) moved.push(node);
    }
  };
  walk(body);

  if (moved.length) {
    const blocks = moved.filter((n) => n.nodeType === 1);
    const text = moved.map((n) => n.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
    const short = text.length <= NOTE_SHORT && blocks.length <= 2
      && blocks.every((b) => NOTE_BLOCKS.has(b.tagName) && !b.querySelector(MEDIA + ',h1,h2,h3,h4,h5,h6,ul,ol'));
    let note;
    if (short) {
      note = doc.createElement('div');
      note.className = 'sheet-note';
    } else {
      note = doc.createElement('details');
      note.className = 'sheet-note';
      if (carriesComments(moved, comments)) note.setAttribute('open', '');
      const summary = doc.createElement('summary');
      summary.textContent = 'Notes';
      note.appendChild(summary);
    }
    // Placed before the nodes leave, so a note under the title sits where
    // the title is, and one with no title where the first sheet is.
    const anchor = title || unitOf(sheets[0]);
    if (title) title.parentNode.insertBefore(note, title.nextSibling);
    else anchor.parentNode.insertBefore(note, anchor);
    for (const node of moved) {
      note.appendChild(doc.createTextNode('\n'));
      note.appendChild(node);
    }
    note.appendChild(doc.createTextNode('\n'));
  }

  const doctype = doc.doctype ? `<!doctype ${doc.doctype.name}>\n` : '<!doctype html>\n';
  const out = doctype + doc.documentElement.outerHTML;
  // The one rule My docs, the frame and the viewer read: if the result is
  // not a sheet doc by it, say so rather than publish a half conversion.
  if (!htmlIsSheetOnly(out)) throw new Error('This doc could not be turned into a sheet. Nothing was changed.');
  return { html: out, moved: moved.length };
}
