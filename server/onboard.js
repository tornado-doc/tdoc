// tdoc onboarding. Product UI, not author content: it ships from the worker
// under the page nonce, because a published doc's own <script> never runs
// (see #138). The landing CTA keeps its href so the flow still works with
// scripting off; this upgrades it in place.
//
// Two steps, and the first one is a sign-in — which is only worth asking for
// because of what it now buys. Since #156 the hosted mint is session-gated, so
// signing in is what turns the second step into "paste this, get a link" with
// nothing to install and nothing to pay for. Signed out, the same paste line
// still works; it just ends at a Cloudflare account the visitor sets up.
//
// What is deliberately NOT here:
//   - No runtime picker. Only Claude Code has a documented `/plugin` line,
//     agents cannot run `/plugin` for you anyway, and ONBOARDING.md is written
//     for an agent to read. So the agent installs itself.
//   - No "what do you want to make?" step. The first doc is fixed on purpose:
//     a Game of Life page that teaches the loop by being the thing you comment
//     on. Choosing a noun taught nothing.
(function () {
  var CTA = 'a[href="/start"]';
  var GUIDE = 'https://github.com/tornado-doc/tdoc/blob/main/ONBOARDING.md';

  var S = document.createElement('style');
  S.textContent = [
    '.tdo-bg{position:fixed;inset:0;background:rgba(16,18,26,.55);display:grid;place-items:center;z-index:1000000;padding:20px;overflow:auto}',
    '.tdo{width:min(540px,100%);background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(16,18,26,.28);overflow:hidden;font:15px/1.55 system-ui,-apple-system,sans-serif;color:#10121a}',
    '.tdo-hd{display:flex;align-items:center;gap:10px;padding:18px 20px;border-bottom:1px solid #e4e7ee}',
    '.tdo-hd strong{font-size:15px}',
    '.tdo-dots{display:flex;gap:6px;margin-left:auto}',
    '.tdo-dot{width:7px;height:7px;border-radius:50%;background:#dfe3ea}.tdo-dot.on{background:#1652f0}',
    '.tdo-x{border:0;background:none;font-size:20px;line-height:1;color:#767c8b;cursor:pointer;padding:0 2px}',
    '.tdo-bd{padding:20px}',
    '.tdo h2{font-size:20px;margin:0 0 6px;letter-spacing:-.02em}',
    '.tdo p{margin:0 0 14px;color:#5b6070;font-size:14.5px}',
    '.tdo-line{font:13.5px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;background:#f5f6f8;border:1px solid #e4e7ee;border-radius:10px;padding:14px;color:#10121a;word-break:break-word}',
    '.tdo-learn{margin:14px 0 0;padding:13px 14px;border:1px solid #e4e7ee;border-radius:10px;background:#fafbfd}',
    '.tdo-learn b{display:block;font-size:13px;margin:0 0 7px}',
    '.tdo-learn ol{margin:0;padding-left:17px;color:#5b6070;font-size:13px}',
    '.tdo-learn li{margin:0 0 4px}',
    '.tdo-note{font-size:12.5px;color:#767c8b;margin:12px 0 0;display:flex;gap:7px;align-items:flex-start}',
    '.tdo-note svg{width:14px;height:14px;flex:none;margin-top:2px;fill:none;stroke:currentColor;stroke-width:2}',
    '.tdo-ft{padding:16px 20px;border-top:1px solid #e4e7ee;background:#fafbfd}',
    '.tdo-btn{width:100%;border:0;border-radius:999px;padding:13px;font-weight:650;font-size:15px;cursor:pointer;background:#1652f0;color:#fff;display:flex;align-items:center;justify-content:center;gap:9px}',
    '.tdo-btn[disabled]{opacity:.5;cursor:default}',
    '.tdo-btn.done{background:#1a7340}',
    '.tdo-btn svg{width:16px;height:16px;fill:currentColor;flex:none}',
    '.tdo-skip{display:block;width:100%;text-align:center;margin:11px 0 0;font-size:13px;color:#767c8b;background:none;border:0;cursor:pointer;font-family:inherit}',
    '.tdo-skip:hover{color:#10121a}'
  ].join('');
  document.head.appendChild(S);

  var st = { step: 0, token: null, copied: false, waiting: false, signedIn: false, bg: null, box: null, esc: null };

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

  function shield() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/></svg>';
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
    var dots = el('div', 'tdo-dots');
    for (var i = 0; i < 2; i++) dots.appendChild(el('span', 'tdo-dot' + (i <= st.step ? ' on' : '')));
    hd.appendChild(dots);
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

  // ---- step 1: sign in ---------------------------------------------------
  // Worth a step only because of what it unlocks: the hosted mint is
  // session-gated since #156, and the same login remints the same account, so
  // this is also how the doc is recoverable later. Skippable, because
  // publishing to your own host needs no account at all.
  function stepSignIn() {
    st.step = 0;
    var bd = shell('Sign in with GitHub',
      'So tdoc can host your doc and hand you a link with nothing to set up. Same login gets you back to it later, on any machine.');

    var n = el('div', 'tdo-note');
    n.innerHTML = shield() + '<span>We read your GitHub username, nothing else. tdoc never sees your code or your repositories.</span>';
    bd.appendChild(n);

    var ft = el('div', 'tdo-ft');
    var b = el('button', 'tdo-btn', (st.waiting ? '' : ghMark()) + '<span>' + (st.waiting ? 'Waiting for GitHub…' : 'Sign in with GitHub') + '</span>');
    b.disabled = !!st.waiting;
    b.onclick = signIn;
    ft.appendChild(b);

    var skip = el('button', 'tdo-skip', 'Skip, I’ll publish to my own host');
    skip.onclick = function () { st.step = 1; render(); };
    ft.appendChild(skip);
    st.box.appendChild(ft);
    return b;
  }

  // ---- step 2: the one line ---------------------------------------------
  function stepPaste() {
    st.step = 1;
    var bd = shell('Paste one line into your AI', st.token
      ? 'It installs tdoc, builds your first doc, and publishes it. Nothing to set up.'
      : 'It installs tdoc, builds your first doc, and publishes it to a free Cloudflare account you own. About five minutes the first time, then it is one sentence.');

    bd.appendChild(el('div', 'tdo-line', null)).textContent = line();

    // The first doc is a lesson, so say what it will teach before they paste.
    var learn = el('div', 'tdo-learn');
    learn.innerHTML = '<b>Your first doc teaches the loop</b>'
      + '<ol><li>Leave a couple of comments on the page.</li>'
      + '<li>Tell your AI to fix them.</li>'
      + '<li>A new version appears, with a reply on every comment.</li>'
      + '<li>Send the link to a friend and let them comment too.</li>'
      + (st.token ? '<li>Everything you publish lands in your hub at <strong>tdoc.dev/me</strong>.</li>' : '')
      + '</ol>';
    bd.appendChild(learn);

    var n1 = el('div', 'tdo-note');
    n1.innerHTML = shield() + '<span>Your doc gets a public link. Anyone with the URL can read it, and only you can change it.</span>';
    bd.appendChild(n1);

    var n2 = el('div', 'tdo-note');
    n2.innerHTML = st.token
      ? shield() + '<span>The key lets your agent publish and edit <strong>your</strong> docs. It cannot read your computer and cannot touch anyone else’s docs. Signing in with the same GitHub account gets you back to it.</span>'
      : shield() + '<span>First time only: your agent gets you a free Cloudflare account. You click <em>create account</em> and <em>enable R2</em> in your own browser. No card. Just want it on your machine? Say <em>keep it local</em> instead and skip all of it.</span>';
    bd.appendChild(n2);

    var ft = el('div', 'tdo-ft');
    var b = el('button', 'tdo-btn', '<span>' + (st.copied ? 'Copied' : 'Copy the line') + '</span>');
    if (st.copied) b.className = 'tdo-btn done';
    b.onclick = function () { copy(b, bd); };
    ft.appendChild(b);
    st.box.appendChild(ft);
    if (st.copied) showNext(bd);
    return b;
  }

  function render() {
    if (!st.box) return null;
    return st.step === 0 ? stepSignIn() : stepPaste();
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

  // The overlay already ships a full device flow and binds it to the bar's
  // sign-in chip. Click that instead of writing a parallel one, then watch for
  // the session and mint.
  function signIn() {
    var chip = document.getElementById('tdoc-signin');
    if (chip) chip.click();
    st.waiting = true;
    render();
    var tries = 0;
    var iv = setInterval(function () {
      if (!st.bg || ++tries > 100) { clearInterval(iv); return; }
      fetch('/api/auth/me', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (me) {
          if (!me || !me.login) return;
          clearInterval(iv);
          st.waiting = false; st.signedIn = true;
          mint().then(function () { st.step = 1; render(); });
        })
        .catch(function () {});
    }, 3000);
  }

  function mint() {
    return fetch('/api/hosted/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{}', credentials: 'same-origin',
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r && r.token) st.token = r.token;
    }).catch(function () {});
  }

  function open(e) {
    // Only hijack a plain left click. cmd/ctrl/middle-click means "open the
    // page in a new tab", and /start is a real page that answers that.
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.button && e.button !== 0))) return;
    if (e) e.preventDefault();

    // Display state is recomputed per open, so a stale step or a green
    // "Copied" never survives into a fresh dialog.
    st.step = 0; st.token = null; st.copied = false; st.waiting = false; st.signedIn = false;

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

    // Someone already signed in should not be asked again, and a host with no
    // auth configured (local Studio) has nobody to ask. Both start at the line.
    var cfg = window.__TDOC__ || {};
    if (cfg.authConfigured === false) { st.step = 1; render(); return; }
    if (cfg.identity && cfg.identity.login) {
      st.signedIn = true;
      mint().then(function () { if (st.bg) { st.step = 1; render(); } });
    }
  }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest(CTA);
    if (a) open(e);
  });
})();
