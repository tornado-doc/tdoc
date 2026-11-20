// A block by its stable id (flag stableBlockIds): the server tells a comment
// whose words are gone from this version where the block it was made on now
// is (GET /api/comments blocks=1 → comment.anchor_block: { path, tag, head }).
// `path` is element-child indices from <body>, counted the way the server
// segments the stored HTML (server/block-ids.js elementKids): scripts,
// styles and other non-content tags, tdoc's own injected elements
// (id="tdoc-…", data-tdoc-provider) are not counted. The path is checked
// against the tag and the block's opening words; when it misses (something
// in the page moved the elements), the first element with that tag whose
// words start the same way. Framework-free; the doc frame bundles it.

var BLOCK_SKIP = { SCRIPT: 1, STYLE: 1, LINK: 1, META: 1, TEMPLATE: 1, NOSCRIPT: 1, TITLE: 1, BASE: 1 };

function blockKids(el) {
  var out = [];
  for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
    var tag = String(c.tagName || '').toUpperCase();
    if (BLOCK_SKIP[tag]) continue;
    if (c.hasAttribute && c.hasAttribute('data-tdoc-provider')) continue;
    if (String(c.id || '').indexOf('tdoc-') === 0) continue;
    out.push(c);
  }
  return out;
}

export function blockWords(el) {
  return String((el && el.textContent) || '').toLowerCase().replace(/[\s ]+/g, '');
}

// The words' length may differ a little from the server's count (an image's
// alt text is in the server's, not in textContent).
function lengthFits(words, block) {
  var len = Number(block.len);
  if (!(len > 0)) return true;
  return Math.abs(words.length - len) <= Math.max(8, len * 0.1);
}

function blockFits(el, block) {
  if (!el || String(el.tagName || '').toLowerCase() !== String(block.tag || '').toLowerCase()) return false;
  var head = String(block.head || '');
  var words = blockWords(el);
  return (!head || words.indexOf(head.slice(0, 40)) === 0) && lengthFits(words, block);
}

// The block, or null. By path first; else by tag and words, and only when
// exactly one element fits once those that hold another fitting one are
// set aside (a wrapper starting with the same words as its first child):
// two equal blocks are no answer.
export function findBlockElement(block, root) {
  if (!block || !block.tag) return null;
  var body = root || (typeof document !== 'undefined' ? document.body : null);
  if (!body) return null;
  var el = body;
  var path = Array.isArray(block.path) ? block.path : [];
  for (var i = 0; i < path.length && el; i++) el = blockKids(el)[path[i]] || null;
  if (el && el !== body && blockFits(el, block)) return el;
  if (!block.head) return null;
  var all = body.getElementsByTagName(String(block.tag));
  var fits = [];
  for (var k = 0; k < all.length; k++) if (blockFits(all[k], block)) fits.push(all[k]);
  fits = fits.filter(function (a) {
    for (var j = 0; j < fits.length; j++) if (fits[j] !== a && a.contains(fits[j])) return false;
    return true;
  });
  return fits.length === 1 ? fits[0] : null;
}
