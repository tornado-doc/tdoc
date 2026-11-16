// Response time of one tdoc AI call (Ask answer, Ask edit, Write with tdoc
// AI), as one structured log line, so the routes can be benched from
// `wrangler tail` without a dashboard:
//
//   {"event":"ai_timing","route":"ask_answer","model":"…","stream":false,
//    "ok":true,"status":200,"error":null,"attempts":1,
//    "upstream_headers_ms":812,"first_token_ms":null,"total_ms":2950,
//    "out_chars":1234}
//
// Marks are milliseconds since start: upstream_headers (the model endpoint
// answered with headers), first_token (the first piece of text, streaming
// only), done (total_ms). A retried attempt starts its marks over, so they
// describe the attempt that answered; `attempts` counts them.
//
// What it never carries: the prompt, the doc, the answer, a slug, an account
// or a session. Only the route name, the model id, sizes, times and a short
// error code from a fixed list (an upstream's own error message is dropped:
// it may quote the request).
//
// Shared by the worker (inlined by bin/tdoc-bundle at __TDOC_AI_TIMING__)
// and Node tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TdocAiTiming = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  var EVENT = 'ai_timing';
  var MARKS = ['upstream_headers', 'first_token'];
  var ERRORS = ['timeout', 'network', 'empty', 'client_gone', 'stream', 'stream_error', 'create_failed', 'reply_failed'];

  function errorCode(detail, status) {
    var d = String(detail == null ? '' : detail);
    if (ERRORS.indexOf(d) !== -1) return d;
    if (/^http_\d{3}$/.test(d)) return d;
    var s = Number(status);
    return s > 0 ? 'http_' + Math.floor(s) : 'error';
  }

  function short(s, n) {
    var t = String(s == null ? '' : s).replace(/[^\w.:\/@+-]/g, '').slice(0, n);
    return t || null;
  }

  // start(route, { model, stream, now, log }) -> a timer.
  //   now: a clock in ms (default Date.now); log: where the line goes
  //   (default console.log). Both are for tests.
  function start(route, opts) {
    var o = opts || {};
    var now = typeof o.now === 'function' ? o.now : function () { return Date.now(); };
    var log = typeof o.log === 'function' ? o.log : function (line) { console.log(line); };
    var t0 = now();
    var marks = {};
    var attempts = 0;
    var finished = null;
    var timer = {
      // An attempt at the model began (each retry is one more). A retry
      // starts over: its headers and first token are its own.
      attempt: function () { if (!finished) { attempts++; marks = {}; } return timer; },
      mark: function (name) {
        if (finished || MARKS.indexOf(name) === -1) return timer;
        // first_token is the first text of the attempt that answered: a
        // later piece does not move it.
        if (name === 'first_token' && marks.first_token != null) return timer;
        marks[name] = Math.max(0, now() - t0);
        return timer;
      },
      // done({ ok, status, detail, chars }) -> the record, logged once.
      done: function (r) {
        if (finished) return finished;
        var res = r || {};
        var ok = Boolean(res.ok);
        finished = {
          event: EVENT,
          route: short(route, 40) || 'unknown',
          model: short(o.model, 120),
          stream: Boolean(o.stream),
          ok: ok,
          status: ok ? 200 : (Number(res.status) > 0 ? Math.floor(Number(res.status)) : null),
          error: ok ? null : errorCode(res.detail, res.status),
          attempts: attempts,
          upstream_headers_ms: marks.upstream_headers != null ? marks.upstream_headers : null,
          first_token_ms: marks.first_token != null ? marks.first_token : null,
          total_ms: Math.max(0, now() - t0),
          out_chars: Number(res.chars) >= 0 ? Math.floor(Number(res.chars)) : 0,
        };
        try { log(JSON.stringify(finished)); } catch (e) {}
        return finished;
      },
    };
    return timer;
  }

  // A timer that records nothing: callers pass it where no timing is wanted,
  // so the model code never checks for one.
  var none = { attempt: function () { return none; }, mark: function () { return none; }, done: function () { return null; } };

  return { start: start, none: none, EVENT: EVENT };
});
