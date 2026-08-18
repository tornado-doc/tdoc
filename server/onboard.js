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
    '.tdo-linewrap{position:relative;margin:0 0 4px}',
    '.tdo-line{font:13.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f5f6f8;border:1px solid #e4e7ee;border-radius:10px;padding:14px 14px 46px;color:#10121a;word-break:break-word}',
    '.tdo-copy{position:absolute;right:10px;bottom:10px;border:1px solid #d3d8e3;background:#fff;color:#10121a;border-radius:8px;padding:6px 13px;font:inherit;font-size:13px;font-weight:650;cursor:pointer}',
    '.tdo-copy:hover{border-color:#b9c0cd}',
    '.tdo-copy.done{background:#1a7340;border-color:#1a7340;color:#fff}',
    '.tdo-gh{width:16px;height:16px;fill:currentColor;flex:none}',
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

  var st = { page: 0, token: null, hosted: false, copied: false, waiting: false, bg: null, box: null, esc: null };

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

  // ---- page 1: sign in (skipped when we already have a session) ----------
  function stepSignIn() {
    var bd = shell('First, sign in with GitHub',
      'So tdoc can publish for you and hand back a link. Same login gets you back to your docs later, on any machine.');
    var ft = el('div', 'tdo-ft');
    var b = el('button', 'tdo-btn', st.waiting
      ? '<span>Waiting for GitHub…</span>'
      : '<svg class="tdo-gh" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg><span>Sign in with GitHub</span>');
    b.disabled = !!st.waiting;
    b.onclick = signIn;
    ft.appendChild(b);
    var skip = el('button', 'tdo-skip', 'Skip, I publish to my own host');
    skip.onclick = function () { st.page = 1; render(); };
    ft.appendChild(skip);
    st.box.appendChild(ft);
    return b;
  }

  // ---- page 2: the line, with Copy inside the box ------------------------
  function stepPaste() {
    var bd = shell('Paste this into your AI', st.hosted
      ? 'It installs tdoc, builds your first doc, and publishes it.'
      : 'It installs tdoc, builds your first doc, and publishes it to a free Cloudflare account you own. No card.');

    var wrap = el('div', 'tdo-linewrap');
    var pre = el('div', 'tdo-line');
    pre.textContent = line();
    wrap.appendChild(pre);
    // Inside the box, because a button under the dialog reads as "copy the
    // dialog" — which is exactly what it looked like.
    var cp = el('button', 'tdo-copy', 'Copy');
    cp.onclick = function () { copy(cp, pre); };
    wrap.appendChild(cp);
    bd.appendChild(wrap);

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
    var b = el('button', 'tdo-btn', '<span>' + (st.copied ? 'Next' : 'I pasted it') + '</span>');
    b.onclick = function () { st.page = 2; render(); };
    ft.appendChild(b);
    st.box.appendChild(ft);
    return cp;
  }

  // ---- page 3: what happens next -----------------------------------------
  function stepNext() {
    var bd = shell('Now go run it', 'The link it hands back is the proof it worked.');
    var learn = document.createElement('details');
    learn.className = 'tdo-learn';
    learn.open = true;
    learn.innerHTML = '<summary>Three steps</summary>'
      + '<ol><li>Open the AI you already use.</li>'
      + '<li>Paste the line and send it.</li>'
      + '<li>It hands you a link. Share it, and comments land on the page.</li></ol>';
    bd.appendChild(learn);

    var ft = el('div', 'tdo-ft');
    var b = el('button', 'tdo-btn', '<span>Done</span>');
    b.onclick = close;
    ft.appendChild(b);
    var tut = el('a', 'tdo-tut', 'Or read the full tutorial');
    tut.href = '/start';
    ft.appendChild(tut);
    st.box.appendChild(ft);
    return b;
  }

  var PAGES = [stepSignIn, stepPaste, stepNext];
  function render() {
    if (!st.box) return null;
    return PAGES[st.page]();
  }

  // The visitor is about to leave for their agent and may not come back, so
  // the copy is also the handoff: name the landmark that proves it worked.

  function copy(btn, pre) {
    var text = line();
    var done = function () {
      st.copied = true;
      btn.textContent = 'Copied';
      btn.className = 'tdo-copy done';
      // Advance rather than growing the page underneath them: expanding in
      // place shifted everything and read as a glitch.
      setTimeout(function () { if (st.bg) { st.page = 2; render(); } }, 550);
    };
    // A click that appears to do nothing is worse than no button. The
    // clipboard API rejects whenever the document is not focused, so the last
    // resort still has to leave the visitor holding the line.
    var manual = function () {
      try {
        var rng = document.createRange();
        rng.selectNodeContents(pre);
        var sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(rng);
      } catch (e) {}
      btn.textContent = /Mac|iP(hone|ad)/.test(navigator.platform || '') ? 'Press \u2318C' : 'Press Ctrl+C';
      st.copied = true;
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

  // Sign-in reuses server/signin.js, the one device flow shared with the
  // overlay and the neutral page.
  function signIn() {
    if (!window.__tdocSignIn) { st.page = 1; render(); return; }
    st.waiting = true;
    render();
    window.__tdocSignIn().then(function () {
      st.waiting = false;
      return mint();
    }, function () {
      st.waiting = false;
      render();          // cancelled: stay on the sign-in page
    }).then(function () {
      if (st.bg && !st.waiting) { st.page = 1; render(); }
    });
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

    // Display state is recomputed per open, so a stale page or a green
    // "Copied" never survives into a fresh dialog.
    st.page = 0; st.token = null; st.hosted = false; st.copied = false; st.waiting = false;

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


    // Signing in is page one, but only when there is something to sign into
    // and nobody signed in yet. Everyone else starts at the line.
    var cfg = window.__TDOC__ || {};
    var signedIn = !!(cfg.identity && cfg.identity.login);
    if (cfg.authConfigured === false || signedIn) st.page = 1;
    var btn = render();
    if (btn) btn.focus();
    if (signedIn) mint();
  }

  document.addEventListener('click', function (e) {
    if (!e.target || !e.target.closest) return;
    // A link to /start inside the dialog is a real navigation, not another
    // way to open what is already open.
    if (e.target.closest('.tdo-bg')) return;
    if (e.target.closest(CTA)) open(e);
  });
})();
