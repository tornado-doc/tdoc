// tdoc onboarding modal. Product UI, not author content: it ships from the
// worker under the page nonce, because a published doc's own <script> never
// runs (see #138). The landing CTA keeps href="/start" so the flow still works
// with scripting off; this upgrades it in place.
(function () {
  var CTA = 'a[href="/start"]';
  var S = document.createElement('style');
  S.textContent = [
    '.tdo-bg{position:fixed;inset:0;background:rgba(16,18,26,.55);display:grid;place-items:center;z-index:1000000;padding:20px}',
    '.tdo{width:min(520px,100%);background:#fff;border-radius:16px;box-shadow:0 24px 60px rgba(16,18,26,.28);overflow:hidden;font:15px/1.55 system-ui,-apple-system,sans-serif;color:#10121a}',
    '.tdo-hd{display:flex;align-items:center;gap:10px;padding:18px 20px;border-bottom:1px solid #e4e7ee}',
    '.tdo-dots{display:flex;gap:6px;margin-left:auto}',
    '.tdo-dot{width:7px;height:7px;border-radius:50%;background:#dfe3ea}.tdo-dot.on{background:#1652f0}',
    '.tdo-x{border:0;background:none;font-size:20px;line-height:1;color:#767c8b;cursor:pointer;padding:0 2px}',
    '.tdo-bd{padding:22px 20px}',
    '.tdo h2{font-size:21px;margin:0 0 6px;letter-spacing:-.02em}',
    '.tdo p{margin:0 0 16px;color:#5b6070;font-size:14.5px}',
    '.tdo-code{font:24px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.22em;background:#f5f6f8;border:1px solid #e4e7ee;border-radius:10px;padding:16px;text-align:center;-webkit-user-select:all;user-select:all}',
    '.tdo-opts{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:0 0 16px}',
    '.tdo-opt{border:1px solid #e4e7ee;border-radius:11px;padding:12px 14px;cursor:pointer;font-weight:600;font-size:14px;background:#fff;text-align:left}',
    '.tdo-opt[aria-pressed="true"]{border-color:#1652f0;background:#eef3ff;color:#1652f0}',
    '.tdo-ft{display:flex;gap:10px;align-items:center;padding:16px 20px;border-top:1px solid #e4e7ee;background:#fafbfd}',
    '.tdo-btn{flex:1;border:0;border-radius:999px;padding:12px;font-weight:650;font-size:15px;cursor:pointer;background:#1652f0;color:#fff}',
    '.tdo-btn[disabled]{opacity:.45;cursor:default}',
    '.tdo-ghost{flex:none;background:#fff;border:1px solid #e4e7ee;color:#10121a;padding:12px 16px}',
    '.tdo-note{font-size:12.5px;color:#767c8b;margin:12px 0 0}',
    '.tdo-err{font-size:13px;color:#c3452f;margin:12px 0 0}',
    '@media(max-width:520px){.tdo-opts{grid-template-columns:1fr}}'
  ].join('');
  document.head.appendChild(S);

  var st = { step: 0, kind: null, dev: null, timer: null, me: null };
  var bg, box;

  function el(t, c, h) { var e = document.createElement(t); if (c) e.className = c; if (h != null) e.innerHTML = h; return e; }
  function api(p, body) {
    return fetch(p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
      .then(function (r) { return r.json().catch(function () { return {}; }); });
  }
  function close() { if (st.timer) clearInterval(st.timer); st.timer = null; if (bg) bg.remove(); bg = null; }

  function dots() {
    var d = el('div', 'tdo-dots');
    for (var i = 0; i < 3; i++) d.appendChild(el('span', 'tdo-dot' + (i <= st.step ? ' on' : '')));
    return d;
  }

  function shell(title, sub) {
    box.innerHTML = '';
    var hd = el('div', 'tdo-hd');
    hd.appendChild(el('strong', null, 'Get started'));
    hd.appendChild(dots());
    var x = el('button', 'tdo-x', '&times;');
    x.setAttribute('aria-label', 'Close'); x.onclick = close;
    hd.appendChild(x);
    var bd = el('div', 'tdo-bd');
    bd.appendChild(el('h2', null, title));
    if (sub) bd.appendChild(el('p', null, sub));
    box.appendChild(hd); box.appendChild(bd);
    return bd;
  }

  function footer(label, onClick, disabled) {
    var ft = el('div', 'tdo-ft');
    var b = el('button', 'tdo-btn', label);
    if (disabled) b.disabled = true;
    b.onclick = onClick;
    ft.appendChild(b); box.appendChild(ft);
    return b;
  }

  // ---- step 1: sign in -------------------------------------------------
  function stepAuth() {
    st.step = 0;
    var bd = shell('Sign in with GitHub', 'Once, so every comment you leave carries your name.');
    var wrap = el('div');
    bd.appendChild(wrap);
    wrap.innerHTML = '<p style="margin:0">Starting…</p>';
    api('/api/auth/device/start', {}).then(function (r) {
      if (r.error) { wrap.innerHTML = ''; wrap.appendChild(el('p', 'tdo-err', r.message || r.error)); return; }
      st.dev = r;
      wrap.innerHTML = '';
      wrap.appendChild(el('div', 'tdo-code', r.user_code));
      var n = el('p', 'tdo-note', 'Enter this code at <a href="' + r.verification_uri + '" target="_blank" rel="noopener">' + r.verification_uri.replace(/^https?:\/\//, '') + '</a>, then come back. This waits for you.');
      wrap.appendChild(n);
      var iv = Math.max(3, Number(r.interval) || 5) * 1000;
      st.timer = setInterval(function () {
        api('/api/auth/device/poll', { device_code: r.device_code }).then(function (p) {
          if (p && p.pending) return;
          clearInterval(st.timer); st.timer = null;
          if (p && p.error) { wrap.appendChild(el('p', 'tdo-err', p.message || p.error)); return; }
          st.me = p; stepPick();
        });
      }, iv);
    });
    footer('Waiting for GitHub…', function () {}, true);
  }

  // ---- step 2: what do you want ---------------------------------------
  var KINDS = [
    ['report', 'A report'], ['dashboard', 'A dashboard'],
    ['explainer', 'An explainer'], ['other', 'Something else']
  ];
  function stepPick() {
    st.step = 1;
    var bd = shell('What do you want to make?', 'Your agent writes it. You can change your mind later.');
    var g = el('div', 'tdo-opts');
    KINDS.forEach(function (k) {
      var b = el('button', 'tdo-opt', k[1]);
      b.setAttribute('aria-pressed', String(st.kind === k[0]));
      b.onclick = function () {
        st.kind = k[0];
        [].forEach.call(g.children, function (c) { c.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        next.disabled = false;
      };
      g.appendChild(b);
    });
    bd.appendChild(g);
    var next = footer('Create it', function () { stepCreate(); }, !st.kind);
  }

  // ---- step 3: create --------------------------------------------------
  function stepCreate() {
    st.step = 2;
    var bd = shell('Making your first doc…', 'This takes a few seconds.');
    var out = el('div'); bd.appendChild(out);
    api('/api/onboard/create', { kind: st.kind }).then(function (r) {
      if (r && r.url) {
        shell('It is live.', 'Share the link. Anyone with it can comment, and your agent answers.');
        var a = el('a', 'tdo-code', r.url);
        a.href = r.url; a.style.display = 'block'; a.style.textDecoration = 'none';
        box.querySelector('.tdo-bd').appendChild(a);
        footer('Open it', function () { location.href = r.url; });
        return;
      }
      out.appendChild(el('p', 'tdo-err',
        (r && (r.message || r.error)) || 'Could not create it from here yet.'));
      out.appendChild(el('p', 'tdo-note',
        'You can still do this from your agent: say “make me ' +
        (st.kind === 'other' ? 'a page' : 'a ' + st.kind) + ' and publish it”.'));
      footer('Read the steps', function () { location.href = '/start'; });
    });
  }

  function open(e) {
    if (e) e.preventDefault();
    bg = el('div', 'tdo-bg');
    box = el('div', 'tdo');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    bg.appendChild(box);
    bg.addEventListener('click', function (ev) { if (ev.target === bg) close(); });
    document.addEventListener('keydown', function esc(ev) {
      if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
    });
    document.body.appendChild(bg);
    api('/api/auth/me').then(function (me) {
      if (me && me.login) { st.me = me; stepPick(); } else { stepAuth(); }
    });
  }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest(CTA);
    if (a) open(e);
  });
})();
