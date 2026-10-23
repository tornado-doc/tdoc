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
  function post(open) {
    window.parent.postMessage({ source: 'tdoc-frame', type: 'tdoc:visualState', open: open }, '*');
    // Presenting keeps commenting: the shell keeps its composer and comment
    // card above the full-screen frame.
    window.parent.postMessage({ source: 'tdoc-frame', type: 'tdoc:presentState', open: open }, '*');
  }
  function postShell(msg) { msg.source = 'tdoc-frame'; window.parent.postMessage(msg, '*'); }
  // Threads per slide, from the probe's latest anchor resolution.
  var anchors = { targets: {}, ids: [] };
  document.addEventListener('tdoc:anchors-resolved', function (e) {
    var d = e.detail || {};
    anchors = { targets: d.targets || {}, ids: Array.isArray(d.comments) ? d.comments : [] };
    if (active) updateCount();
  });
  function threadsOn(el) {
    return anchors.ids.filter(function (id) {
      var t = anchors.targets[id];
      if (!t) return false;
      if (t.element) return el.contains(t.element) || t.element.contains(el) && t.element === el;
      // A text anchor can end just past its block (at the next slide's start),
      // so the slide that holds its first character owns it.
      var node = t.range && t.range.startContainer;
      if (node && node.nodeType === 1 && node.childNodes[t.range.startOffset]) node = node.childNodes[t.range.startOffset];
      return !!node && el.contains(node.nodeType === 1 ? node : node.parentNode);
    });
  }
  function updateCount() {
    if (!active) return;
    var ids = threadsOn(active.list[active.index]);
    if (ids.join() !== (active.threads || []).join()) active.threadAt = 0;
    active.threads = ids;
    active.view.hidden = !ids.length;
    active.view.textContent = ids.length === 1 ? '1 comment' : ids.length + ' comments';
    active.view.setAttribute('aria-label', 'Show ' + active.view.textContent + ' on this slide');
  }
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
    '.tdoc-present-bar .tdoc-present-notes{position:absolute;left:max(12px,env(safe-area-inset-left));display:flex;gap:8px;}' +
    '.tdoc-present-bar [hidden]{display:none!important;}' +
    '@media (max-width:560px){.tdoc-present-bar{flex-wrap:wrap;}.tdoc-present-bar .tdoc-present-notes{position:static;width:100%;justify-content:center;}.tdoc-present-bar .tdoc-present-close{position:static;}}' +
    'html[data-tdoc-presenting]{overflow:hidden!important;}' +
    // Slide view: every slide is laid out at the deck width (960px, 16:9) and
    // zoomed to the reading column, like a presentation app's normal view.
    // zoom (not transform) keeps layout, selection and comment anchors real.
    'html[data-tdoc-slides]:not([data-tdoc-presenting]) [data-tdoc-slide]{width:960px!important;max-width:none!important;aspect-ratio:16/9;height:auto!important;box-sizing:border-box!important;overflow:hidden!important;zoom:var(--tdoc-slide-zoom,1);margin-left:auto!important;margin-right:auto!important;margin-bottom:calc(36px / var(--tdoc-slide-zoom,1))!important;}' +
    '.tdoc-slide-num.is-over{color:#b42318;}' +
    '.tdoc-slide-num{position:absolute;z-index:1;font:12px/1 system-ui;color:#667085;font-variant-numeric:tabular-nums;pointer-events:none;}' +
    'html[data-tdoc-presenting] .tdoc-slide-num{display:none!important;}' +
    'html[data-tdoc-interaction-mode="edit"] .tdoc-slide-num{display:none!important;}' +
    'html[data-tdoc-presenting] .tdoc-present-open,html[data-tdoc-presenting] .tdoc-visual-open{display:none!important;}' +
    'html[data-tdoc-theme="dark"][data-tdoc-presenting]{filter:none!important;}';
  document.head.appendChild(style);

  var openButton = null, numbers = [];
  var zoomStyle = provider(document.createElement('style'));
  document.head.appendChild(zoomStyle);
  // Zoom the slides to the column they sit in, and number them underneath.
  function layoutSlides(list) {
    var root = document.documentElement;
    if (!list.length) { root.removeAttribute('data-tdoc-slides'); zoomStyle.textContent = ''; numbers.forEach(function (n) { n.remove(); }); numbers = []; return; }
    root.setAttribute('data-tdoc-slides', '');
    var parent = list[0].parentElement || document.body;
    var cs = getComputedStyle(parent);
    var room = parent.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
    var zoom = Math.max(.2, Math.min(1, room / 960));
    // In a provider <style>, not on <html>: nothing here may be saved into the
    // author's document by Edit mode.
    var rule = ':root{--tdoc-slide-zoom:' + zoom + '}';
    if (zoomStyle.textContent !== rule) zoomStyle.textContent = rule;
    while (numbers.length > list.length) numbers.pop().remove();
    list.forEach(function (el, i) {
      var n = numbers[i];
      if (!n) { n = provider(document.createElement('div')); n.className = 'tdoc-slide-num'; n.setAttribute('aria-hidden', 'true'); document.body.appendChild(n); numbers[i] = n; }
      // Content past the 16:9 box is cut off when presenting: say so here.
      var over = el.scrollHeight > el.clientHeight + 2 || el.scrollWidth > el.clientWidth + 2;
      n.textContent = (i + 1) + ' / ' + list.length + (over ? ' · content is cut off' : '');
      n.classList.toggle('is-over', over);
      var r = el.getBoundingClientRect();
      n.style.top = (r.bottom + window.scrollY + 8) + 'px';
      n.style.left = (r.right + window.scrollX - n.offsetWidth) + 'px';
    });
  }
  function placeButton() {
    var list = slides();
    if (!active) layoutSlides(list);
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
  // A slide is laid out at a presentation width (at least 960px) before it
  // is scaled down, so a phone shows the deck's desktop layout, not the
  // narrow reading column blown up. Its own aspect ratio sets the height.
  var STAGE_WIDTH = 960;
  function mount(el) {
    var r = el.getBoundingClientRect();
    var width = Math.max(r.width, STAGE_WIDTH);
    var rec = { el: el, style: el.getAttribute('style'), popover: el.getAttribute('popover'), width: width, height: r.height * width / r.width };
    var original = getComputedStyle(el);
    var css = { position: 'fixed', inset: 'auto', left: '50%', top: 'calc(50% - 32px)', margin: '0',
      width: width + 'px', height: (getComputedStyle(el).aspectRatio !== 'auto' ? 'auto' : rec.height + 'px'), 'max-width': 'none', 'max-height': 'none',
      'box-sizing': 'border-box', 'transform-origin': 'center',
      'background-color': original.backgroundColor === 'rgba(0, 0, 0, 0)' ? '#fff' : original.backgroundColor };
    if (document.documentElement.getAttribute('data-tdoc-theme') === 'dark') css.filter = 'invert(1) hue-rotate(180deg)';
    Object.keys(css).forEach(function (key) { el.style.setProperty(key, css[key], 'important'); });
    el.setAttribute('popover', 'manual');
    el.showPopover();
    rec.height = el.offsetHeight || rec.height;
    rec.fit = function () {
      var barH = active && active.bar ? active.bar.offsetHeight : 64;
      var scale = Math.min((innerWidth - 24) / rec.width, (innerHeight - barH - 24) / rec.height);
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
    if (active.bar.matches(':popover-open')) { active.bar.hidePopover(); active.bar.showPopover(); active.current.fit(); }
    active.counter.value = (i + 1) + ' / ' + list.length;
    updateCount();
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
    var notes = document.createElement('div'); notes.className = 'tdoc-present-notes'; bar.insertBefore(notes, bar.firstChild);
    var commentBtn = document.createElement('button'); commentBtn.type = 'button'; commentBtn.textContent = 'Comment';
    commentBtn.setAttribute('aria-label', 'Comment on this slide');
    // The composer opens next to this button, above the bar, not at the
    // slide's far corner.
    commentBtn.addEventListener('click', function (e) { e.stopPropagation(); document.dispatchEvent(new CustomEvent('tdoc:comment-element', { detail: { el: active.list[active.index], rect: commentBtn.getBoundingClientRect() } })); });
    var view = document.createElement('button'); view.type = 'button'; view.hidden = true;
    // Each press opens the slide's next thread, wrapping round.
    view.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!active || !active.threads || !active.threads.length) return;
      var i = active.threadAt % active.threads.length;
      active.threadAt = i + 1;
      postShell({ type: 'tdoc:anchorClick', id: active.threads[i] });
    });
    notes.appendChild(commentBtn); notes.appendChild(view);
    // Same rule as the page: commenting is offered only in Comment mode.
    commentBtn.hidden = document.documentElement.getAttribute('data-tdoc-interaction-mode') !== 'comment';
    document.body.appendChild(stage); document.body.appendChild(bar);
    active = { list: list, stage: stage, bar: bar, prev: prev, next: next, counter: counter, close: close, view: view, threads: [], threadAt: 0, index: -1, current: null, scrollX: scrollX, scrollY: scrollY };
    document.documentElement.setAttribute('data-tdoc-presenting', '');
    stage.showPopover();
    go(index || 0);
    bar.showPopover();
    active.current.fit();
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
    // Space and Enter on a focused control press that control.
    else if ((k === ' ' || k === 'Enter') && e.target.closest && e.target.closest('button,a,input,textarea,select')) return;
    else if (k === 'ArrowRight' || k === 'PageDown' || k === ' ' || k === 'Enter') { e.preventDefault(); go(active.index + 1); }
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
