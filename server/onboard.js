// tdoc onboarding. Product UI, not author content: it ships from the worker
// under the page nonce, because a published doc's own <script> never runs
// (see #138). The landing CTA keeps its href so the flow still works with
// scripting off; this upgrades it in place.
//
// One screen. The visitor pastes one short line into the agent they already
// use, and that is the whole flow.
//
// What is deliberately NOT here:
//   - No runtime picker. Only Claude Code has a documented `/plugin` line,
//     agents cannot run `/plugin` for you anyway, and ONBOARDING.md is written
//     for an agent to read. So the agent installs itself.
//   - No "what do you want to make?" step. The first doc is fixed on purpose:
//     a Game of Life page that teaches the loop by being the thing you comment
//     on. Choosing a noun taught nothing.
//   - No sign-in. It led for one commit, on the theory that it bought the
//     hosted token. It does not: since #156 bin/tdoc-publish signs in and mints
//     for itself, so asking here would make the visitor authenticate twice.
//     The agent asks once, at publish, which is where it is actually needed.
(function () {
  var CTA = 'a[href="/start"]';
  var GUIDE = 'https://github.com/tornado-doc/tdoc/blob/main/ONBOARDING.md';

  var S = document.createElement('style');
  S.textContent = [
    '.tdo-bg{position:fixed;inset:0;background:rgba(16,18,26,.55);display:grid;place-items:center;z-index:1000000;padding:20px;overflow:auto}',
    '.tdo{width:min(540px,100%);background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(16,18,26,.28);overflow:hidden;font:15px/1.55 system-ui,-apple-system,sans-serif;color:#10121a}',
    '.tdo-hd{display:flex;align-items:center;gap:10px;padding:18px 20px;border-bottom:1px solid #e4e7ee}',
    '.tdo-hd strong{font-size:15px}',
    '.tdo-x{margin-left:auto;border:0;background:none;font-size:20px;line-height:1;color:#767c8b;cursor:pointer;padding:0 2px}',
    '.tdo-bd{padding:20px}',
    '.tdo h2{font-size:20px;margin:0 0 6px;letter-spacing:-.02em}',
    '.tdo p{margin:0 0 14px;color:#5b6070;font-size:14.5px}',
    '.tdo-line{font:13.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f5f6f8;border:1px solid #e4e7ee;border-radius:10px;padding:14px;color:#10121a;word-break:break-word}',
    '.tdo-learn{margin:13px 0 0;border:1px solid #e4e7ee;border-radius:10px;background:#fafbfd}',
    '.tdo-learn summary{padding:11px 13px;font-size:13px;font-weight:650;cursor:pointer;list-style:none;display:flex;align-items:center;gap:7px}',
    '.tdo-learn summary::-webkit-details-marker{display:none}',
    '.tdo-learn summary:after{content:"\\203A";margin-left:auto;color:#767c8b;transform:rotate(90deg);transition:transform .15s}',
    '.tdo-learn[open] summary:after{transform:rotate(-90deg)}',
    '.tdo-learn ol{margin:0;padding:0 14px 12px 31px;color:#5b6070;font-size:13px}',
    '.tdo-learn li{margin:0 0 4px}',
    '.tdo-tut{display:block;text-align:center;margin:12px 0 0;font-size:13px;color:#1652f0;text-decoration:none}',
    '.tdo-tut:hover{text-decoration:underline}',
    '.tdo-ft{padding:16px 20px;border-top:1px solid #e4e7ee;background:#fafbfd}',
    '.tdo-btn{width:100%;border:0;border-radius:999px;padding:13px;font-weight:650;font-size:15px;cursor:pointer;background:#1652f0;color:#fff;display:flex;align-items:center;justify-content:center;gap:9px}',
    '.tdo-btn[disabled]{opacity:.5;cursor:default}',
    '.tdo-btn.done{background:#1a7340}',
    '.tdo-btn svg{width:16px;height:16px;fill:currentColor;flex:none}',
  ].join('');
  document.head.appendChild(S);

  var st = { token: null, hosted: false, copied: false, bg: null, box: null, esc: null };

  function el(t, c, h) { var e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; }

  // The literal text the visitor pastes. It stays one short sentence because
  // everything it used to spell out — install, auth, what to build, the
  // tutorial, the hub — now lives in FIRST-DOC.md, which the agent reads.
  //
  // No token in here. It used to carry one because minting was browser-only,
  // so the clipboard was the only way to get a credential to the agent. Since
  // #156 the CLI signs in and mints for itself, which is better than pasting a
  // secret into a prompt that lands in the agent's history.
  var RECIPE = 'https://github.com/tornado-doc/tdoc/blob/main/FIRST-DOC.md';
  function line() {
    return 'Set up tdoc and make my first doc: ' + RECIPE;
  }

  function ghMark() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>';
  }

  function close() {
    if (st.esc) { document.removeEventListener('keydown', st.esc); st.esc = null; }
    document.body.style.overflow = '';
    if (st.bg) st.bg.remove();
    st.bg = null; st.box = null;
  }

  function shell(title, sub) {
    var box = st.box;
    box.innerHTML = '';
    var hd = el('div', 'tdo-hd');
    hd.appendChild(el('strong', null, 'Make your first doc'));
    var x = el('button', 'tdo-x', '&times;');
    x.setAttribute('aria-label', 'Close'); x.onclick = close;
    hd.appendChild(x);
    box.appendChild(hd);
    var bd = el('div', 'tdo-bd');
    bd.appendChild(el('h2', null, title));
    if (sub) bd.appendChild(el('p', null, sub));
    box.appendChild(bd);
    return bd;
  }

  function stepPaste() {
    var bd = shell('Paste one line into your AI', st.hosted
      ? 'It installs tdoc, builds your first doc, and publishes it. Your AI asks you to sign in with GitHub once, and that is the only setup.'
      : 'It installs tdoc, builds your first doc, and publishes it to a free Cloudflare account you own. No card.');

    bd.appendChild(el('div', 'tdo-line', null)).textContent = line();

    // Collapsed, because someone who already gets it should be one click from
    // the button. The detail is here for whoever wants to know what they are
    // about to set loose before they paste it.
    var learn = document.createElement('details');
    learn.className = 'tdo-learn';
    learn.innerHTML = '<summary>What does it do?</summary>'
      + '<ol><li>Builds you a Game of Life doc, live and playable.</li>'
      + '<li>Leave a couple of comments on it.</li>'
      + '<li>Tell your AI to fix them.</li>'
      + '<li>A new version appears, with a reply on every comment.</li>'
      + '<li>Send the link to a friend and let them comment too.</li>'
      + (st.hosted ? '<li>Everything you publish lands in your hub at <strong>tdoc.dev/me</strong>.</li>' : '')
      + '</ol>';
    bd.appendChild(learn);

    var ft = el('div', 'tdo-ft');
    var b = el('button', 'tdo-btn', '<span>' + (st.copied ? 'Copied' : 'Copy the line') + '</span>');
    if (st.copied) b.className = 'tdo-btn done';
    b.onclick = function () { copy(b, bd); };
    ft.appendChild(b);
    // The page this points at used to repeat the dialog. It is the full tour
    // now — every feature, in the order you meet them — so the dialog can stay
    // one line and hand off the rest.
    var tut = el('a', 'tdo-tut', 'Or read the full tutorial');
    tut.href = '/start';
    ft.appendChild(tut);
    st.box.appendChild(ft);
    if (st.copied) showNext(bd);
    return b;
  }

  function render() {
    if (!st.box) return null;
    return stepPaste();
  }

  // The visitor is about to leave for their agent and may not come back, so
  // the copy is also the handoff: name the landmark that proves it worked.
  function showNext(bd) {
    if (bd.querySelector('.tdo-next')) return;
    var n = el('div', 'tdo-learn');
    n.className = 'tdo-learn tdo-next';
    n.innerHTML = '<b>Now</b><ol><li>Open the AI you already use.</li>'
      + '<li>Paste the line and send it.</li>'
      + '<li>You will know it worked when it hands you a link.</li></ol>';
    bd.appendChild(n);
  }

  function copy(btn, bd) {
    var text = line();
    var done = function () {
      st.copied = true;
      btn.innerHTML = '<span>Copied</span>';
      btn.className = 'tdo-btn done';
      showNext(bd);
    };
    // A click that appears to do nothing is worse than no button. The
    // clipboard API rejects whenever the document is not focused, so the last
    // resort still has to leave the visitor holding the line.
    var manual = function () {
      var pre = bd.querySelector('.tdo-line');
      try {
        var rng = document.createRange();
        rng.selectNodeContents(pre);
        var sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(rng);
      } catch (e) {}
      btn.innerHTML = '<span>' + (/Mac|iP(hone|ad)/.test(navigator.platform || '')
        ? 'Selected — press ⌘C to copy' : 'Selected — press Ctrl+C to copy') + '</span>';
      st.copied = true;
      showNext(bd);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallback(text, done, manual); });
    } else {
      fallback(text, done, manual);
    }
  }
  function fallback(text, done, manual) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta); ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (ok) done(); else manual();
  }

  function mint() {
    return fetch('/api/hosted/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{}', credentials: 'same-origin',
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (!r) return;
      // Nothing is pasted either way. The token proves hosted is open to this
      // visitor; sign_in_required proves the same thing and that the CLI will
      // do the sign-in. Only an outright "closed" sends them to Cloudflare.
      if (r.token) { st.token = r.token; st.hosted = true; }
      else if (r.error === 'sign_in_required') st.hosted = true;
      if (st.bg) render();
    }).catch(function () {});
  }

  function open(e) {
    // Only hijack a plain left click. cmd/ctrl/middle-click means "open the
    // page in a new tab", and /start is a real page that answers that.
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.button && e.button !== 0))) return;
    if (e) e.preventDefault();

    // Display state is recomputed per open, so a stale step or a green
    // "Copied" never survives into a fresh dialog.
    st.token = null; st.hosted = false; st.copied = false;

    st.bg = el('div', 'tdo-bg');
    st.box = el('div', 'tdo');
    st.box.setAttribute('role', 'dialog');
    st.box.setAttribute('aria-modal', 'true');
    st.box.setAttribute('aria-label', 'Make your first doc');
    st.bg.appendChild(st.box);
    st.bg.addEventListener('click', function (ev) { if (ev.target === st.bg) close(); });

    st.esc = function (ev) {
      if (ev.key === 'Escape') { close(); return; }
      if (ev.key !== 'Tab' || !st.box) return;
      // Keep focus inside the dialog; without this, Tab walks the landing
      // page behind it and a keyboard user cannot tell where they are.
      var f = st.box.querySelectorAll('button, a[href], select, [tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', st.esc);
    document.body.style.overflow = 'hidden';
    document.body.appendChild(st.bg);

    var btn = render();
    if (btn) btn.focus();

    // Ask whether hosted publishing is open to this visitor. Nothing waits on
    // it and nothing is pasted from it; it only decides which promise is true.
    var cfg = window.__TDOC__ || {};
    if (cfg.authConfigured !== false) mint();
  }

  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    // A link to /start inside the dialog is a real navigation, not another
    // way to open what is already open.
    if (e.target.closest('.tdo-bg')) return;
    if (e.target.closest(CTA)) open(e);
  });
})();
