// "Going there": the moment a navigation starts, the page says so.
//
// My docs can take a moment to answer, and a menu item that did nothing
// visible for that long read as a dead click ("点击没效果") even though the
// browser was already on its way. A thin bar along the top of the window
// (chrome.css, html[data-tdoc-navigating]) shows from the click until the
// next page replaces this one. Coming back through the back/forward cache
// restores this page as it was left, bar and all, so pageshow clears it.

let listening = false;

export function clearNavigationProgress() {
  document.documentElement.removeAttribute('data-tdoc-navigating');
}

export function startNavigationProgress() {
  document.documentElement.setAttribute('data-tdoc-navigating', '');
  if (!listening) {
    listening = true;
    window.addEventListener('pageshow', (event) => { if (event.persisted) clearNavigationProgress(); });
  }
}

// A click the browser turns into a navigation of THIS tab: a plain primary
// click. Modified clicks open elsewhere and leave this page where it is.
export function isPlainNavigationClick(event) {
  return !(event.defaultPrevented || event.button !== 0
    || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey);
}
