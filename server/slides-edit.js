// Slide controls in Edit mode. A deck is built from whole slides, and the text
// editor only knows text: copying a slide pasted it inside the next one, and
// deleting one by selection left an empty frame or merged two. So in Edit
// mode each slide gets a small bar -- Add slide (Title / Bullets / Big
// number), Duplicate, Move up, Move down, Image (a Big number slide's picture,
// by link), Delete with Undo -- that acts on the slide element itself: it is
// inserted, cloned or moved as one node beside its siblings, never into
// another slide.
//
// The bar is provider chrome (data-tdoc-provider, outside the edit root), so
// it is never part of a draft or a save. A desktop shows it on the slide under
// the pointer; a phone (and the keyboard) on the slide the caret is in, which
// a tap puts it in.
//
// Slide identity: a slide added or duplicated here gets its own
// data-tdoc-slide id (TdocSlideKit.newSlideId); moving a slide moves the
// element, attributes and all, so the id comments are anchored by
// (selection/anchors/container.js) goes with it.
(function () {
  'use strict';
  if (window === window.parent || typeof TdocSlideKit === 'undefined') return;
  if (new URLSearchParams(location.search).get('tdoc_compare') === '1') return;
  var Kit = TdocSlideKit;
  var SLIDE = '[data-tdoc-slide]';
  var root = document.documentElement;
  var hovered = null, caretSlide = null, shown = null, menu = null, imagePop = null, toast = null, toastTimer = null;

  function editing() {
    return root.getAttribute('data-tdoc-interaction-mode') === 'edit' && !root.hasAttribute('data-tdoc-presenting');
  }
  // Top-level slides only: a slide is never looked for inside another.
  function slides() {
    return Array.prototype.filter.call(document.querySelectorAll(SLIDE), function (el) {
      return el instanceof HTMLElement && !(el.parentElement && el.parentElement.closest(SLIDE));
    });
  }
  function slideOf(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentNode);
    var found = el && el.closest ? el.closest(SLIDE) : null;
    while (found && found.parentElement && found.parentElement.closest(SLIDE)) found = found.parentElement.closest(SLIDE);
    return found;
  }
  function sibling(el, dir) {
    var next = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    while (next && !next.matches(SLIDE)) next = dir < 0 ? next.previousElementSibling : next.nextElementSibling;
    return next;
  }
  function provider(el) { el.setAttribute('data-tdoc-provider', ''); return el; }
  function changed(added) {
    document.dispatchEvent(new CustomEvent('tdoc:slides-edit', { detail: { added: added || null } }));
    // The viewer re-lays the deck out (scale, numbers) on a resize.
    window.dispatchEvent(new Event('resize'));
    requestAnimationFrame(place);
  }

  var ICONS = {
    add: '<path d="M12 5v14M5 12h14"/>',
    copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a2 2 0 0 1 2-2h10"/>',
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
  }

  var style = provider(document.createElement('style'));
  style.textContent =
    '.tdoc-slide-bar{position:absolute;z-index:120;display:flex;align-items:center;gap:2px;padding:3px;box-sizing:border-box;border:1px solid #e5e5e7;border-radius:10px;background:#fff;color:#1a1a1a;box-shadow:0 4px 14px rgba(0,0,0,.14);font:13px/18px system-ui,sans-serif;}' +
    '.tdoc-slide-bar[hidden],.tdoc-slide-bar [hidden],.tdoc-slide-pop[hidden],.tdoc-slide-pop [hidden],.tdoc-slide-toast[hidden]{display:none!important;}' +
    '.tdoc-slide-bar button{display:inline-flex;align-items:center;justify-content:center;gap:5px;min-width:32px;height:32px;padding:0 7px;border:0;border-radius:7px;background:transparent;color:inherit;font:inherit;cursor:pointer;}' +
    '.tdoc-slide-bar button:hover:not(:disabled),.tdoc-slide-bar button[aria-expanded="true"]{background:#f0f1f4;}' +
    '.tdoc-slide-bar button:disabled{opacity:.35;cursor:default;}' +
    '.tdoc-slide-bar button.is-danger:hover:not(:disabled){color:#b42318;background:#fef3f2;}' +
    '.tdoc-slide-bar svg{width:16px;height:16px;flex:0 0 auto;}' +
    '.tdoc-slide-bar .tdoc-slide-add{font-weight:600;color:#1652f0;}' +
    '.tdoc-slide-bar i{width:1px;height:18px;margin:0 3px;background:#ebebed;}' +
    '.tdoc-slide-pop{position:absolute;z-index:121;box-sizing:border-box;min-width:220px;max-width:calc(100vw - 16px);padding:4px;border:1px solid #e5e5e7;border-radius:8px;background:#fff;color:#1a1a1a;box-shadow:0 8px 24px rgba(0,0,0,.12);font:13px/18px system-ui,sans-serif;}' +
    '.tdoc-slide-pop [role="menuitem"]{display:flex;flex-direction:column;align-items:flex-start;gap:1px;width:100%;padding:7px 10px;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;}' +
    '.tdoc-slide-pop [role="menuitem"]:hover,.tdoc-slide-pop [role="menuitem"]:focus-visible{background:#f0f1f4;outline:none;}' +
    '.tdoc-slide-pop [role="menuitem"] b{font-weight:600;}' +
    '.tdoc-slide-pop [role="menuitem"] em{font-style:normal;font-size:12px;color:#6b6b73;}' +
    '.tdoc-slide-pop label{display:block;padding:6px 6px 4px;font-weight:600;}' +
    '.tdoc-slide-pop input{box-sizing:border-box;width:100%;height:34px;margin:0;padding:0 10px;border:1px solid #d0d5dd;border-radius:7px;font:13px system-ui,sans-serif;color:#1a1a1a;background:#fff;}' +
    '.tdoc-slide-pop input:focus{outline:none;border-color:#1652f0;box-shadow:0 0 0 3px #e8eeff;}' +
    '.tdoc-slide-pop .tdoc-slide-image-row{display:flex;gap:6px;padding:8px 6px 6px;justify-content:flex-end;}' +
    '.tdoc-slide-pop .tdoc-slide-image-row button{height:30px;padding:0 12px;border:1px solid #d0d5dd;border-radius:7px;background:#fff;color:#1a1a1a;font:600 13px system-ui,sans-serif;cursor:pointer;}' +
    '.tdoc-slide-pop .tdoc-slide-image-row button.is-primary{border-color:#1652f0;background:#1652f0;color:#fff;}' +
    '.tdoc-slide-pop .tdoc-slide-image-field{padding:0 6px;}' +
    '.tdoc-slide-pop .tdoc-slide-image-error{margin:6px 6px 0;color:#b42318;font-size:12px;}' +
    '.tdoc-slide-pop .tdoc-slide-image-note{margin:6px 6px 0;color:#6b6b73;font-size:12px;}' +
    '.tdoc-slide-toast{position:fixed;z-index:122;left:50%;bottom:max(16px,env(safe-area-inset-bottom));transform:translateX(-50%);display:flex;align-items:center;gap:12px;padding:8px 8px 8px 14px;border-radius:10px;background:#1f2128;color:#fff;font:13px/18px system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.25);}' +
    '.tdoc-slide-toast button{height:30px;padding:0 12px;border:0;border-radius:7px;background:#ffffff1f;color:#fff;font:600 13px system-ui,sans-serif;cursor:pointer;}' +
    '@media (max-width:700px),(pointer:coarse){.tdoc-slide-bar button{min-width:40px;height:40px;}.tdoc-slide-bar .tdoc-slide-add span{display:none;}.tdoc-slide-pop [role="menuitem"]{min-height:44px;justify-content:center;}.tdoc-slide-pop input{height:40px;}.tdoc-slide-pop .tdoc-slide-image-row button{height:40px;}}' +
    'html:not([data-tdoc-interaction-mode="edit"]) .tdoc-slide-bar,html[data-tdoc-presenting] .tdoc-slide-bar{display:none!important;}';
  document.head.appendChild(style);

  // ---- the bar -----------------------------------------------------------
  var bar = provider(document.createElement('div'));
  bar.className = 'tdoc-slide-bar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Slide');
  bar.hidden = true;
  function barButton(name, label, text, action, cls) {
    var b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.innerHTML = icon(name) + (text ? '<span>' + text + '</span>' : '');
    if (cls) b.className = cls;
    // Keep the caret where it is: a press on the bar is not a click in the page.
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); if (shown) action(shown, b); });
    bar.appendChild(b);
    return b;
  }
  var addBtn = barButton('add', 'Add slide after this one', 'Add slide', openLayouts, 'tdoc-slide-add');
  addBtn.setAttribute('aria-haspopup', 'menu');
  addBtn.setAttribute('aria-expanded', 'false');
  bar.appendChild(document.createElement('i'));
  var copyBtn = barButton('copy', 'Duplicate slide', '', duplicate);
  var upBtn = barButton('up', 'Move slide up', '', function (el) { move(el, -1); });
  var downBtn = barButton('down', 'Move slide down', '', function (el) { move(el, 1); });
  var imageBtn = barButton('image', 'Slide image', '', openImage);
  imageBtn.setAttribute('aria-haspopup', 'dialog');
  var deleteBtn = barButton('trash', 'Delete slide', '', remove, 'is-danger');

  function target() {
    if (!editing()) return null;
    if (hovered && hovered.isConnected) return hovered;
    if (caretSlide && caretSlide.isConnected) return caretSlide;
    return null;
  }
  function place() {
    var el = (menu || imagePop) && shown && shown.isConnected ? shown : target();
    if (!el) { bar.hidden = true; shown = null; closePops(); return; }
    if (!bar.isConnected) document.body.appendChild(bar);
    if (shown !== el) closePops();
    shown = el;
    var list = slides(), at = list.indexOf(el);
    upBtn.disabled = !sibling(el, -1);
    downBtn.disabled = !sibling(el, 1);
    deleteBtn.disabled = list.length <= 1;
    imageBtn.hidden = !el.querySelector('[data-tdoc-slide-image]');
    bar.setAttribute('aria-label', 'Slide ' + (at + 1) + ' of ' + list.length);
    bar.hidden = false;
    var r = el.getBoundingClientRect();
    var left = r.right + window.scrollX - bar.offsetWidth - 8;
    bar.style.left = Math.max(window.scrollX + 4, Math.min(left, window.scrollX + document.documentElement.clientWidth - bar.offsetWidth - 4)) + 'px';
    bar.style.top = (r.top + window.scrollY + 8) + 'px';
    if (menu) placePop(menu, addBtn);
    if (imagePop) placePop(imagePop, imageBtn);
  }

  // ---- popovers ----------------------------------------------------------
  function placePop(pop, from) {
    var b = from.getBoundingClientRect();
    var width = pop.offsetWidth;
    var left = Math.min(b.left + window.scrollX, window.scrollX + document.documentElement.clientWidth - width - 8);
    pop.style.left = Math.max(window.scrollX + 8, left) + 'px';
    pop.style.top = (b.bottom + window.scrollY + 6) + 'px';
  }
  function closePops(refocus) {
    var had = menu ? addBtn : imagePop ? imageBtn : null;
    if (menu) { menu.remove(); menu = null; addBtn.setAttribute('aria-expanded', 'false'); }
    if (imagePop) { imagePop.remove(); imagePop = null; imageBtn.setAttribute('aria-expanded', 'false'); }
    if (refocus && had && had.isConnected) had.focus({ preventScroll: true });
  }
  function openLayouts(el) {
    if (menu) { closePops(true); return; }
    closePops();
    menu = provider(document.createElement('div'));
    menu.className = 'tdoc-slide-pop';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Add a slide');
    Kit.SLIDE_LAYOUTS.forEach(function (layout) {
      var item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('data-layout', layout.id);
      item.innerHTML = '<b></b><em></em>';
      item.firstChild.textContent = layout.label;
      item.lastChild.textContent = layout.hint;
      item.addEventListener('mousedown', function (e) { e.preventDefault(); });
      item.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); var from = shown; closePops(); add(from, layout.id); });
      menu.appendChild(item);
    });
    menu.addEventListener('keydown', function (e) {
      var items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]'));
      var at = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closePops(true); }
    });
    document.body.appendChild(menu);
    addBtn.setAttribute('aria-expanded', 'true');
    placePop(menu, addBtn);
    menu.querySelector('[role="menuitem"]').focus({ preventScroll: true });
  }

  // A picture by link: http(s) only, never inline data. The document stays a
  // page of text and links; the picture is fetched from where it lives.
  function imageUrl(value) {
    var text = String(value || '').trim();
    if (!text) return '';
    try {
      var url = new URL(text);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname) return url.href;
    } catch (e) {}
    return '';
  }
  function openImage(el) {
    if (imagePop) { closePops(true); return; }
    closePops();
    var slot = el.querySelector('[data-tdoc-slide-image]');
    if (!slot) return;
    var current = slot.querySelector('img');
    imagePop = provider(document.createElement('div'));
    imagePop.className = 'tdoc-slide-pop';
    imagePop.setAttribute('role', 'dialog');
    imagePop.setAttribute('aria-label', 'Slide image');
    imagePop.innerHTML = '<label for="tdoc-slide-image-url">Image link</label>'
      + '<div class="tdoc-slide-image-field"><input id="tdoc-slide-image-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://…"></div>'
      + '<p class="tdoc-slide-image-note">A link to a picture on the web (https).</p>'
      + '<p class="tdoc-slide-image-error" role="alert" hidden></p>'
      + '<div class="tdoc-slide-image-row"></div>';
    var input = imagePop.querySelector('input');
    var error = imagePop.querySelector('.tdoc-slide-image-error');
    var row = imagePop.querySelector('.tdoc-slide-image-row');
    if (current) input.value = current.getAttribute('src') || '';
    function rowButton(text, action, primary) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = text;
      if (primary) b.className = 'is-primary';
      b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); action(); });
      row.appendChild(b);
      return b;
    }
    function apply() {
      var href = imageUrl(input.value);
      if (!href) {
        error.textContent = 'Use a link that starts with https:// (or http://).';
        error.hidden = false;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        return;
      }
      var img = document.createElement('img');
      img.src = href;
      img.alt = '';
      img.setAttribute('loading', 'lazy');
      slot.textContent = '';
      slot.appendChild(img);
      closePops(true);
      changed(slot);
    }
    if (current) rowButton('Remove', function () { slot.textContent = ''; closePops(true); changed(); });
    rowButton('Cancel', function () { closePops(true); });
    rowButton(current ? 'Replace' : 'Add image', apply, true);
    input.addEventListener('input', function () { error.hidden = true; input.removeAttribute('aria-invalid'); });
    imagePop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target === input) { e.preventDefault(); apply(); }
      else if (e.key === 'Escape') { e.preventDefault(); closePops(true); }
    });
    document.body.appendChild(imagePop);
    imageBtn.setAttribute('aria-expanded', 'true');
    placePop(imagePop, imageBtn);
    input.focus({ preventScroll: true });
  }

  // ---- what the buttons do ----------------------------------------------
  // The kit's stylesheet goes with the first kit slide into a deck that does
  // not have it yet (an agent's deck), at the top of the slides' container.
  function ensureKit(container) {
    if (document.querySelector('style[data-tdoc-slide-kit]')) return;
    var kit = document.createElement('style');
    kit.setAttribute('data-tdoc-slide-kit', '');
    kit.textContent = '\n' + Kit.KIT_CSS + '\n';
    container.insertBefore(kit, container.firstChild);
  }
  function fromHtml(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }
  function focusText(el) {
    var heading = el.querySelector('h1,h2,h3,p,li');
    if (!heading) return;
    try {
      var range = document.createRange();
      range.selectNodeContents(heading);
      var sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(range);
    } catch (e) {}
  }
  function settle(el, focus) {
    hovered = null;
    caretSlide = el;
    changed(el);
    el.scrollIntoView({ block: 'nearest' });
    if (focus) focusText(el);
    requestAnimationFrame(place);
  }
  function add(after, layout) {
    if (!after || !after.parentNode) return;
    ensureKit(after.parentNode);
    var el = fromHtml(Kit.slideHtml(layout, { id: Kit.newSlideId() }));
    after.parentNode.insertBefore(el, after.nextSibling);
    settle(el, true);
  }
  function duplicate(el) {
    var copy = el.cloneNode(true);
    // Its own identity: a twin would share the original's comments' id.
    copy.setAttribute('data-tdoc-slide', Kit.newSlideId());
    copy.removeAttribute('id');
    copy.removeAttribute('aria-current');
    Array.prototype.forEach.call(copy.querySelectorAll('[id]'), function (node) { node.removeAttribute('id'); });
    Array.prototype.forEach.call(copy.querySelectorAll('[data-tdoc-caret]'), function (node) { node.removeAttribute('data-tdoc-caret'); });
    el.parentNode.insertBefore(copy, el.nextSibling);
    settle(copy, false);
    copyBtn.focus({ preventScroll: true });
  }
  function move(el, dir) {
    var other = sibling(el, dir);
    if (!other) return;
    if (dir < 0) other.parentNode.insertBefore(el, other);
    else other.parentNode.insertBefore(other, el);
    settle(el, false);
    var again = dir < 0 ? upBtn : downBtn;
    (again.disabled ? (dir < 0 ? downBtn : upBtn) : again).focus({ preventScroll: true });
  }
  function remove(el) {
    if (slides().length <= 1) return;
    var parent = el.parentNode, next = el.nextSibling;
    var neighbour = sibling(el, 1) || sibling(el, -1);
    el.remove();
    hovered = null;
    caretSlide = neighbour;
    changed();
    showToast('Slide deleted', function () {
      if (el.isConnected) return;
      parent.insertBefore(el, next && next.parentNode === parent ? next : null);
      settle(el, false);
    });
  }
  function showToast(text, undo) {
    if (toast) toast.remove();
    clearTimeout(toastTimer);
    toast = provider(document.createElement('div'));
    toast.className = 'tdoc-slide-toast';
    toast.setAttribute('role', 'status');
    var words = document.createElement('span');
    words.textContent = text;
    var b = document.createElement('button');
    b.type = 'button'; b.textContent = 'Undo';
    b.addEventListener('mousedown', function (e) { e.preventDefault(); });
    b.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); hideToast(); undo(); });
    toast.appendChild(words); toast.appendChild(b);
    document.body.appendChild(toast);
    toastTimer = setTimeout(hideToast, 10000);
    b.focus({ preventScroll: true });
  }
  function hideToast() { clearTimeout(toastTimer); if (toast) { toast.remove(); toast = null; } }

  // ---- which slide ------------------------------------------------------
  document.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse' || !editing()) return;
    if (bar.contains(e.target) || (menu && menu.contains(e.target)) || (imagePop && imagePop.contains(e.target))) return;
    var next = slideOf(e.target);
    if (next !== hovered) { hovered = next; place(); }
  }, { passive: true });
  document.addEventListener('pointerleave', function () { if (hovered) { hovered = null; place(); } });
  document.addEventListener('selectionchange', function () {
    if (!editing()) return;
    var sel = window.getSelection();
    var next = sel && sel.rangeCount ? slideOf(sel.getRangeAt(0).startContainer) : null;
    if (next && next !== caretSlide) { caretSlide = next; place(); }
  });
  document.addEventListener('pointerdown', function (e) {
    if (!menu && !imagePop) return;
    if (bar.contains(e.target) || (menu && menu.contains(e.target)) || (imagePop && imagePop.contains(e.target))) return;
    closePops();
  }, true);
  new MutationObserver(function () {
    if (!editing()) { hovered = null; caretSlide = null; hideToast(); }
    place();
  }).observe(root, { attributes: true, attributeFilter: ['data-tdoc-interaction-mode', 'data-tdoc-presenting', 'data-tdoc-slides'] });
  window.addEventListener('resize', function () { requestAnimationFrame(place); });
  new ResizeObserver(function () { place(); }).observe(document.body);
})();
