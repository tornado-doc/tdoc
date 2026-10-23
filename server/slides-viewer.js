// Slides mode. A doc whose author HTML marks pages with `data-tdoc-slide` gets
// a Present control: one slide at a time, full screen, scaled to fit, with
// keyboard, swipe and on-screen navigation. Like the visual viewer, the
// ORIGINAL slide element is promoted to the top layer (never cloned), so its
// comment anchors, widget iframes and styles survive, and the reader shell is
// told through the same tdoc:visualState bridge so its chrome steps aside.
(function () {
  'use strict';
  if (!HTMLElement.prototype.showPopover || window === window.parent) return;
  if (new URLSearchParams(location.search).get('tdoc_compare') === '1') return;
  var SLIDE = '[data-tdoc-slide]';
  var active = null, trigger = null;
  function slides() { return Array.from(document.querySelectorAll(SLIDE)).filter(function (el) { return el instanceof HTMLElement; }); }
  function canPresent() { return document.documentElement.getAttribute('data-tdoc-interaction-mode') !== 'edit'; }
  function post(open) { window.parent.postMessage({ source: 'tdoc-frame', type: 'tdoc:visualState', open: open }, '*'); }
  function provider(el) { el.setAttribute('data-tdoc-provider', ''); return el; }
  function restoreAttr(el, name, value) { if (value === null) el.removeAttribute(name); else el.setAttribute(name, value); }

  var style = provider(document.createElement('style'));
  style.textContent =
    '.tdoc-present-open{position:absolute;z-index:100;display:inline-flex;align-items:center;gap:6px;height:36px;padding:0 14px;box-sizing:border-box;border:1px solid #d0d5dd;border-radius:18px;background:#fff;color:#344054;font:600 13px/1 system-ui;cursor:pointer;box-shadow:0 2px 8px #0002;}' +
    '.tdoc-present-open:hover{background:#f2f4f7;border-color:#98a2b3;}' +
    '.tdoc-present-open[hidden]{display:none!important;}' +
    '.tdoc-present-open svg{width:14px;height:14px;margin:0!important;}' +
    '.tdoc-present-stage{position:fixed!important;inset:0!important;width:100vw!important;height:100dvh!important;max-width:none!important;max-height:none!important;margin:0!important;padding:0!important;border:0!important;background:#111!important;}' +
    '.tdoc-present-stage::backdrop{background:#111;}' +
    '.tdoc-present-bar{position:fixed!important;inset:auto 0 0!important;width:100vw;max-width:none;margin:0;border:0;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:8px;padding:10px max(12px,env(safe-area-inset-right)) max(10px,env(safe-area-inset-bottom)) max(12px,env(safe-area-inset-left));background:transparent;color:#eee;font:14px/1.4 system-ui;}' +
    '.tdoc-present-bar button{font:500 14px/1 system-ui;min-width:44px;height:44px;padding:0 12px;border:1px solid #fff4;border-radius:8px;background:#0006;color:#eee;cursor:pointer;}' +
    '.tdoc-present-bar button:disabled{opacity:.35;cursor:default;}' +
    '.tdoc-present-bar button:focus-visible,.tdoc-present-open:focus-visible{outline:2px solid #8fb0ff;outline-offset:2px;}' +
    '.tdoc-present-bar output{min-width:64px;text-align:center;font-variant-numeric:tabular-nums;}' +
    '.tdoc-present-bar .tdoc-present-close{position:absolute;right:max(12px,env(safe-area-inset-right));}' +
    'html[data-tdoc-presenting]{overflow:hidden!important;}' +
    'html[data-tdoc-presenting] .tdoc-present-open,html[data-tdoc-presenting] .tdoc-visual-open{display:none!important;}' +
    'html[data-tdoc-theme="dark"][data-tdoc-presenting]{filter:none!important;}';
  document.head.appendChild(style);

  var openButton = null;
  function placeButton() {
    var list = slides();
    if (!list.length || active) { if (openButton) openButton.hidden = true; return; }
    if (!openButton) {
      openButton = provider(document.createElement('button'));
      openButton.type = 'button'; openButton.className = 'tdoc-present-open';
      openButton.setAttribute('aria-label', 'Present slides');
      openButton.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l13-7.5z"/></svg>Present';
      openButton.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); present(0, openButton); });
      document.body.appendChild(openButton);
    }
    var r = list[0].getBoundingClientRect();
    openButton.hidden = !canPresent();
    openButton.style.top = Math.max(0, r.top + window.scrollY - 46) + 'px';
    openButton.style.left = 'clamp(0px,' + Math.max(0, r.right + window.scrollX - 110) + 'px,calc(100% - 110px))';
  }

  // Put one slide on the stage: fixed at its laid-out size, centered, scaled
  // to fit above the control bar. Everything temporary is recorded and undone.
  function mount(el) {
    var r = el.getBoundingClientRect();
    var rec = { el: el, style: el.getAttribute('style'), popover: el.getAttribute('popover'), width: r.width, height: r.height };
    var original = getComputedStyle(el);
    var css = { position: 'fixed', inset: 'auto', left: '50%', top: 'calc(50% - 32px)', margin: '0',
      width: r.width + 'px', height: r.height + 'px', 'max-width': 'none', 'max-height': 'none',
      'box-sizing': 'border-box', 'transform-origin': 'center',
      'background-color': original.backgroundColor === 'rgba(0, 0, 0, 0)' ? '#fff' : original.backgroundColor };
    if (document.documentElement.getAttribute('data-tdoc-theme') === 'dark') css.filter = 'invert(1) hue-rotate(180deg)';
    Object.keys(css).forEach(function (key) { el.style.setProperty(key, css[key], 'important'); });
    el.setAttribute('popover', 'manual');
    el.showPopover();
    rec.fit = function () {
      var scale = Math.min((innerWidth - 24) / rec.width, (innerHeight - 88) / rec.height);
      el.style.setProperty('transform', 'translate(-50%,-50%) scale(' + scale + ')', 'important');
    };
    rec.fit();
    return rec;
  }
  function unmount(rec) {
    if (!rec) return;
    if (rec.el.matches(':popover-open')) rec.el.hidePopover();
    restoreAttr(rec.el, 'style', rec.style); restoreAttr(rec.el, 'popover', rec.popover);
  }
  function go(index) {
    if (!active) return;
    var list = active.list, i = Math.max(0, Math.min(list.length - 1, index));
    if (active.current && active.index === i) return;
    unmount(active.current);
    active.index = i;
    active.current = mount(list[i]);
    // The newest popover is drawn on top: re-show the bar above the slide.
    if (active.bar.matches(':popover-open')) { active.bar.hidePopover(); active.bar.showPopover(); }
    active.counter.value = (i + 1) + ' / ' + list.length;
    active.prev.disabled = i === 0; active.next.disabled = i === list.length - 1;
    list[i].setAttribute('aria-current', 'page');
    list.forEach(function (el, k) { if (k !== i) el.removeAttribute('aria-current'); });
  }
  function present(index, from) {
    var list = slides();
    if (active || !list.length || !canPresent()) return;
    trigger = from || null;
    var stage = provider(document.createElement('div'));
    stage.className = 'tdoc-present-stage'; stage.setAttribute('popover', 'manual');
    stage.setAttribute('role', 'dialog'); stage.setAttribute('aria-label', 'Slides');
    var bar = provider(document.createElement('div'));
    bar.className = 'tdoc-present-bar'; bar.setAttribute('popover', 'manual');
    function button(text, name, action, cls) {
      var b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute('aria-label', name);
      if (cls) b.className = cls; b.addEventListener('click', function (e) { e.stopPropagation(); action(); }); bar.appendChild(b); return b;
    }
    var prev = button('‹', 'Previous slide', function () { go(active.index - 1); });
    var counter = document.createElement('output'); counter.setAttribute('aria-live', 'polite'); bar.appendChild(counter);
    var next = button('›', 'Next slide', function () { go(active.index + 1); });
    var close = button('×', 'Stop presenting', stop, 'tdoc-present-close');
    document.body.appendChild(stage); document.body.appendChild(bar);
    active = { list: list, stage: stage, bar: bar, prev: prev, next: next, counter: counter, close: close, index: -1, current: null, scrollX: scrollX, scrollY: scrollY };
    document.documentElement.setAttribute('data-tdoc-presenting', '');
    document.documentElement.setAttribute('data-tdoc-visual-open', '');
    stage.showPopover();
    go(index || 0);
    bar.showPopover();
    next.focus({ preventScroll: true });
    post(true);
  }
  function stop() {
    if (!active) return;
    var a = active; active = null;
    unmount(a.current);
    a.list.forEach(function (el) { el.removeAttribute('aria-current'); });
    if (a.stage.matches(':popover-open')) a.stage.hidePopover();
    if (a.bar.matches(':popover-open')) a.bar.hidePopover();
    a.stage.remove(); a.bar.remove();
    document.documentElement.removeAttribute('data-tdoc-presenting');
    document.documentElement.removeAttribute('data-tdoc-visual-open');
    post(false);
    requestAnimationFrame(function () {
      var shown = a.list[a.index];
      if (shown && shown.isConnected) shown.scrollIntoView({ block: 'center' }); else window.scrollTo(a.scrollX, a.scrollY);
      placeButton();
      if (trigger && trigger.isConnected) trigger.focus({ preventScroll: true });
    });
  }

  document.addEventListener('keydown', function (e) {
    if (!active) return;
    var k = e.key;
    if (k === 'Escape') { e.preventDefault(); stop(); }
    else if (k === 'ArrowRight' || k === 'PageDown' || k === ' ' || k === 'Enter' && e.target === document.body) { e.preventDefault(); go(active.index + 1); }
    else if (k === 'ArrowLeft' || k === 'PageUp') { e.preventDefault(); go(active.index - 1); }
    else if (k === 'Home') { e.preventDefault(); go(0); }
    else if (k === 'End') { e.preventDefault(); go(active.list.length - 1); }
  }, true);
  var swipe = null;
  document.addEventListener('pointerdown', function (e) { if (active && !e.target.closest('button,a,input,textarea,select,iframe')) swipe = { x: e.clientX, y: e.clientY }; });
  document.addEventListener('pointerup', function (e) {
    if (!active || !swipe) return;
    var dx = e.clientX - swipe.x, dy = e.clientY - swipe.y; swipe = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) go(active.index + (dx < 0 ? 1 : -1));
  });
  document.addEventListener('pointercancel', function () { swipe = null; });
  window.addEventListener('resize', function () { if (active && active.current) active.current.fit(); else placeButton(); });
  window.addEventListener('scroll', function () { if (!active) placeButton(); }, { passive: true });
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || e.data?.source !== 'tdoc-shell') return;
    if (e.data.type === 'tdoc:mode') { if (active && !canPresent()) stop(); placeButton(); }
    if (e.data.type === 'tdoc:present') present(Number(e.data.index) || 0, null);
  });
  new ResizeObserver(placeButton).observe(document.body);
  placeButton();
})();
