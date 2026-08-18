// tdoc onboarding. Product UI, not author content: it ships from the worker
// under the page nonce, because a published doc's own <script> never runs
// (see #138). The landing CTA keeps its href so the flow still works with
// scripting off; this upgrades it in place.
//
// One screen, no account. Everything this flow needs is a line of text the
// visitor pastes into the agent they already use, so every step that is not
// that line has been cut:
//
//   - No sign-in to get started. Publishing to a host you own needs no
//     account at all, and the sign-in that IS enforced (commenting) is already
//     offered in the composer at the moment it is needed. Asking for GitHub up
//     front spent the highest-abandon interaction in the funnel — leave the
//     site, type a code, come back — before the visitor had anything to lose.
//     Once #156 lands, letting US host the doc does require a session, so that
//     is offered here as an optional upgrade, after the working line, and only
//     to the people who want it. Last, not first.
//   - No runtime picker. Only Claude Code has a documented `/plugin` line,
//     agents cannot run `/plugin` for you anyway, and ONBOARDING.md is written
//     for an agent to read. So the agent installs itself and the question
//     never gets asked.
//   - No "what do you want to make?" step. It changed one noun, and a five
//     item menu teaches the wrong thing: the point is that you can ask for
//     anything, so the line says so in words instead of offering a dropdown.
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
    '.tdo-swap{font-size:12.5px;color:#767c8b;margin:9px 0 0}',
    '.tdo-swap b{color:#10121a;font-weight:600}',
    '.tdo-note{font-size:12.5px;color:#767c8b;margin:12px 0 0;display:flex;gap:7px;align-items:flex-start}',
    '.tdo-note svg{width:14px;height:14px;flex:none;margin-top:2px;fill:none;stroke:currentColor;stroke-width:2}',
    '.tdo-ft{padding:16px 20px;border-top:1px solid #e4e7ee;background:#fafbfd}',
    '.tdo-btn{width:100%;border:0;border-radius:999px;padding:13px;font-weight:650;font-size:15px;cursor:pointer;background:#1652f0;color:#fff}',
    '.tdo-btn.done{background:#1a7340}',
    '.tdo-alt{display:block;text-align:center;margin:11px 0 0;font-size:13px;color:#5b6070}',
    '.tdo-up{margin:14px 0 0;padding:12px 13px;border:1px solid #cddcff;background:#f4f7ff;border-radius:10px;font-size:13.5px;color:#10121a}',
    '.tdo-up button{margin:8px 0 0;border:1px solid #1652f0;background:#fff;color:#1652f0;border-radius:999px;padding:7px 14px;font:inherit;font-weight:650;cursor:pointer}',
    '.tdo-up p{margin:0;color:#5b6070;font-size:12.5px}',
    '.tdo-next{margin:16px 0 0;padding:14px;border:1px solid #e4e7ee;border-radius:10px;background:#fff}',
    '.tdo-next ol{margin:0;padding-left:18px;color:#5b6070;font-size:14px}',
    '.tdo-next li{margin:0 0 5px}'
  ].join('');
  document.head.appendChild(S);

  var st = { token: null, copied: false, canHost: false, waiting: false, bg: null, box: null, esc: null, scrollY: 0 };

  function el(t, c, h) { var e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; }

  // The literal text the visitor pastes. The agent reads GUIDE and installs
  // itself, so this one line works in every runtime and needs no picker.
  function line() {
    var s = 'Read ' + GUIDE + ' and set yourself up with tdoc.';
    if (st.token) s += ' My tdoc hosted token is ' + st.token + '.';
    return s + ' Then make me a report and publish it.';
  }

  function shield() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z"/></svg>';
  }

  function close() {
    if (st.esc) { document.removeEventListener('keydown', st.esc); st.esc = null; }
    document.body.style.overflow = '';
    if (st.bg) st.bg.remove();
    st.bg = null; st.box = null;
  }

  function render() {
    var box = st.box;
    if (!box) return;
    box.innerHTML = '';

    var hd = el('div', 'tdo-hd');
    hd.appendChild(el('strong', null, 'Make your first doc'));
    var x = el('button', 'tdo-x', '&times;');
    x.setAttribute('aria-label', 'Close'); x.onclick = close;
    hd.appendChild(x);
    box.appendChild(hd);

    var bd = el('div', 'tdo-bd');
    bd.appendChild(el('h2', null, 'Paste one line into your AI'));
    // What it costs, before the button, not after. With hosted signup closed
    // this ends in a Cloudflare account, and "it handles it" is how a Notion
    // user reads any softer wording. See ONBOARDING.md steps 4a and 4b.
    bd.appendChild(el('p', null, st.token
      ? 'It installs tdoc, writes the page, and publishes it. Nothing to set up.'
      : 'It installs tdoc, writes the page, and publishes it to a free Cloudflare account you own. About five minutes the first time, then it is one sentence.'));

    bd.appendChild(el('div', 'tdo-line', null)).textContent = line();
    bd.appendChild(el('p', 'tdo-swap', 'Swap <b>a report</b> for whatever you actually need: a weekly update, a launch plan, a competitor teardown.'));

    // Both disclosures sit against the button, never in a footnote.
    var n1 = el('div', 'tdo-note');
    n1.innerHTML = shield() + '<span>Your doc gets a public link. Anyone with the URL can read it, and only you can change it.</span>';
    bd.appendChild(n1);

    var n2 = el('div', 'tdo-note');
    n2.innerHTML = st.token
      ? shield() + '<span>The key lets your agent publish and edit <strong>your</strong> docs. It cannot read your computer and cannot touch anyone else’s docs. Signing in with the same GitHub account gets you back to it.</span>'
      : shield() + '<span>First time only: your agent gets you a free Cloudflare account. You click <em>create account</em> and <em>enable R2</em> in your own browser. No card. Just want it on your machine? Say <em>keep it local</em> instead and skip all of it.</span>';
    bd.appendChild(n2);
    // #156 gates the hosted mint on a GitHub session and turns signup on for
    // tdoc.dev by hostname. A signed-out visitor therefore gets
    // sign_in_required, not "closed" — the zero-setup path is available, it
    // just costs a sign-in. Offering it beats silently degrading to Cloudflare,
    // which would hide the best path from everyone who is not already signed in.
    // Still last, still optional: the line above already works without it.
    if (st.canHost && !st.token) {
      var up = el('div', 'tdo-up');
      up.innerHTML = '<strong>Or let us host it.</strong>'
        + '<p>Publish straight to tdoc.dev with no account to set up. Signing in also means you can get the doc back later, on any machine.</p>';
      var sb = el('button', null, st.waiting ? 'Waiting for GitHub…' : 'Sign in with GitHub');
      if (st.waiting) sb.disabled = true;
      sb.onclick = signIn;
      up.appendChild(sb);
      bd.appendChild(up);
    }

    box.appendChild(bd);

    var ft = el('div', 'tdo-ft');
    var b = el('button', 'tdo-btn', st.copied ? 'Copy again' : 'Copy the line');
    b.onclick = function () { copy(b, bd); };
    ft.appendChild(b);

    // The landing page gets read on a phone while the agent is on a laptop,
    // so the line needs a way to travel. mailto needs no backend.
    var mail = el('a', 'tdo-alt', 'Email it to myself');
    mail.href = 'mailto:?subject=' + encodeURIComponent('My tdoc setup line')
      + '&body=' + encodeURIComponent(line() + '\n\nPaste that into Claude Code, Codex, Cursor, Gemini, or Grok.');
    ft.appendChild(mail);
    box.appendChild(ft);

    if (st.copied) showNext(bd);
    return b;
  }

  // The visitor is about to leave for their agent and may not come back, so
  // the copy is also the handoff: say what happens next while the line is
  // still on screen, and name the landmark that proves it worked.
  function showNext(bd) {
    if (bd.querySelector('.tdo-next')) return;
    var n = el('div', 'tdo-next');
    n.innerHTML = '<ol><li>Open the AI you already use.</li>'
      + '<li>Paste the line and send it.</li>'
      + '<li>You will know it worked when it hands you a link. Share it, and comments land on the page.</li></ol>';
    bd.appendChild(n);
  }

  function copy(btn, bd) {
    var text = line();
    var done = function () {
      st.copied = true;
      btn.textContent = 'Copied';
      btn.className = 'tdo-btn done';
      showNext(bd);
    };
    // A click that appears to do nothing is worse than no button. The
    // clipboard API rejects whenever the document is not focused, and
    // execCommand is gone in some browsers, so the last resort still has to
    // leave the visitor holding the line: select it and say which keys.
    var manual = function () {
      var pre = bd.querySelector('.tdo-line');
      try {
        var rng = document.createRange();
        rng.selectNodeContents(pre);
        var sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(rng);
      } catch (e) {}
      btn.textContent = /Mac|iP(hone|ad)/.test(navigator.platform || '')
        ? 'Selected — press ⌘C to copy'
        : 'Selected — press Ctrl+C to copy';
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
  // the session and re-mint. If the chip is absent (already signed in, or auth
  // not configured) just try the mint again.
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
          st.waiting = false;
          mint();
        })
        .catch(function () {});
    }, 3000);
  }

  function mint() {
    return fetch('/api/hosted/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: '{}', credentials: 'same-origin',
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (!st.bg) return;
      if (r && r.token) { st.token = r.token; st.canHost = false; render(); return; }
      // Hosted is on but this visitor has no session yet.
      if (r && r.error === 'sign_in_required') { st.canHost = true; render(); }
    }).catch(function () {});
  }

  function open(e) {
    // Only hijack a plain left click. cmd/ctrl/middle-click means "open the
    // page in a new tab", and /start is a real page that answers that.
    if (e && (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || (e.button && e.button !== 0))) return;
    if (e) e.preventDefault();

    // Display state is recomputed per open. Without this, a visitor who saw
    // the hosted offer once keeps seeing it after signup closes, and the
    // green "Copied" survives into a fresh dialog.
    st.copied = false;
    st.canHost = false;
    st.waiting = false;
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

    // Ask for a hosted token, but never make the visitor wait on it. Whatever
    // comes back, the line above already works: a token upgrades it to
    // zero-setup, sign_in_required offers that upgrade, anything else is our
    // problem and stays invisible.
    mint();
  }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest(CTA);
    if (a) open(e);
  });
})();
