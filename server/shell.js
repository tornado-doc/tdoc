// tdoc shared shell builder — pure functions that render the cross-origin
// shell document + its client script, with all environment-specific inputs
// (file contents, identity, config) injected by the caller. The local server
// (server/server.js) requires this; the worker inlines it as code (Cloudflare
// Workers ban eval/new Function, so it exposes itself on globalThis instead of
// being eval'd from a string). Keep it dependency-free (no fs/path/window).
(function () {
  'use strict';
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]); }); }

  // The CHROME-only CSS for the shell: the :root design tokens + the chrome CSS
  // block (bar/footer/composer/cards/pins/drawer/menus) sliced from overlay.js
  // between the TDOC_CHROME_CSS_START/END markers. Excludes reader/content-column
  // rules. Single source (overlay.js) so the shell chrome stays 1:1, no drift.
  function sliceChromeCss(src) {
    if (typeof src !== 'string' || !src) return '';
    var root = '';
    var ri = src.indexOf(':root {');
    if (ri !== -1) { var re = src.indexOf('}', ri); if (re !== -1) root = src.slice(ri, re + 1); }
    var chrome = '';
    var s = src.indexOf('TDOC_CHROME_CSS_START');
    var e = src.indexOf('TDOC_CHROME_CSS_END');
    if (s !== -1 && e !== -1 && e > s) {
      var from = src.indexOf('*/', s);
      var to = src.lastIndexOf('/*', e);
      if (from !== -1 && to !== -1 && to > from) chrome = src.slice(from + 2, to);
    }
    return root + '\n' + chrome;
  }

  function shellScript() {
    return `(function(){
    'use strict';
    var cfg = window.__TDOC_SHELL__ || {};
    var frame = document.querySelector('.tdoc-doc-frame');
    var BAR = 48; // top bar height; frame viewport coords + BAR = shell coords
    var pending = null; // last selection anchor awaiting a comment
    var pinData = []; // [{id, docY, login}]
    var commentsById = {}; // id -> comment (for the floating card)
    var commentList = []; // ordered comments (for Copy: doc + comments)
    var gutterRight = 0;  // article right edge (from the probe) — where pins live
    var openCardId = null; // comment id of the currently open floating card
    var pinEls = {};       // cluster-key -> pin element (cached so scroll doesn't re-query the DOM)
    var pinClusters = [];  // placed clusters [{y, items:[{y,c}], key}] from layoutPins
    var docHeight = 0;     // author doc scrollHeight (from the probe) — for cluster overflow-fold
    function pinX(){ return Math.min((gutterRight || (window.innerWidth - 44)) + 14, window.innerWidth - 34); }
    var copyReq = null; // { includeComments } awaiting tdoc:docMarkdown
    var frameScrollY = 0;
    var reanchoringId = null; // comment id awaiting a new frame selection to rebind its anchor
    var pendingDeepLink = null; // ?comment=<id> awaiting its pin so we can open+scroll to it
    var deepLinkTries = 0;      // guard against a scroll loop when the pin never comes into view
    function copyText(t){
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(t).then(function(){return true;}).catch(function(){return false;});
      try { var ta=document.createElement('textarea'); ta.value=t; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); var ok=document.execCommand('copy'); ta.remove(); return Promise.resolve(ok); } catch(e){ return Promise.resolve(false); }
    }
    function reactionsToMd(r){ if(!r) return ''; var out=Object.keys(r).filter(function(k){return r[k]&&r[k].length;}).map(function(k){return k+' '+r[k].length;}); return out.length?('\\n'+out.join('  ')+'\\n'):''; }
    function commentToMd(c){
      var who=c.author?('**@'+c.author.login+'**'):'*anonymous*'; var when=''; try{when=new Date(c.created).toLocaleString();}catch(e){}
      var anchorLine=''; if(c.anchor){ if(c.anchor.kind==='element'||c.anchor.selector) anchorLine='> _on '+(c.anchor.label||c.anchor.selector)+'_\\n'; else if(c.anchor.text) anchorLine='> "'+c.anchor.text.replace(/\\n/g,' ').slice(0,200)+'"\\n'; }
      var md=who+' — _'+when+'_\\n'+anchorLine+'\\n'+(c.text||'')+'\\n'+reactionsToMd(c.reactions);
      if(Array.isArray(c.replies)) c.replies.forEach(function(r){ var rwho=r.author?('**@'+r.author.login+'**'):'*anonymous*'; md+='  ↳ '+rwho+'\\n    '+(r.text||'')+'\\n'; });
      return md;
    }
    function frameWin(){ return frame && frame.contentWindow; }
    function sendFrame(msg){ var w = frameWin(); if (w) w.postMessage(Object.assign({source:'tdoc-shell'}, msg), '*'); }

    // --- narrow / drawer mode ---
    function layout(){ document.body.classList.toggle('tdoc-narrow', window.innerWidth < 700); positionPins(); }
    window.addEventListener('resize', layout);

    // --- comments: fetch → resolve in frame → draw pins ---
    function loadComments(){
      return fetch('/api/comments?slug=' + encodeURIComponent(cfg.slug) + '&version=' + encodeURIComponent(cfg.version))
        .then(function(r){ return r.ok ? r.json() : []; })
        .then(function(list){ list = Array.isArray(list) ? list : []; commentList = list; commentsById = {}; list.forEach(function(c){ commentsById[c.id] = c; }); sendFrame({ type:'tdoc:anchors', comments: list }); document.body.dataset.tdocReady = '1'; captureDeepLink(); return list; })
        .catch(function(){ return []; });
    }
    // On a 401 (auth required — production/worker), run the shared sign-in modal
    // (device flow / web redirect) then retry the write. Local mode carries an
    // E2E identity so this never fires there; it's here for worker parity.
    function ensureAuthThen(status, retry){ if (status === 401 && window.__tdocSignIn){ window.__tdocSignIn().then(function(){ retry(); }, function(){}); return true; } return false; }
    function postReply(parentId, text, btn){
      text = (text || '').trim(); if (!text) return; if (btn) btn.disabled = true;
      fetch('/api/comments', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ slug: cfg.slug, version: cfg.version, text: text, parent_id: parentId }) })
        .then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function(){ return loadComments(); })
        .then(function(){ openCard(parentId); })   // reopen with the new reply shown
        .catch(function(status){ if (ensureAuthThen(status, function(){ postReply(parentId, text, btn); })) return; if (btn){ btn.disabled = false; btn.textContent = 'Retry'; } });
    }
    function postReaction(targetId, emoji){
      fetch('/api/reactions', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ slug: cfg.slug, comment_id: targetId, emoji: emoji, version: cfg.version }) })
        .then(function(r){ if (r.ok) return loadComments().then(function(){ openCard(targetId); }); ensureAuthThen(r.status, function(){ postReaction(targetId, emoji); }); })
        .catch(function(){});
    }
    var emojiPicker = null;
    function closeEmojiPicker(){ if (emojiPicker){ emojiPicker.remove(); emojiPicker = null; } }
    function openEmojiPicker(anchorBtn, targetId){
      closeEmojiPicker();
      emojiPicker = document.createElement('div'); emojiPicker.className = 'tdoc-emoji-picker'; emojiPicker.style.position = 'fixed';
      emojiPicker.innerHTML = window.TDOC_CHROME.buildEmojiPicker();
      document.body.appendChild(emojiPicker);
      var r = anchorBtn.getBoundingClientRect();
      emojiPicker.style.visibility = 'hidden'; emojiPicker.style.top = '0'; emojiPicker.style.left = '0';
      var pw = emojiPicker.offsetWidth, ph = emojiPicker.offsetHeight;
      var left = r.left, top = r.bottom + 6;
      if (left + pw > window.innerWidth - 8) left = Math.max(8, r.right - pw);
      if (top + ph > window.innerHeight - 8) top = r.top - ph - 6;
      emojiPicker.style.top = top + 'px'; emojiPicker.style.left = left + 'px'; emojiPicker.style.visibility = '';
      emojiPicker.querySelectorAll('button').forEach(function(b){ b.addEventListener('click', function(e){ e.stopPropagation(); var emoji = b.getAttribute('data-emoji'); closeEmojiPicker(); postReaction(targetId, emoji); }); });
    }
    // Footer reveals only when the doc is scrolled to its end (or the doc is short
    // enough to fit). d = {scrollY, innerH, height} from the frame probe.
    function updateFooter(d){
      var f = document.querySelector('.tdoc-footer'); if (!f) return;
      var atBottom = !d || !d.innerH || (d.scrollY + d.innerH) >= (d.height - 4);
      f.classList.toggle('tdoc-footer-show', !!atBottom);
    }
    // Floating comment card (real .tdoc-margin-comment markup + CSS). The card
    // stays glued to its pin: positionCard() re-runs whenever pins move (scroll/
    // resize), and the card closes if its pin scrolls out of view. Clicking a pin
    // opens the card WITHOUT scrolling the doc.
    function closeCard(){ var el = document.querySelector('.tdoc-margin-comment'); if (el) el.remove(); openCardId = null; }
    function pinTopFor(id){ for (var i=0;i<pinClusters.length;i++){ var it=pinClusters[i].items; for (var j=0;j<it.length;j++){ if (it[j].c.id===id) return BAR + (pinClusters[i].y - frameScrollY); } } return null; }
    function positionCard(){
      var card = document.querySelector('.tdoc-margin-comment'); if (!card || openCardId == null) return;
      var top = pinTopFor(openCardId);
      if (top == null || top < BAR - 40 || top > window.innerHeight - 8){ card.remove(); openCardId = null; return; } // pin off-screen → close
      card.style.top = Math.max(BAR + 4, Math.min(top, window.innerHeight - card.offsetHeight - 8)) + 'px';
      card.style.left = Math.max(8, Math.min(pinX() + 34, window.innerWidth - (card.offsetWidth || 280) - 8)) + 'px';
    }
    function openCard(id){
      closeCard();
      var c = commentsById[id]; if (!c || !window.TDOC_CHROME) return;
      var card = document.createElement('div');
      card.className = 'tdoc-margin-comment tdoc-floating-open active' + (c.status === 'applied' ? ' tdoc-resolved' : '') + (isUnanchored(id) ? ' tdoc-unanchored' : '');
      card.setAttribute('data-comment-id', id);
      card.innerHTML = window.TDOC_CHROME.buildCard(c, (cfg.identity && cfg.identity.login) || 'anon');
      card.addEventListener('click', function(e){ e.stopPropagation(); });
      document.body.appendChild(card);
      openCardId = id;
      // reactions: click a chip to toggle, click + to pick
      card.querySelectorAll('.tdoc-react-chip').forEach(function(chip){ chip.addEventListener('click', function(e){ e.stopPropagation(); postReaction(chip.getAttribute('data-target-id') || id, chip.getAttribute('data-emoji')); }); });
      card.querySelectorAll('.tdoc-react-add').forEach(function(add){ add.addEventListener('click', function(e){ e.stopPropagation(); openEmojiPicker(add, add.getAttribute('data-target-id') || id); }); });
      // replies expand/collapse
      var rtog = card.querySelector('.tdoc-replies-toggle'), rlist = card.querySelector('.tdoc-replies');
      if (rtog && rlist) rtog.addEventListener('click', function(e){ e.stopPropagation(); var o = rlist.classList.toggle('open'); rtog.classList.toggle('open', o); positionCard(); });
      // reply: show form + submit (POST with parent_id)
      var rbtn = card.querySelector('.tdoc-reply-toggle'), rform = card.querySelector('.tdoc-reply-form');
      if (rbtn && rform) rbtn.addEventListener('click', function(e){ e.stopPropagation(); var o = rform.classList.toggle('open'); if (o){ var t = rform.querySelector('textarea'); if (t) t.focus(); } positionCard(); });
      if (rform){ var sub = rform.querySelector('.tdoc-reply-submit'), rta = rform.querySelector('textarea');
        if (sub && rta){ sub.addEventListener('click', function(e){ e.stopPropagation(); postReply(id, rta.value, sub); });
          rta.addEventListener('keydown', function(e){ if ((e.metaKey||e.ctrlKey) && e.key==='Enter') postReply(id, rta.value, sub); }); } }
      // delete (1:1 with overlay: deletes on click, no native confirm)
      var del = card.querySelector('.del');
      if (del) del.addEventListener('click', function(e){ e.stopPropagation();
        fetch('/api/comments?slug=' + encodeURIComponent(cfg.slug) + '&id=' + encodeURIComponent(id) + '&version=' + encodeURIComponent(cfg.version), { method:'DELETE' })
          .then(function(r){ if (r.ok){ closeCard(); loadComments(); } else { r.json().catch(function(){return {};}).then(function(x){ alert('Could not delete: ' + (x.error || x.message || ('HTTP ' + r.status))); }); } });
      });
      // re-anchor: enter re-anchor mode; the next frame selection rebinds this comment
      var reBtn = card.querySelector('.tdoc-reanchor-btn');
      if (reBtn) reBtn.addEventListener('click', function(e){ e.stopPropagation(); startReanchor(id); });
      positionCard();
    }
    // A comment is unanchored when its anchor didn't resolve in this doc version —
    // i.e. no pin was reported for it. (pinData holds only resolved anchors.)
    function isUnanchored(id){ for (var i=0;i<pinData.length;i++){ if (pinData[i].id===id) return false; } return true; }
    // ?comment=<id> deep-link (1:1 with overlay). Open the target comment's card
    // after its pin resolves, scrolling the frame so the anchor is in view; for a
    // reply target, open the parent card and expand the thread. Only fires once
    // per load (the URL is captured after comments arrive).
    function captureDeepLink(){
      var want = null; try { want = new URLSearchParams(location.search).get('comment'); } catch (e) {}
      if (want && commentsById && findCommentRoot(want)) { pendingDeepLink = want; deepLinkTries = 0; }
    }
    function findCommentRoot(want){
      if (!want) return null;
      for (var i=0;i<commentList.length;i++){
        var c = commentList[i]; if (c.id === want) return c.id;
        var reps = c.replies || []; for (var j=0;j<reps.length;j++){ if (reps[j].id === want) return c.id; }
      }
      return null;
    }
    function clusterForId(id){ for (var i=0;i<pinClusters.length;i++){ var it=pinClusters[i].items; for (var j=0;j<it.length;j++){ if (it[j].c.id===id) return pinClusters[i]; } } return null; }
    function tryDeepLink(){
      if (!pendingDeepLink) return;
      var root = findCommentRoot(pendingDeepLink);
      if (!root) { pendingDeepLink = null; return; }
      var cl = clusterForId(root);
      if (!cl) { if (++deepLinkTries > 40) pendingDeepLink = null; return; } // pin not resolved yet
      var top = BAR + (cl.y - frameScrollY);
      if ((top < BAR + 20 || top > window.innerHeight - 60) && deepLinkTries < 40) {
        deepLinkTries++;
        sendFrame({ type:'tdoc:scrollTo', docY: Math.max(0, Math.round(cl.y - window.innerHeight / 3)) });
        return; // reopen check after the frame reports the new scroll position
      }
      var target = pendingDeepLink; pendingDeepLink = null;
      openCard(root);
      if (target !== root) {   // a reply deep-link — expand the thread
        var card = document.querySelector('.tdoc-margin-comment');
        if (card){ var rl = card.querySelector('.tdoc-replies'), rt = card.querySelector('.tdoc-replies-toggle');
          if (rl){ rl.classList.add('open'); if (rt) rt.classList.add('open'); positionCard(); } }
      }
    }
    // Re-anchor flow (1:1 with overlay startReanchor/exitReanchor): the shell holds
    // reanchoringId; the next tdoc:selection from the frame PATCHes the anchor
    // instead of opening the composer. A banner near the bar exposes cancel/remove.
    function startReanchor(id){ if (reanchoringId === id){ exitReanchor(); return; } reanchoringId = id; document.body.classList.add('tdoc-reanchoring'); }
    function exitReanchor(){ reanchoringId = null; document.body.classList.remove('tdoc-reanchoring'); }
    function reanchorTo(d){
      var id = reanchoringId; exitReanchor(); closeCard(); if (!id) return;
      fetch('/api/comments', { method:'PATCH', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ slug: cfg.slug, id: id, version: cfg.version,
          anchor: { kind:'text', text: d.text, context_before: d.context_before, context_after: d.context_after } })
      }).then(function(r){ return r.ok ? loadComments() : null; });
    }
    function removeAnchor(){
      var id = reanchoringId; exitReanchor(); closeCard(); if (!id) return;
      fetch('/api/comments', { method:'PATCH', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ slug: cfg.slug, id: id, version: cfg.version, anchor: { kind:'none' } })
      }).then(function(r){ return r.ok ? loadComments() : null; });
    }
    (function(){
      var c = document.getElementById('tdoc-reanchor-cancel'); if (c) c.addEventListener('click', function(e){ e.stopPropagation(); exitReanchor(); });
      var r = document.getElementById('tdoc-reanchor-remove'); if (r) r.addEventListener('click', function(e){ e.stopPropagation(); removeAnchor(); });
    })();
    // Full reconcile — only on tdoc:pins (comment set changed). Clusters same-line
    // pins (1:1 with overlay layoutPins), reconciles pin elements against the
    // cached pinEls map (keyed by cluster membership), then positions them. O(P).
    function buildPin(cl, key){
      var el = document.createElement('div'); el.className='tdoc-pin'; el.setAttribute('data-key', key);
      el.setAttribute('role','button'); el.setAttribute('tabindex','0');
      if (cl.items.length === 1){
        var p = cl.items[0].c; el.setAttribute('data-id', p.id);
        el.innerHTML = window.TDOC_CHROME.avatarHtml({ login: p.login, avatar_url: p.avatar_url, kind: p.kind }, 'tdoc-pin-anon');
        el.addEventListener('click', (function(id){ return function(ev){ ev.stopPropagation(); openCard(id); }; })(p.id));
      } else {
        el.classList.add('tdoc-pin-cluster'); el.textContent = String(cl.items.length);
        el.setAttribute('aria-label', cl.items.length + ' comments here');
        el.addEventListener('click', function(ev){ ev.stopPropagation(); openClusterPopover(el._cluster, el); });
      }
      applyPinState(el, cl);
      return el;
    }
    function applyPinState(el, cl){
      el._cluster = cl;
      if (cl.items.length === 1) el.classList.toggle('tdoc-pin-resolved', !!cl.items[0].c.resolved);
      else el.classList.toggle('tdoc-cluster-allresolved', cl.items.every(function(r){ return r.c.resolved; }));
    }
    function positionPins(){
      var rows = pinData.map(function(p){ return { y: p.docY, c: p }; });
      pinClusters = window.TDOC_CHROME.layoutPins(rows, { articleTop: 0, articleHeight: docHeight || 1e7 },
        { PIN_SIZE: 28, PIN_MIN_GAP: 32, SAME_LINE_GAP: 12 });
      var seen = {};
      pinClusters.forEach(function(cl){
        var key = cl.items.map(function(r){ return r.c.id; }).sort().join('|');
        cl.key = key; seen[key] = 1;
        var el = pinEls[key];
        if (!el){ el = buildPin(cl, key); document.body.appendChild(el); pinEls[key] = el; }
        else applyPinState(el, cl);   // membership same → reuse; refresh state + cluster ref
      });
      Object.keys(pinEls).forEach(function(k){ if (!seen[k]){ pinEls[k].remove(); delete pinEls[k]; } });
      repositionPins();
      tryDeepLink();
    }
    // Cheap — on every scroll frame. No DOM query/rebuild: just move cached pins.
    function repositionPins(){
      var left = pinX() + 'px';
      for (var i = 0; i < pinClusters.length; i++){
        var cl = pinClusters[i], el = pinEls[cl.key]; if (!el) continue;
        var top = BAR + (cl.y - frameScrollY);
        el.hidden = !(top >= BAR - 20 && top <= window.innerHeight - 8);
        el.style.top = Math.max(BAR + 4, top) + 'px';
        el.style.left = left;
      }
      positionCard();
    }
    // Cluster popover — a compact list of the comments under a count badge. Click
    // a row to open that comment's card. (1:1 with overlay openClusterPopover.)
    var clusterPop = null;
    function ensureClusterPop(){ if (!clusterPop){ clusterPop = document.createElement('div'); clusterPop.className = 'tdoc-cluster-pop'; clusterPop.addEventListener('click', function(e){ e.stopPropagation(); }); document.body.appendChild(clusterPop); } return clusterPop; }
    function closeClusterPopover(){ if (clusterPop){ clusterPop.classList.remove('open'); clusterPop._key = null; } }
    function openClusterPopover(cluster, pinEl){
      if (!cluster) return;
      var pop = ensureClusterPop(), esc = window.TDOC_CHROME.escapeHtml, key = pinEl.getAttribute('data-key');
      if (pop.classList.contains('open') && pop._key === key){ closeClusterPopover(); return; }
      pop._key = key;
      pop.innerHTML = cluster.items.map(function(r){ var c = r.c;
        var done = c.resolved ? '<span class="tdoc-cluster-done">✓</span>' : '';
        var cur = c.id === openCardId ? ' tdoc-cluster-current' : '';
        var text = (commentsById[c.id] && commentsById[c.id].text) || '';
        return '<div class="tdoc-cluster-row' + cur + '" role="button" tabindex="0" data-id="' + esc(c.id) + '">' +
          window.TDOC_CHROME.avatarHtml({ login: c.login, avatar_url: c.avatar_url, kind: c.kind }, 'tdoc-cluster-anon') +
          '<span class="tdoc-cluster-snip">' + esc(text.slice(0, 60)) + '</span>' + done + '</div>';
      }).join('');
      pop.querySelectorAll('.tdoc-cluster-row').forEach(function(rowEl){
        rowEl.addEventListener('click', function(e){ e.stopPropagation(); closeClusterPopover(); openCard(rowEl.getAttribute('data-id')); });
      });
      pop.classList.add('open'); // measurable
      var pw = pop.offsetWidth || 260, ph = pop.offsetHeight || 200, pr = pinEl.getBoundingClientRect();
      var left = pr.left - pw - 8; if (left < 8) left = pr.right + 8;
      left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
      var top = Math.max(BAR + 4, Math.min(pr.top, window.innerHeight - ph - 8));
      pop.style.left = left + 'px'; pop.style.top = top + 'px';
    }

    // Publish flow — self-contained chrome modal (real .tdoc-modal CSS), 1:1 with
    // overlay.js showPublishModal. POSTs /api/publish; no doc-DOM access.
    function closeAuxModal(){ var m = document.getElementById('tdoc-aux-modal'); if (m) m.remove(); }
    function showPublishModal(){
      closeAuxModal();
      var esc = window.TDOC_CHROME.escapeHtml, bg = document.createElement('div');
      bg.className = 'tdoc-modal-bg'; bg.id = 'tdoc-aux-modal';
      bg.innerHTML = '<div class="tdoc-modal" data-state="idle"><h3>Publish this doc</h3>' +
        '<p>We\\'ll deploy this so anyone with the link can read it. GitHub sign-in is required for commenting.</p>' +
        '<div class="step"><span class="n">·</span><span>Slug: <code id="tdoc-pub-slug">' + esc(cfg.slug) + '</code></span></div>' +
        '<div class="status" id="tdoc-pub-status" style="margin-top:10px;display:none;"></div>' +
        '<div id="tdoc-pub-result" style="margin-top:10px;display:none;"><div class="code" style="font-size:14px;letter-spacing:0;text-align:left;" id="tdoc-pub-url"></div>' +
        '<div class="actions" style="justify-content:flex-start;gap:8px;"><button class="primary" id="tdoc-pub-copy">Copy link</button><button id="tdoc-pub-open">View live →</button></div></div>' +
        '<div class="actions"><button id="tdoc-pub-cancel">Cancel</button><button class="primary" id="tdoc-pub-go">Publish</button></div></div>';
      document.body.appendChild(bg);
      bg.addEventListener('click', function(e){ if (e.target === bg) closeAuxModal(); });
      document.getElementById('tdoc-pub-cancel').onclick = closeAuxModal;
      document.getElementById('tdoc-pub-go').onclick = function(){
        var status = document.getElementById('tdoc-pub-status'), go = document.getElementById('tdoc-pub-go');
        status.style.display = 'block'; status.textContent = 'Publishing — this can take 20–60s on first run…'; go.disabled = true;
        fetch('/api/publish', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ slug: cfg.slug }) })
          .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
          .then(function(x){
            if (!x.ok || x.d.error){ status.textContent = 'Failed: ' + (x.d.error || x.d.message || 'unknown'); go.disabled = false; return; }
            var url = x.d.url; status.style.display = 'none';
            var res = document.getElementById('tdoc-pub-result'); res.style.display = 'block';
            document.getElementById('tdoc-pub-url').textContent = url;
            document.getElementById('tdoc-pub-copy').onclick = function(){ copyText(url); };
            document.getElementById('tdoc-pub-open').onclick = function(){ window.open(url, '_blank'); };
            go.style.display = 'none'; document.getElementById('tdoc-pub-cancel').textContent = 'Done';
          })
          .catch(function(e){ status.textContent = 'Failed: ' + e.message; go.disabled = false; });
      };
    }
    function close(){ var el = document.querySelector('.tdoc-popup'); if (el) el.remove(); pending = null; }
    function open(d){
      close();
      pending = { kind: d.kind || 'text', selector: d.selector, label: d.label, text: d.text, context_before: d.context_before, context_after: d.context_after };
      var pop = document.createElement('div');
      pop.className = 'tdoc-popup';
      // Real composer markup from the shared chrome module (1:1 with the overlay).
      pop.innerHTML = window.TDOC_CHROME.buildComposer({ anchor: { kind: d.kind || 'text', text: d.text, label: d.label }, needsSignIn: false });
      document.body.appendChild(pop);
      // Pin the composer to the caret line (frame coords + bar height). Shell body
      // is fixed (never scrolls), so .tdoc-popup is position:fixed.
      var r = d.rect || { bottom: 0, left: 8 };
      var top = BAR + (r.bottom || 0) + 8;
      var left = Math.max(8, Math.min((r.left || 8), window.innerWidth - (pop.offsetWidth || 320) - 8));
      pop.style.top = top + 'px'; pop.style.left = left + 'px';
      var ta = pop.querySelector('textarea'), submit = pop.querySelector('.submit'), x = pop.querySelector('.x');
      if (x) x.addEventListener('click', close);
      if (ta) ta.focus();
      if (submit) submit.addEventListener('click', function(){ postComment(ta ? ta.value : '', submit); });
      if (ta) ta.addEventListener('keydown', function(e){ if ((e.metaKey||e.ctrlKey) && e.key==='Enter') postComment(ta.value, submit); });
    }
    function postComment(text, btn){
      text = (text||'').trim();
      if (!text || !pending) { close(); return; }
      btn.disabled = true;
      var anchor = pending.kind === 'element'
        ? { kind:'element', selector: pending.selector, label: pending.label }
        : { kind:'text', text: pending.text, context_before: pending.context_before, context_after: pending.context_after };
      fetch('/api/comments', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ slug: cfg.slug, version: cfg.version, text: text, anchor: anchor })
      }).then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function(){ close(); loadComments(); })   // re-resolve so the new pin appears
        .catch(function(status){ if (ensureAuthThen(status, function(){ postComment(text, btn); })) return; btn.disabled = false; btn.textContent = 'Retry'; });
    }
    window.addEventListener('message', function(e){
      if (!frameWin() || e.source !== frameWin()) return;      // validate by window identity (opaque origin)
      var d = e.data; if (!d || d.source !== 'tdoc-frame') return;
      if (d.type === 'tdoc:selection') { if (reanchoringId) reanchorTo(d); else open(d); }
      else if (d.type === 'tdoc:cleared') { if (!document.querySelector('.tdoc-popup textarea:focus')) close(); closeCard(); closeMenus(); closeEmojiPicker(); closeClusterPopover(); }
      else if (d.type === 'tdoc:ready') {
        layout(); loadComments();
        // Honor a doc that declares data-tdoc-default-theme="dark" when the
        // visitor has no saved preference (1:1 with overlay readStoredTheme).
        // The hint applies but does NOT persist — the bar toggle still wins.
        var storedTheme = null; try { storedTheme = localStorage.getItem('tdoc-theme'); } catch (e) {}
        if (!storedTheme && d.defaultTheme === 'dark' && document.documentElement.getAttribute('data-tdoc-theme') !== 'dark') {
          document.documentElement.setAttribute('data-tdoc-theme', 'dark');
          var tb = document.getElementById('tdoc-theme-btn'); if (tb) tb.setAttribute('aria-pressed', 'true');
        }
        sendFrame({ type:'tdoc:theme', theme: document.documentElement.getAttribute('data-tdoc-theme') === 'dark' ? 'dark' : 'light' });
      }
      else if (d.type === 'tdoc:pins') { pinData = d.pins || []; frameScrollY = d.scrollY || 0; if (d.articleRight) gutterRight = d.articleRight; if (d.docHeight) docHeight = d.docHeight; positionPins(); }
      else if (d.type === 'tdoc:scroll') { frameScrollY = d.scrollY || 0; repositionPins(); updateFooter(d); tryDeepLink(); }
      else if (d.type === 'tdoc:docMarkdown' && copyReq) {
        var md = d.markdown || '';
        if (copyReq.includeComments && commentList.length) md += '\\n\\n---\\n\\n## Comments\\n\\n' + commentList.map(commentToMd).join('\\n---\\n\\n');
        var btn = document.getElementById('tdoc-copy-md-btn'); copyReq = null;
        copyText(md).then(function(ok){ if (btn){ var s=btn.querySelector('span'); if(s){ var o=s.textContent; s.textContent=ok?'Copied':'Copy failed'; setTimeout(function(){ s.textContent=o; },1200);} } });
      }
    });
    // --- bar handlers (shell-safe subset; Copy-markdown/Publish/Share deferred
    //     until the probe supplies doc text / the publish flow is ported) ---
    function wire(sel, ev, fn){ var el = document.querySelector(sel); if (el) el.addEventListener(ev, fn); }
    // Theme toggle: paint the shell; frame theme comes with the probe theme msg.
    (function(){
      var KEY='tdoc-theme';
      function apply(t){ document.documentElement.setAttribute('data-tdoc-theme', t); var b=document.getElementById('tdoc-theme-btn'); if(b) b.setAttribute('aria-pressed', t==='dark'?'true':'false'); }
      try { if (localStorage.getItem(KEY)==='dark') apply('dark'); } catch(e){}
      wire('#tdoc-theme-btn','click',function(){ var dark=document.documentElement.getAttribute('data-tdoc-theme')!=='dark'; apply(dark?'dark':'light'); try{localStorage.setItem(KEY,dark?'dark':'light');}catch(e){} sendFrame({type:'tdoc:theme',theme:dark?'dark':'light'}); });
    })();
    // My docs
    wire('#tdoc-bar-mark','click',function(){ location.href='/me'; });
    // Publish (local mode)
    wire('#tdoc-publish-btn','click',function(e){ e.stopPropagation(); showPublishModal(); });
    // Menus open by toggling .open on the MENU element (matches the real CSS
    // .tdoc-menu.open / .tdoc-version-menu.open).
    function toggleMenu(id){ var m=document.getElementById(id); if(!m) return; var was=m.classList.contains('open'); closeMenus(); if(!was) m.classList.add('open'); }
    function closeMenus(){ document.querySelectorAll('.tdoc-menu.open, .tdoc-version-menu.open, .tdoc-secondary-menu.open').forEach(function(m){ m.classList.remove('open'); }); }
    wire('#tdoc-version-toggle','click',function(e){ e.stopPropagation(); toggleMenu('tdoc-version-menu'); });
    document.querySelectorAll('.tdoc-version-menu [data-version]').forEach(function(b){ b.addEventListener('click', function(){ location.href='/d/'+encodeURIComponent(cfg.slug)+'/v/'+b.getAttribute('data-version'); }); });
    wire('#tdoc-copy-md-btn','click',function(e){ e.stopPropagation(); toggleMenu('tdoc-copy-md-menu'); });
    document.querySelectorAll('#tdoc-copy-md-menu [data-mode]').forEach(function(b){ b.addEventListener('click', function(e){ e.stopPropagation(); closeMenus(); copyReq={ includeComments: b.getAttribute('data-mode')==='doc-comments' }; sendFrame({ type:'tdoc:copyDoc', requestId: Date.now() }); }); });
    wire('#tdoc-more-btn','click',function(e){ e.stopPropagation(); toggleMenu('tdoc-secondary-menu'); });
    document.addEventListener('click', function(){ closeMenus(); closeEmojiPicker(); closeCard(); closeClusterPopover(); });
    layout();
  })();`;
  }

  function shellHtml(d) {
    return '<!doctype html><html lang="en"><head>\n' +
'<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'<title>' + esc(d.title) + '</title>\n' +
'<style>' + (d.chromeCssStr || '') + '</style>\n' +
'<style>\n' +
'  /* shell layout only — the real chrome CSS above owns bar/footer/composer/pins */\n' +
'  html,body{margin:0;padding:0;min-height:100vh;background:#fff;}\n' +
'  body{display:flex;flex-direction:column;}\n' +
'  .tdoc-doc-frame{flex:1 1 auto;width:100%;border:0;display:block;}\n' +
'  .tdoc-footer{margin-top:0;position:fixed;left:0;right:0;bottom:0;z-index:4;background:#fff;opacity:0;transform:translateY(100%);transition:opacity .18s ease,transform .18s ease;pointer-events:none;}\n' +
'  .tdoc-footer.tdoc-footer-show{opacity:1;transform:none;pointer-events:auto;}\n' +
'  @media (max-width:700px){\n' +
'    .tdoc-footer .tdoc-footer-row{flex-direction:row;}\n' +
'    .tdoc-footer .tdoc-footer-row>a:first-child{display:none;}\n' +
'  }\n' +
'  .tdoc-pin{position:fixed;}\n' +
'  .tdoc-popup{position:fixed;}\n' +
'  .tdoc-margin-comment{position:fixed;}\n' +
'</style>\n' +
'</head><body>\n' +
'  <div class="tdoc-bar">' + (d.barInner || '') + '</div>\n' +
'  <div class="tdoc-reanchor-banner"><span class="label">Select text to move anchor</span><button type="button" id="tdoc-reanchor-remove">Remove anchor</button><button type="button" id="tdoc-reanchor-cancel" class="danger">Cancel</button></div>\n' +
'  <iframe class="tdoc-doc-frame" title="Document content" sandbox="allow-scripts" src="' + esc(d.frameSrc) + '"></iframe>\n' +
'  <footer class="tdoc-footer">' + (d.footerInner || '') + '</footer>\n' +
'  <script' + d.nonceAttr + '>' + d.chromeJs + '</scr' + 'ipt>\n' +
'  <script' + d.nonceAttr + '>window.__TDOC__ = ' + d.authCfgJson + ';</scr' + 'ipt>\n' +
'  <script' + d.nonceAttr + '>window.__TDOC_SHELL__ = ' + d.cfgJson + ';</scr' + 'ipt>\n' +
'  <script' + d.nonceAttr + '>' + d.signinJs + '</scr' + 'ipt>\n' +
'  ' + (d.onboardJs ? ('<script' + d.nonceAttr + '>' + d.onboardJs + '</scr' + 'ipt>') : '') + '\n' +
'  <script' + d.nonceAttr + '>' + shellScript() + '</scr' + 'ipt>\n' +
'</body></html>';
  }

  var api = { sliceChromeCss: sliceChromeCss, shellScript: shellScript, shellHtml: shellHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof globalThis !== 'undefined') globalThis.TDOC_SHELL_BUILDER = api;
})();
