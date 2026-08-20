// GitHub device-flow sign-in, in one place.
//
// There were two of these. The overlay had the good one — RFC 8628 slow_down
// backoff, a real modal, an isOwner refresh — and landingHtml() carried a
// second, simpler implementation with its own retry loop and its own error
// strings, because the neutral page has no overlay to borrow from. Two
// implementations of one protocol means every fix lands in one of them, and
// adding a second provider would have meant writing it twice.
//
// So: one module, self-contained (its own styles, since it has to render on a
// page with no overlay CSS), exposing one global. Callers decide only what
// happens after success.
//
//   window.__tdocSignIn()            -> Promise<identity>, rejects if cancelled
//   window.__tdocSignIn.available()  -> is auth configured on this host
//
// The CLI has its own copy of the protocol in bin/tdoc-publish, and has to:
// it runs in a terminal with no DOM. It shares the endpoints, not the code.
(function () {
  if (window.__tdocSignIn) return;

  var CSS = [
    '.tds-bg{position:fixed;inset:0;background:rgba(16,18,26,.55);display:grid;place-items:center;z-index:1000001;padding:20px}',
    '.tds{width:min(420px,100%);background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 24px 60px rgba(16,18,26,.28);font:15px/1.5 system-ui,-apple-system,sans-serif;color:#10121a}',
    '.tds-bd{padding:20px}',
    '.tds h3{margin:0 0 14px;font-size:18px}',
    '.tds-step{display:flex;gap:9px;align-items:flex-start;margin:0 0 10px;font-size:14px;color:#5b6070}',
    '.tds-n{flex:none;width:19px;height:19px;border-radius:50%;background:#eef3ff;color:#1652f0;font-size:11.5px;font-weight:700;display:grid;place-items:center;margin-top:1px}',
    '.tds-codewrap{position:relative;margin:0 0 12px}',
    '.tds-code{font:22px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em;background:#f5f6f8;border:1px solid #e4e7ee;border-radius:10px;padding:15px 15px 46px;text-align:center;-webkit-user-select:all;user-select:all}',
    '.tds-copy{position:absolute;right:10px;bottom:10px;border:1px solid #d3d8e3;background:#fff;color:#10121a;border-radius:8px;padding:6px 13px;font:13px system-ui,-apple-system,sans-serif;font-weight:650;cursor:pointer}',
    '.tds-copy:hover{border-color:#b9c0cd}',
    '.tds-copy.done{background:#1a7340;border-color:#1a7340;color:#fff}',
    '.tds-open{display:inline-flex;align-items:center;gap:7px;margin:2px 0 12px;background:#1652f0;color:#fff;border-radius:999px;padding:9px 16px;font:14px system-ui,-apple-system,sans-serif;font-weight:650;text-decoration:none}',
    '.tds-open:hover{background:#0f43cc}',
    '.tds-open svg{width:15px;height:15px;fill:currentColor}',
    '.tds-status{color:#767c8b;font-size:13px}',
    '.tds-err{color:#c3452f}',
    '.tds-ft{padding:13px 20px;border-top:1px solid #e4e7ee;background:#fafbfd;text-align:right}',
    '.tds-ft button{border:1px solid #e4e7ee;background:#fff;color:#10121a;border-radius:999px;padding:8px 16px;font:inherit;cursor:pointer}'
  ].join('');

  function styles() {
    if (document.getElementById('tds-css')) return;
    var s = document.createElement('style');
    s.id = 'tds-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // Only ever auto-open github.com over https. The URL comes from our own API,
  // but a redirect target is exactly the field worth pinning down. Named and
  // exported because test/overlay-pure.test.js exercises it directly.
  function isGithubHttpsUrl(u) {
    try {
      var url = new URL(String(u));
      return url.protocol === 'https:' && /(^|\.)github\.com$/.test(url.hostname);
    } catch (e) { return false; }
  }

  function api(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    }).then(function (r) {
      return r.json().catch(function () { return { error: 'http_' + r.status }; });
    });
  }

  function run() {
    styles();
    return new Promise(function (resolve, reject) {
      var timer = null, done = false;

      var bg = document.createElement('div');
      bg.className = 'tds-bg';
      bg.innerHTML = '<div class="tds" role="dialog" aria-modal="true" aria-label="Sign in with GitHub">'
        + '<div class="tds-bd">'
        + '<h3>Sign in with GitHub</h3>'
        + '<div class="tds-step"><span class="tds-n">1</span><span>Copy this code:</span></div>'
        + '<div class="tds-codewrap"><div class="tds-code" id="tds-code">…</div>'
        + '<button type="button" class="tds-copy" id="tds-copy">Copy</button></div>'
        + '<div class="tds-step"><span class="tds-n">2</span><span id="tds-where">Opening GitHub…</span></div>'
        + '<div class="tds-step"><span class="tds-n">3</span><span class="tds-status" id="tds-status">Starting…</span></div>'
        + '</div><div class="tds-ft"><button type="button" id="tds-cancel">Cancel</button></div></div>';
      document.body.appendChild(bg);

      function finish(fn, arg) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        bg.remove();
        fn(arg);
      }
      function status(msg, bad) {
        var el = document.getElementById('tds-status');
        if (!el) return;
        el.textContent = msg;
        el.className = 'tds-status' + (bad ? ' tds-err' : '');
      }
      document.getElementById('tds-cancel').onclick = function () {
        finish(reject, new Error('cancelled'));
      };

      api('/api/auth/device/start').then(function (d) {
        if (d.error || !d.user_code || !d.verification_uri) {
          status((d && (d.message || d.error)) || 'Sign-in is not available on this host.', true);
          return;
        }
        var code = document.getElementById('tds-code');
        code.textContent = d.user_code;
        var cbtn = document.getElementById('tds-copy');
        var copied = false;
        function mark() { copied = true; cbtn.textContent = 'Copied'; cbtn.className = 'tds-copy done'; }
        function copyCode() {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(d.user_code).then(mark, function () { selectCode(); });
          } else { selectCode(); }
        }
        function selectCode() {
          try {
            var rng = document.createRange();
            rng.selectNodeContents(code);
            var sel = window.getSelection();
            sel.removeAllRanges(); sel.addRange(rng);
            cbtn.textContent = /Mac|iP(hone|ad)/.test(navigator.platform || '') ? 'Press \u2318C' : 'Press Ctrl+C';
          } catch (e) {}
        }
        cbtn.onclick = copyCode;
        code.onclick = copyCode;

        // Put the code on the clipboard the moment it exists, so a visitor who
        // lands on GitHub's login first (which never shows the code) can paste
        // it without coming back for it — the miss this whole flow is built to
        // avoid. On desktop the click that opened this modal still counts as
        // recent activation, so this lands silently and the button reads
        // "Copied". Where activation is gone (Safari drops it across the
        // device/start round-trip) it stays quiet: no false "Copied", and the
        // Open-GitHub tap below copies again from a real gesture. Never fall
        // back to the "Press Ctrl+C" hint here — that's only honest after a
        // real click.
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(d.user_code).then(mark, function () {});
        }

        var uri = d.verification_uri_complete || d.verification_uri;
        var where = document.getElementById('tds-where');
        // A native target=_blank anchor is the only hop that every browser
        // honours: a scripted window.open() fired after this await is outside
        // the click's activation window, so Safari and in-app webviews either
        // swallow it or, worse, open it in this tab. Losing this tab loses the
        // poll below, and the sign-in can never complete. The anchor cannot
        // navigate the page it sits on.
        if (isGithubHttpsUrl(uri)) {
          where.innerHTML = 'Open GitHub and approve. The code is already filled in.'
            + '<a class="tds-open" id="tds-open" href="' + esc(uri) + '"'
            + ' target="_blank" rel="noopener noreferrer">'
            + '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .297c-6.63 0-12 5.373-12 12 0'
            + ' 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422'
            + ' 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305'
            + ' 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176'
            + ' 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24'
            + ' 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015'
            + ' 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>Open GitHub</a>';
          // Copy on the tap that leaves for GitHub — the reliable moment, and
          // the belt to the auto-copy's braces if activation was gone above.
          // The anchor still navigates; this only seeds the clipboard first.
          document.getElementById('tds-open').addEventListener('click', function () {
            if (!copied) copyCode();
          });
          // Try the convenience popup too, but never depend on it.
          var popped = null;
          try { popped = window.open(uri, '_blank', 'noopener'); } catch (e) {}
          if (!popped) status('Click Open GitHub to approve, then come back to this tab.');
          else status('Waiting for you to approve…');
        } else {
          where.innerHTML = 'Paste it at <b>' + esc(d.verification_uri) + '</b> and approve.';
          status('Waiting for you to approve…');
        }

        var interval = Math.max(5, Number(d.interval) || 5);
        (function poll() {
          timer = setTimeout(function () {
            api('/api/auth/device/poll', { device_code: d.device_code }).then(function (p) {
              if (p && p.ok && p.identity) {
                // One announcement, so the bar, the comments and any open
                // dialog all update wherever the flow was started from.
                try {
                  document.dispatchEvent(new CustomEvent('tdoc:signedin', { detail: p.identity }));
                } catch (e) {}
                return finish(resolve, p.identity);
              }
              // RFC 8628 §3.5: back off 5s when told to, or GitHub keeps
              // refusing at the same cadence forever.
              if (p && p.error === 'slow_down') interval += 5;
              else if (p && p.error && p.error !== 'authorization_pending' && !p.pending) {
                status(p.message || p.error, true);
                return;
              }
              poll();
            }).catch(function () {
              status('Network error — retrying…');
              poll();
            });
          }, interval * 1000);
        })();
      });
    });
  }

  run.available = function () {
    var cfg = window.__TDOC__ || {};
    return cfg.authConfigured !== false;
  };
  window.__tdocSignIn = run;
})();
