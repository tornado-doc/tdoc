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
    '.tds-code{font:22px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em;background:#f5f6f8;border:1px solid #e4e7ee;border-radius:10px;padding:15px;text-align:center;margin:0 0 12px;cursor:pointer;-webkit-user-select:all;user-select:all}',
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
        + '<div class="tds-code" id="tds-code">…</div>'
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
        code.onclick = function () {
          if (navigator.clipboard) navigator.clipboard.writeText(d.user_code);
        };
        var uri = d.verification_uri_complete || d.verification_uri;
        document.getElementById('tds-where').innerHTML =
          'Paste it at <b>' + esc(d.verification_uri) + '</b> and approve.';
        if (isGithubHttpsUrl(uri)) window.open(uri, '_blank', 'noopener');
        status('Waiting for you to approve…');

        var interval = Math.max(5, Number(d.interval) || 5);
        (function poll() {
          timer = setTimeout(function () {
            api('/api/auth/device/poll', { device_code: d.device_code }).then(function (p) {
              if (p && p.ok && p.identity) return finish(resolve, p.identity);
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
