// Authoring preflight only: exercise constrained and expanded content layouts.
// These temporary styles are never injected into the live reader or saved HTML.
function applyReaderWidth(mode) {
  const selector = 'body > .wrap, body > main, body > article, body > .content, body > .container';
  let style = document.querySelector('style#tdoc-reader-width[data-tdoc-provider]');
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
