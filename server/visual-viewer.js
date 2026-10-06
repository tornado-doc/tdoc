// Visual expansion. Popovers promote the ORIGINAL element to the
// top layer without reparenting it, so CSS ancestry, canvas pixels and widget
// iframe state survive. No author HTML is sent to the privileged shell.
(function () {
  'use strict';
  if (!HTMLElement.prototype.showPopover || window === window.parent) return;
  var SELECTOR = 'img,svg,canvas,video,iframe[src],figure,[data-tdoc-artifact],[class~="tdoc-artifact"]';
  var CONTROL = 'a,button,input,textarea,select,label,summary,[contenteditable="true"],[data-tdoc-copy]';
  var entries = [], active = null, scheduled = false;
  function readMode() { return document.documentElement.getAttribute('data-tdoc-interaction-mode') === 'read'; }
  function canExpand() { return document.documentElement.getAttribute('data-tdoc-interaction-mode') !== 'edit'; }
  function post(open) { window.parent.postMessage({ source: 'tdoc-frame', type: 'tdoc:visualState', open: open }, '*'); }
  function provider(el) { el.setAttribute('data-tdoc-provider', ''); return el; }
  function label(el) { return (el.getAttribute('aria-label') || el.getAttribute('alt') || el.querySelector('figcaption')?.textContent || 'visual').trim().slice(0, 100); }
  function visual(node) {
    if (!node || !node.closest || node.closest('[data-tdoc-provider]')) return null;
    var el = node.closest(SELECTOR);
    if (!el || el.closest(CONTROL) || el.matches('[aria-hidden="true"],[role="presentation"]')) return null;
    // A composed diagram is one visual, not a separate viewer for each SVG.
    return el.closest('figure,[data-tdoc-artifact],[class~="tdoc-artifact"]') || el;
  }
  var style = provider(document.createElement('style'));
  style.textContent =
    '.tdoc-visual-open{position:absolute;z-index:100;padding:7px;width:32px;height:32px;box-sizing:border-box;border:1px solid #dedee3;border-radius:8px;background:#fff;color:#333;cursor:zoom-in;box-shadow:0 1px 4px #0001;line-height:1;}' +
    '.tdoc-visual-open svg{display:block;width:16px;height:16px;}' +
    '.tdoc-visual-viewer{position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;box-sizing:border-box!important;}' +
    '.tdoc-visual-viewer::backdrop{background:transparent;}' +
    '.tdoc-visual-toolbar{position:fixed!important;inset:0 0 auto!important;width:100vw;max-width:none;box-sizing:border-box;margin:0;border:0;display:flex;align-items:center;gap:8px;padding:12px max(12px,env(safe-area-inset-right)) 12px max(12px,env(safe-area-inset-left));font:14px/1.4 system-ui;color:inherit;}' +
    '.tdoc-visual-toolbar strong{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;}' +
    '.tdoc-visual-toolbar button{font:500 14px/1 system-ui;min-width:36px;height:36px;padding:0 10px;border:1px solid #8886;border-radius:8px;background:transparent;color:inherit;cursor:pointer;}' +
    '.tdoc-visual-toolbar button:focus-visible,.tdoc-visual-open:focus-visible{outline:2px solid #1652f0;outline-offset:2px;}' +
    'html[data-tdoc-visual-open]{overflow:hidden!important;}' +
    'html[data-tdoc-theme="dark"][data-tdoc-visual-open]{filter:none!important;}' +
    'html[data-tdoc-visual-open] .tdoc-visual-open{display:none!important;}';
  document.head.appendChild(style);

  function position() {
    scheduled = false;
    entries.forEach(function (entry) {
      var r = entry.el.getBoundingClientRect();
      entry.button.hidden = !canExpand() || !!active || !entry.el.isConnected || r.width < 64 || r.height < 48;
      entry.button.style.left = Math.max(0, r.right + window.scrollX - 38) + 'px';
      entry.button.style.top = r.top + window.scrollY + 6 + 'px';
    });
  }
  function schedule() { if (!scheduled) { scheduled = true; requestAnimationFrame(position); } }
  function prepare() {
    if (active) return;
    entries = entries.filter(function (entry) { if (entry.el.isConnected) return true; entry.button.remove(); return false; });
    document.querySelectorAll(SELECTOR).forEach(function (node) {
      var el = visual(node);
      if (!el || el === document.body || (el.parentElement === document.body && el.matches('.wrap,main,article,.content,.container')) || entries.some(function (entry) { return entry.el === el; })) return;
      var r = el.getBoundingClientRect();
      if (r.width < 64 || r.height < 48) return;
      var button = provider(document.createElement('button'));
      button.type = 'button'; button.className = 'tdoc-visual-open';
      button.setAttribute('aria-label', 'View ' + label(el) + ' fullscreen');
      button.title = 'View fullscreen';
      button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5"/></svg>';
      button.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); open(el, button); });
      document.body.appendChild(button); entries.push({ el: el, button: button });
    });
    schedule();
  }
  function restoreAttr(el, name, value) { if (value === null) el.removeAttribute(name); else el.setAttribute(name, value); }
  function close() {
    if (!active) return;
    var a = active; active = null;
    if (a.target.matches(':popover-open')) a.target.hidePopover();
    restoreAttr(a.target, 'style', a.style); restoreAttr(a.target, 'popover', a.popover); restoreAttr(a.target, 'id', a.id);
    a.inert.forEach(function (node) { node.removeAttribute('inert'); });
    if (a.wrapper) { a.wrapper.replaceWith(a.el); }
    a.panel.remove();
    document.documentElement.removeAttribute('data-tdoc-visual-open');
    post(false);
    requestAnimationFrame(function () { window.scrollTo(a.scrollX, a.scrollY); position(); if (a.trigger?.isConnected) a.trigger.focus({ preventScroll: true }); });
  }
  function fit() {
    if (!active) return;
    active.scale = Math.min((innerWidth - 32) / active.width, (innerHeight - 96) / active.height);
    active.x = active.y = 0; layout();
  }
  function layout() {
    if (!active) return;
    var a = active;
    a.target.style.setProperty('transform', 'translate(-50%,-50%) translate(' + a.x + 'px,' + a.y + 'px) scale(' + a.scale + ')', 'important');
  }
  function open(el, trigger) {
    if (active || !canExpand()) return;
    var r = el.getBoundingClientRect(), target = el, wrapper = null;
    var width = el.tagName === 'IMG' && el.naturalWidth ? el.naturalWidth : r.width;
    var height = el.tagName === 'IMG' && el.naturalHeight ? el.naturalHeight : r.height;
    // SVGElement has no Popover API. A temporary wrapper is needed only for
    // standalone SVGs; figures and HTML/widget elements never move.
    if (!(el instanceof HTMLElement)) {
      wrapper = document.createElement('div'); el.before(wrapper); wrapper.appendChild(el); target = wrapper;
    }
    var panel = provider(document.createElement('div'));
    panel.className = 'tdoc-visual-viewer'; panel.setAttribute('popover', 'auto');
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true'); panel.setAttribute('aria-label', label(el));
    var bg = getComputedStyle(el).backgroundColor;
    for (var p = el.parentElement; (!bg || bg === 'rgba(0, 0, 0, 0)') && p; p = p.parentElement) bg = getComputedStyle(p).backgroundColor;
    panel.style.background = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#fff';
    panel.style.color = getComputedStyle(el).color;
    // Top-layer popovers escape the root filter. Reapply the reader inversion
    // here, including its inverse on photos/widgets, so their colors survive.
    var dark = document.documentElement.getAttribute('data-tdoc-theme') === 'dark';
    if (dark) panel.style.filter = 'invert(1) hue-rotate(180deg)';
    var toolbar = document.createElement('div'); toolbar.className = 'tdoc-visual-toolbar';
    toolbar.setAttribute('popover', 'manual'); toolbar.style.background = panel.style.background;
    if (dark) toolbar.style.filter = panel.style.filter;
    var title = document.createElement('strong'); title.textContent = label(el); toolbar.appendChild(title);
    function button(text, name, action) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute('aria-label', name); b.onclick = action; toolbar.appendChild(b); return b;
    }
    button('−', 'Zoom out', function () { active.scale = Math.max(.1, active.scale / 1.25); layout(); });
    button('Fit', 'Fit visual', fit);
    button('+', 'Zoom in', function () { active.scale = Math.min(10, active.scale * 1.25); layout(); });
    var dismiss = button('×', 'Close fullscreen', close);
    panel.appendChild(toolbar); document.body.appendChild(panel);
    active = { el: el, target: target, wrapper: wrapper, panel: panel, trigger: trigger,
      style: target.getAttribute('style'), popover: target.getAttribute('popover'), id: target.getAttribute('id'),
      width: width, height: height, x: 0, y: 0, scrollX: scrollX, scrollY: scrollY, inert: [] };
    // Keep the original visual's ancestry active while excluding the rest of
    // the document from focus and the accessibility tree.
    for (var branch = target; branch && branch !== document.body; branch = branch.parentElement) {
      Array.from(branch.parentElement.children).forEach(function (sibling) {
        if (sibling !== branch && sibling !== panel && !sibling.hasAttribute('inert')) {
          sibling.setAttribute('inert', ''); active.inert.push(sibling);
        }
      });
    }
    panel.addEventListener('toggle', function (e) { if (e.newState === 'closed' && active?.panel === panel) close(); });
    panel.addEventListener('click', function (e) { if (e.target === panel) close(); });
    // Fixed dimensions preserve the authored layout while the whole visual is
    // scaled. An iframe stays mounted, with exactly the same sandbox policy.
    var original = getComputedStyle(target);
    var css = { position: 'fixed', inset: 'auto', left: '50%', top: 'calc(50% + 24px)', margin: '0',
      width: width + 'px', height: height + 'px', 'max-width': 'none', 'max-height': 'none',
      'min-width': '0', 'min-height': '0', 'box-sizing': 'border-box', 'transform-origin': 'center', overflow: 'visible',
      border: original.border, padding: original.padding, 'background-color': original.backgroundColor, color: original.color };
    if (dark) css.filter = target.matches('img:not([data-tdoc-dark="invert"]),video:not([data-tdoc-dark="invert"]),canvas:not([data-tdoc-dark="invert"]),iframe:not([data-tdoc-dark="invert"])')
      ? 'none' : 'invert(1) hue-rotate(180deg)' + (original.filter === 'none' ? '' : ' ' + original.filter);
    if (!target.matches('iframe,video') && !target.querySelector('iframe,video,input,select')) css['touch-action'] = 'none';
    Object.keys(css).forEach(function (key) { target.style.setProperty(key, css[key], 'important'); });
    target.setAttribute('popover', 'manual');
    if (!target.id) target.id = 'tdoc-visual-target';
    panel.setAttribute('aria-owns', target.id);
    document.documentElement.setAttribute('data-tdoc-visual-open', '');
    panel.showPopover(); target.showPopover(); toolbar.showPopover(); fit(); dismiss.focus(); post(true); schedule();
  }
  document.addEventListener('click', function (e) {
    if (active || !readMode() || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (e.target.closest(CONTROL) || window.getSelection()?.toString()) return;
    var el = visual(e.target), entry = entries.find(function (item) { return item.el === el; });
    if (entry && !el.matches('video,iframe')) { e.preventDefault(); open(el, entry.button); }
  });
  document.addEventListener('keydown', function (e) {
    if (!active) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    if (e.key === 'Tab') {
      var items = Array.from(active.panel.querySelectorAll('button')).concat(Array.from(active.target.querySelectorAll('a[href],button,input,select,textarea,iframe,[tabindex="0"]')));
      if (active.target.matches('iframe,video')) items.push(active.target);
      var i = items.indexOf(document.activeElement), next = (i + (e.shiftKey ? -1 : 1) + items.length) % items.length;
      e.preventDefault(); items[next].focus();
    }
  }, true);
  var drag = null;
  document.addEventListener('pointerdown', function (e) {
    if (!active || e.target.closest(CONTROL) || e.target.closest('iframe,video')) return;
    if (active.target.contains(e.target)) { drag = { x: e.clientX - active.x, y: e.clientY - active.y }; e.target.setPointerCapture(e.pointerId); e.preventDefault(); }
  });
  document.addEventListener('pointermove', function (e) { if (active && drag) { active.x = e.clientX - drag.x; active.y = e.clientY - drag.y; layout(); } });
  document.addEventListener('pointerup', function () { drag = null; });
  document.addEventListener('pointercancel', function () { drag = null; });
  window.addEventListener('resize', function () { if (active) fit(); else schedule(); });
  window.addEventListener('scroll', schedule, { passive: true });
  document.addEventListener('load', prepare, true);
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || e.data?.source !== 'tdoc-shell') return;
    if (e.data.type === 'tdoc:mode') { if (active) close(); prepare(); }
  });
  new MutationObserver(function (mutations) {
    if (mutations.some(function (m) { return !m.target.closest?.('[data-tdoc-provider]') && Array.from(m.addedNodes).some(function (n) { return n.nodeType === 1 && !n.hasAttribute('data-tdoc-provider'); }); })) prepare();
  }).observe(document.body, { childList: true, subtree: true });
  new ResizeObserver(prepare).observe(document.body);
  prepare();
})();
