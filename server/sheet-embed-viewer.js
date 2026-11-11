// Sheet embeds in the doc frame: a `<figure data-tdoc-embed="sheet"
// data-src="/d/<slug>">` (shared/sheet-embed.mjs) becomes a compact live view
// of that sheet: its title linking to it, the header and the first rows of
// one tab with the reference's saved view applied, the open comment count,
// and Open. Served at /sheet-embed.js and loaded by server/sheet-embed-loader.js
// only when the page holds an embed. SheetQuery (shared/sheet-query.mjs) and
// SheetEmbedRef (shared/sheet-embed.mjs) are inlined by
// server/sheet-embed-source.js.
//
// Where the data comes from. This frame has an opaque origin and no
// credentials, so it does not fetch: it asks the shell over postMessage, and
// the shell asks GET /api/embed/sheet, which applies the SHEET's access rules
// for the person reading. Two things keep that channel to this frame:
//   - the key. The shell opens this frame at <src>#tdoc-embed=<key>, a random
//     value per page. Every request carries it; the shell answers nothing
//     without it. A page the frame is navigated to (an author's
//     <meta http-equiv=refresh>) never sees this URL's fragment, so it cannot
//     ask for anybody's sheet.
//   - the port. Each request brings a MessageChannel port and the answer
//     comes back on it, never to '*': a port belongs to this document and
//     dies with it, so an answer in flight when the frame navigates is lost,
//     not delivered to whatever loaded next.
//
// What is drawn. The answer is data (text, numbers, tag lists), written with
// textContent into a CLOSED shadow root: author CSS cannot select or restyle
// anything in it (so it cannot probe cell values with attribute selectors
// either: no value is ever an attribute), and author markup never sees it.
// The figure's own children (the fallback link) are hidden only once the
// view is live; on any failure that leaves no answer they stay, so the page
// reads as it would without the viewer. The host is a provider element: the
// editor strips it when it saves, so the doc keeps only the reference.
(function () {
  'use strict';
  if (window === window.parent || window.__tdocSheetEmbeds) return;
  var Q = SheetQuery, R = SheetEmbedRef;
  var keyMatch = /(?:^#|&)tdoc-embed=([A-Za-z0-9_-]{16,64})(?:&|$)/.exec(location.hash || '');
  var KEY = keyMatch ? keyMatch[1] : '';
  var TIMEOUT_MS = 20000;
  var embeds = [];
  window.__tdocSheetEmbeds = {
    // Read-only state for tests: never the sheet's title or cells.
    list: function () { return embeds.map(function (e) { return { slug: e.slug, state: e.state, rows: e.rows }; }); },
  };
  // No key: not the reader's frame (the version compare, history, a frame
  // opened on its own). Nobody would answer; the figures stay links.
  if (!KEY) return;

  function post(msg, transfer) {
    msg.source = 'tdoc-frame';
    try { window.parent.postMessage(msg, '*', transfer || []); } catch (e) {}
  }
  function h(tag, cls, text) {
    var el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text != null) el.textContent = String(text);
    return el;
  }
  function fmt(n) { return Number(n).toLocaleString('en-US'); }
  // Only an address this viewer built or checked: a sheet page on this tdoc.
  var SHEET_HREF = /^\/d\/[a-z0-9][a-z0-9-]{0,63}(\?sheet=\d{1,4})?(#sheet=[^\s"'<>]*)?$/;
  function safeSheetHref(href, slug) {
    return typeof href === 'string' && SHEET_HREF.test(href) && href.indexOf('/d/' + slug) === 0 ? href : '/d/' + slug;
  }
  function externalHref(text) {
    var s = String(text || '').trim();
    return /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
  }

  var ICON = {
    grid: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10" stroke="currentColor" stroke-width="1.8"/></svg>',
    comment: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 2H12A10 10 0 1 1 2 12V2Z"/></svg>',
    external: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  };
  function icon(name) { var s = h('span', 'se-icon'); s.innerHTML = ICON[name]; return s; }

  // The card's own styles, inside the shadow root. The card is drawn inside
  // the author's document, so nothing about it that author CSS can observe
  // may depend on the sheet: the host's size is fixed from data-rows alone
  // (the same in every state: loading, live, no access, error), it is size-
  // and paint-contained and clips, `!important` in the shadow context beats
  // anything the page says about the host, no state is ever an attribute in
  // the page, and the type is generic families only (no author @font-face,
  // so no unicode-range probes). Values are text; nothing loads.
  var TOP_H = 44, HEAD_H = 33, ROW_H = 34, FOOT_H = 32;
  function rowsOf(value) {
    var n = Math.floor(Number(String(value == null ? '' : value).trim()));
    return Number.isFinite(n) && n >= 1 ? Math.min(R.EMBED_MAX_ROWS, n) : R.EMBED_DEFAULT_ROWS;
  }
  function hostCss(embed) {
    var height = 2 + TOP_H + HEAD_H + embed.rowsShown * ROW_H + FOOT_H;
    return ':host{all:initial!important;display:block!important;box-sizing:border-box!important;contain:strict!important;overflow:hidden!important;'
      + 'width:auto!important;height:' + height + 'px!important;min-height:0!important;max-height:none!important;margin:0 0 8px!important;padding:0!important;'
      + 'visibility:visible!important;opacity:1!important;transform:none!important;filter:none!important}\n';
  }
  var CSS = [
    ':host(:focus-visible){outline:2px solid #1652f0!important;outline-offset:2px!important}',
    '.se{--se-accent:#1652f0;--se-ink:#17171a;--se-muted:#666670;--se-line:#e6e6ea;--se-head:#f7f7f8;',
    'box-sizing:border-box;height:100%;display:flex;flex-direction:column;margin:0;border:1px solid var(--se-line);border-radius:10px;background:#fff;color:var(--se-ink);',
    'font:13px/1.45 system-ui,sans-serif;text-align:left;overflow:hidden;-webkit-user-select:none;user-select:none}',
    '.se *{box-sizing:border-box}',
    '.se-top{flex:none;display:flex;align-items:center;gap:10px;height:' + TOP_H + 'px;padding:0 10px 0 12px;border-bottom:1px solid var(--se-line);overflow:hidden}',
    '.se-title{flex:1;min-width:0;display:flex;align-items:center;gap:8px;color:inherit;text-decoration:none;font-weight:600;font-size:14px}',
    '.se-title b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.se-title span.se-tab{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--se-muted);font-weight:500}',
    'a.se-title:hover b{text-decoration:underline}',
    '.se-icon{flex:none;display:inline-flex;width:16px;height:16px;color:var(--se-muted)}',
    '.se-icon svg{width:16px;height:16px;display:block}',
    '.se-act{flex:none;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:1px solid #d6d6dc;border-radius:8px;background:#fff;color:inherit;text-decoration:none;font-weight:500;white-space:nowrap}',
    '.se-act:hover{background:var(--se-head)}',
    '.se-act .se-icon{width:14px;height:14px}',
    '.se-act .se-icon svg{width:14px;height:14px}',
    '.se-comments{border-color:transparent;color:var(--se-muted)}',
    '.se-comments:hover{color:var(--se-ink)}',
    '.se-scroll{flex:1;min-height:0;overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}',
    'table{border-collapse:separate;border-spacing:0;width:100%;font-variant-numeric:tabular-nums}',
    'th,td{box-sizing:border-box;padding:0 10px;line-height:20px;border-bottom:1px solid var(--se-line);text-align:left;vertical-align:middle;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis}',
    'td{height:' + ROW_H + 'px}',
    'th{height:' + HEAD_H + 'px;position:sticky;top:0;z-index:1;background:var(--se-head);font-weight:600;color:#3a3a42}',
    'tr:last-child td{border-bottom:0}',
    'td.se-num,th.se-num{text-align:right}',
    'td a{color:var(--se-accent);text-decoration:none}',
    'td a:hover{text-decoration:underline}',
    '.se-tag{display:inline-block;vertical-align:middle;margin:0 4px 0 0;padding:0 8px;border-radius:999px;font-size:12px;line-height:20px;white-space:nowrap}',
    '.se-foot{flex:none;display:flex;flex-wrap:nowrap;gap:12px;align-items:center;height:' + FOOT_H + 'px;padding:0 12px;border-top:1px solid var(--se-line);background:var(--se-head);color:var(--se-muted);font-size:12px;white-space:nowrap;overflow:hidden}',
    '.se-foot span{overflow:hidden;text-overflow:ellipsis}',
    '.se-foot a{color:var(--se-accent);text-decoration:none;margin-left:auto;font-weight:500}',
    '.se-foot a:hover{text-decoration:underline}',
    '.se-msg{flex:1;min-height:0;display:flex;align-items:center;gap:10px;padding:0 12px;color:var(--se-muted);overflow:hidden}',
    '.se-msg p{margin:0;flex:1;min-width:0}',
    '.se-msg strong{color:var(--se-ink);font-weight:600}',
    '.se-skel{flex:1;min-height:0;padding:10px 12px;overflow:hidden}',
    '.se-skel i{display:block;height:12px;margin:9px 0;border-radius:4px;background:linear-gradient(90deg,#f0f0f3,#f7f7f9,#f0f0f3);background-size:200% 100%;animation:se-shine 1.2s linear infinite}',
    '.se-skel i:nth-child(2){width:86%}.se-skel i:nth-child(3){width:72%}',
    '@keyframes se-shine{to{background-position:-200% 0}}',
    '@media (prefers-reduced-motion:reduce){.se-skel i{animation:none}}',
    '.se-short{display:none}',
    '@media (max-width:640px){.se-top{padding:6px 8px 6px 10px;gap:4px}.se-act{padding:0 8px}.se-act .se-label{display:none}.se-comments .se-short{display:inline}.se-title span.se-tab{display:none}th,td{padding:0 8px;max-width:220px}.se-foot .se-extra{display:none}}',
  ].join('\n');

  // Hide the figure's own children (the fallback link) while the card is
  // there; a figcaption stays. A provider style, so the editor drops it.
  var pageStyle = document.createElement('style');
  pageStyle.setAttribute('data-tdoc-provider', '');
  // From the moment the card is mounted, whatever comes back.
  pageStyle.textContent = '[data-tdoc-embed="sheet"]:has(>[data-tdoc-embed-host])>:not([data-tdoc-embed-host]):not(figcaption){display:none!important}';
  (document.head || document.documentElement).appendChild(pageStyle);

  // Every link the viewer draws, and where it goes. Clicks are taken at the
  // window, before anything else in the frame sees them (the probe's own
  // click handling would otherwise read a click on the card as a click on
  // the page), and only for these links.
  var targets = new WeakMap();
  // No link inside the card is focusable, in any state: the host is the one
  // stop in the tab order (the same in every state), and Enter on it opens
  // the sheet. Pointer clicks still reach each link (onClick below).
  function link(cls, href, blank) {
    var a = h('a', cls);
    a.href = href;
    a.tabIndex = -1;
    targets.set(a, { href: href, blank: !!blank });
    return a;
  }
  function linkIn(embed, ev) {
    var el = ev.detail === 0 ? embed.root.activeElement
      : embed.root.elementFromPoint ? embed.root.elementFromPoint(ev.clientX, ev.clientY) : null;
    for (; el && el !== embed.root; el = el.parentNode) if (targets.has(el)) return targets.get(el);
    return null;
  }
  function onClick(ev) {
    if (ev.type === 'auxclick' && ev.button !== 1) return;
    for (var i = 0; i < embeds.length; i++) {
      if (ev.target !== embeds[i].host) continue;
      var t = linkIn(embeds[i], ev);
      if (!t) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      post({ type: 'tdoc:navigate', href: t.href, blank: t.blank || ev.type === 'auxclick' || ev.metaKey || ev.ctrlKey || ev.shiftKey });
      return;
    }
  }
  function onKey(ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    for (var i = 0; i < embeds.length; i++) {
      if (ev.target !== embeds[i].host) continue;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      post({ type: 'tdoc:navigate', href: embeds[i].openHref, blank: !!(ev.metaKey || ev.ctrlKey) });
      return;
    }
  }
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);

  // State lives here only: never an attribute the page's CSS could select.
  function setState(embed, state) { embed.state = state; }

  function frame(embed) {
    var root = embed.root;
    while (root.firstChild) root.removeChild(root.firstChild);
    var st = document.createElement('style');
    st.textContent = hostCss(embed) + CSS;
    root.appendChild(st);
    var card = h('div', 'se');
    card.setAttribute('role', 'group');
    root.appendChild(card);
    return card;
  }

  function topRow(card, embed, title, tab, href) {
    var top = h('div', 'se-top');
    var t = href ? link('se-title', href) : h('div', 'se-title');
    t.appendChild(icon('grid'));
    t.appendChild(h('b', '', title));
    if (tab) t.appendChild(h('span', 'se-tab', '· ' + tab));
    top.appendChild(t);
    card.appendChild(top);
    return top;
  }

  function renderLoading(embed) {
    var card = frame(embed);
    card.setAttribute('aria-busy', 'true');
    topRow(card, embed, 'Loading sheet…', '', null);
    var sk = h('div', 'se-skel');
    sk.appendChild(h('i')); sk.appendChild(h('i')); sk.appendChild(h('i'));
    card.appendChild(sk);
  }

  function renderMessage(embed, iconName, strong, text, href) {
    var card = frame(embed);
    card.setAttribute('aria-label', 'Embedded sheet');
    // No title: a refusal says nothing about the sheet it refused.
    topRow(card, embed, 'Sheet', '', null);
    var msg = h('div', 'se-msg');
    msg.appendChild(icon(iconName));
    var p = h('p');
    if (strong) p.appendChild(h('strong', '', strong));
    if (text) p.appendChild(document.createTextNode((strong ? ' ' : '') + text));
    msg.appendChild(p);
    if (href) {
      var open = link('se-act', href);
      open.appendChild(h('span', 'se-label', 'Open'));
      open.appendChild(icon('external'));
      open.setAttribute('aria-label', 'Open the sheet');
      msg.appendChild(open);
    }
    card.appendChild(msg);
  }

  function tagPill(tag, palette) {
    var color = Q.TAG_COLORS[Q.tagColor(tag, palette)] || Q.TAG_COLORS.gray;
    var s = h('span', 'se-tag', tag);
    s.style.background = color[0];
    s.style.color = color[1];
    return s;
  }

  function renderData(embed, d) {
    var href = safeSheetHref(d.href, embed.slug);
    embed.openHref = href;
    var card = frame(embed);
    var title = String(d.title || embed.slug);
    embed.title = title;
    embed.rows = Array.isArray(d.rows) ? Math.min(d.rows.length, embed.rowsShown) : 0;
    card.setAttribute('aria-label', 'Sheet: ' + title);
    var top = topRow(card, embed, title, d.tabs > 1 ? d.tab : '', href);
    var count = Math.max(0, Math.floor(Number(d.comments) || 0));
    if (count > 0) {
      var c = link('se-act se-comments', href);
      c.appendChild(icon('comment'));
      c.appendChild(h('span', 'se-label', fmt(count) + (count === 1 ? ' comment' : ' comments')));
      c.appendChild(h('span', 'se-short', fmt(count)));
      c.setAttribute('aria-label', fmt(count) + (count === 1 ? ' open comment' : ' open comments') + ' on the sheet');
      top.appendChild(c);
    }
    var open = link('se-act', href);
    open.appendChild(h('span', 'se-label', 'Open'));
    open.appendChild(icon('external'));
    open.setAttribute('aria-label', 'Open ' + title);
    top.appendChild(open);

    var cols = Array.isArray(d.columns) ? d.columns.slice(0, R.EMBED_MAX_COLUMNS) : [];
    var palettes = cols.map(function (col) { return col.type === 'tags' ? Q.parsePalette(col.palette || '') : null; });
    var scroll = h('div', 'se-scroll');
    var table = h('table');
    var thead = h('thead'), hr = h('tr');
    cols.forEach(function (col) {
      var th = h('th', col.type === 'number' ? 'se-num' : '', col.name);
      th.setAttribute('scope', 'col');
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = h('tbody');
    (Array.isArray(d.rows) ? d.rows.slice(0, embed.rowsShown) : []).forEach(function (row) {
      var tr = h('tr');
      cols.forEach(function (col, i) {
        var v = row && Array.isArray(row.cells) ? row.cells[i] : '';
        var td = h('td');
        if (col.type === 'tags') {
          (Array.isArray(v) ? v : Q.splitTags(v)).slice(0, 50).forEach(function (tag) { td.appendChild(tagPill(String(tag), palettes[i])); });
        } else if (col.type === 'checkbox') {
          td.textContent = Q.parseCheckbox(v) ? Q.CHECK_MARK : '';
        } else if (col.type === 'number') {
          td.className = 'se-num';
          td.textContent = String(v == null ? '' : v);
        } else if (col.type === 'url' && externalHref(v)) {
          var a = link('', externalHref(v), true);
          a.textContent = String(v);
          a.rel = 'noopener';
          td.appendChild(a);
        } else {
          var text = String(v == null ? '' : v);
          td.textContent = text;
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    card.appendChild(scroll);

    var foot = h('div', 'se-foot');
    var shown = embed.rows, matching = Math.max(0, Number(d.matching_rows) || 0), total = Math.max(0, Number(d.total_rows) || 0);
    var line = !matching ? (d.filtered ? 'No rows match this view' : 'No rows yet')
      : shown < matching ? 'First ' + fmt(shown) + ' of ' + fmt(matching) + ' rows' : fmt(matching) + (matching === 1 ? ' row' : ' rows');
    if (d.filtered && matching) line += ' (filtered from ' + fmt(total) + ')';
    foot.appendChild(h('span', '', line));
    if (d.sorted) foot.appendChild(h('span', 'se-extra', 'Sorted'));
    if (d.hidden_columns > 0) foot.appendChild(h('span', 'se-extra', fmt(d.hidden_columns) + (d.hidden_columns === 1 ? ' more column' : ' more columns')));
    var all = link('', href);
    all.textContent = 'View the whole sheet';
    foot.appendChild(all);
    card.appendChild(foot);
  }

  function answer(embed, msg) {
    clearTimeout(embed.timer);
    if (!msg || typeof msg !== 'object') return fallback(embed);
    if (msg.ok === true && msg.data && typeof msg.data === 'object') {
      setState(embed, 'live');
      renderData(embed, msg.data);
      return;
    }
    var href = '/d/' + embed.slug;
    var err = String(msg.error || '');
    // Off for this reader, or an old version of the page: nothing here is
    // about the sheet, so the figure goes back to its link.
    if (err === 'disabled' || err === 'old_version') return fallback(embed);
    setState(embed, err === 'no_access' ? 'no-access' : 'error');
    if (err === 'no_access') {
      renderMessage(embed, 'lock', 'You don’t have access to this sheet.', msg.signedIn === false ? 'Sign in, or ask its owner to share it.' : 'Ask its owner to share it with you.', href);
    } else if (err === 'not_a_sheet') {
      renderMessage(embed, 'grid', 'This doc is not a sheet.', 'Only a sheet doc can be embedded here.', href);
    } else if (err === 'no_tab') {
      renderMessage(embed, 'grid', 'This tab is not in the sheet.', embed.tab ? 'No tab named “' + embed.tab + '”.' : '', href);
    } else {
      renderMessage(embed, 'grid', 'This sheet could not be loaded.', err === 'rate_limited' ? 'Try again in a minute.' : '', href);
    }
  }

  // Back to the figure as written: its link. Only for an answer that says
  // nothing about the sheet (embeds are off for this reader, no channel).
  function fallback(embed) {
    clearTimeout(embed.timer);
    setState(embed, 'fallback');
    if (embed.host.parentNode) embed.host.parentNode.removeChild(embed.host);
  }

  function request(embed) {
    var channel;
    try { channel = new MessageChannel(); } catch (e) { return fallback(embed); }
    channel.port1.onmessage = function (ev) { channel.port1.close(); answer(embed, ev.data); };
    embed.timer = setTimeout(function () {
      try { channel.port1.close(); } catch (e) {}
      if (embed.state === 'loading') answer(embed, { ok: false, error: 'timeout' });
    }, TIMEOUT_MS);
    post({
      type: 'tdoc:sheetEmbed',
      key: KEY,
      id: embed.id,
      src: embed.src,
      tab: embed.tab,
      view: embed.view,
      rows: embed.rowsWanted,
      columns: embed.columns,
    }, [channel.port2]);
  }

  function slugOf(src) {
    // The shell resolves the reference (a full link included); this is only
    // what the frame links to when the shell has nothing to say.
    var m = /(?:^|\/d\/)([a-z0-9][a-z0-9-]{0,63})(?=$|[/?#])/.exec(String(src || '').replace(/^https?:\/\/[^/]+/i, ''));
    return m ? m[1] : '';
  }

  function mount() {
    var figures = Array.prototype.slice.call(document.querySelectorAll(R.EMBED_SELECTOR))
      .filter(function (f) { return !f.closest('[data-tdoc-provider]'); })
      .slice(0, R.EMBED_MAX_PER_PAGE);
    figures.forEach(function (fig, i) {
      var attr = function (n) { var v = fig.getAttribute(n); return v == null ? '' : String(v).slice(0, 4000); };
      var slug = slugOf(attr('data-src'));
      if (!slug) return;
      var host = document.createElement('div');
      host.setAttribute('data-tdoc-provider', '');
      host.setAttribute('data-tdoc-embed-host', '');
      host.setAttribute('contenteditable', 'false');
      // The same in every state: one focus stop, one name, one action.
      host.setAttribute('tabindex', '0');
      host.setAttribute('role', 'link');
      host.setAttribute('aria-label', 'Embedded sheet');
      fig.insertBefore(host, fig.firstChild);
      var embed = {
        id: 'e' + i, fig: fig, host: host, root: host.attachShadow({ mode: 'closed' }),
        slug: slug, src: attr('data-src'), tab: attr('data-tab'), view: attr('data-view'),
        rowsWanted: attr('data-rows'), columns: attr('data-columns'),
        openHref: '/d/' + slug, state: 'loading', rows: 0, rowsShown: rowsOf(attr('data-rows')), title: '', timer: null,
      };
      embeds.push(embed);
      setState(embed, 'loading');
      renderLoading(embed);
      request(embed);
    });
  }
  mount();
})();
