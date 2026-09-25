// Shared by the provider frame and the authoring preflight. This is a reader
// preference: never rewrite the author's root or serialize it into a version.
function applyReaderWidth(mode) {
  const selector = 'body > .wrap, body > main, body > article, body > .content, body > .container';
  let style = document.getElementById('tdoc-reader-width');
  if (!style) {
    style = document.createElement('style');
    style.id = 'tdoc-reader-width';
    style.setAttribute('data-tdoc-provider', '');
    (document.head || document.documentElement).appendChild(style);
  }
  style.textContent = mode === 'narrow' || mode === 'wide'
    ? `${selector}{max-width:${mode === 'wide' ? 'none' : '720px'}!important}` : '';
}

if (typeof module !== 'undefined') module.exports = { applyReaderWidth };
