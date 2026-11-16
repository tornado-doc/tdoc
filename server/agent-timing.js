// How long agents take with handed-off comments, as one structured log line
// per handoff milestone, so reply times can be benched from `wrangler tail`
// (and scripts/agent-metrics.mjs) without a dashboard. Same style as
// ai_timing (server/ai-timing.js):
//
//   {"event":"agent_timing","milestone":"picked_up","handoff_id":"h_…",
//    "channel":"raft","agent":"raft_agent","cli":null,"doc_kind":"doc",
//    "reply_as":null,"comments":2,"since_s":41.3,"via":"mcp_poll"}
//
// Milestones (seconds since the handoff was created, `since_s`):
//   delivered    the push was sent / queued (status: delivered | queued |
//                failed, with a short error code); resend: true on a Resend
//   picked_up    the agent said it is on it (via: ack | pull | mcp_poll)
//   first_reply  the first agent reply on one of the handed comments
//   suggested    the first suggestions (propose_edits) for those comments
//   new_version  the first version the handed-to agent published
//   outcome      how it ended (outcome: resolved | run_failed |
//                access_lost), with every milestone's offset so far
//
// What it never carries: comment text, the instruction, the doc, a slug, a
// title, an agent's name or handle, a server id, a webhook URL, an email or
// an account. Only the opaque handoff id (`h_<ms>_<random>`, minted by
// tdoc), fixed-vocabulary tokens, counts and seconds.
//
// Shared by the worker (inlined by bin/tdoc-bundle at __TDOC_AGENT_TIMING__)
// and Node tests (require).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TdocAgentTiming = factory();
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  var EVENT = 'agent_timing';
  var MILESTONES = ['delivered', 'picked_up', 'first_reply', 'suggested', 'new_version', 'outcome'];
  var CHANNELS = ['raft', 'webhook', 'local'];
  var VIAS = ['ack', 'pull', 'mcp_poll'];
  var OUTCOMES = ['resolved', 'run_failed', 'access_lost'];
  var DOC_KINDS = ['doc', 'sheet', 'slides', 'feedback'];
  var STATUSES = ['delivered', 'queued', 'failed'];
  // Where each milestone's time lives on the stored handoff record.
  var STORED = {
    delivered: function (h) { return h.delivery && h.delivery.first_at; },
    picked_up: function (h) { return h.acked_at; },
    first_reply: function (h) { return h.first_reply_at; },
    suggested: function (h) { return h.first_suggested_at || h.suggested_at; },
    new_version: function (h) { return h.first_version_at; },
  };

  function oneOf(v, list, fallback) { return list.indexOf(v) !== -1 ? v : fallback; }
  // A short lowercase token (a CLI name, an error code) or null: anything
  // that is not one is dropped rather than cleaned, so free text never lands.
  function token(v, n) {
    var s = String(v == null ? '' : v).toLowerCase();
    return /^[a-z0-9_.-]+$/.test(s) && s.length <= n ? s : null;
  }
  function count(v) { var n = Number(v); return n >= 0 ? Math.floor(n) : 0; }
  function seconds(fromIso, toMs) {
    var a = Date.parse(fromIso || '');
    if (!isFinite(a) || !isFinite(toMs)) return null;
    return Math.max(0, Math.round((toMs - a) / 100) / 10);
  }
  function opaqueId(v) {
    var s = String(v == null ? '' : v);
    return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
  }

  // The delivery path the handoff took: the notify provider, or none.
  function channelOf(h) {
    var p = h && h.recipient && h.recipient.provider;
    return oneOf(p, CHANNELS, 'none');
  }
  // The kind of agent, never which one: a team's agent, a local CLI (its
  // name, from the daemon's fixed list), a Raft agent or a webhook.
  function agentOf(h) {
    if (h && h.team_agent) return 'team_agent';
    var c = channelOf(h);
    if (c === 'local') return 'local_cli';
    if (c === 'raft') return 'raft_agent';
    if (c === 'webhook') return 'webhook';
    return 'none';
  }
  // doc | sheet | slides | feedback from a doc's meta (docType: the stamped
  // type, '' when unknown).
  function docKind(meta, docType) {
    if (meta && meta.created_from === 'feedback') return 'feedback';
    return oneOf(docType, DOC_KINDS, 'doc');
  }

  // The record for one milestone of handoff `h`. opts: { now (ms), via,
  // outcome, resend, resolved }. Nothing from `h` reaches the line except
  // through the coercions here.
  function record(h, milestone, opts) {
    var o = opts || {};
    var hh = h || {};
    var nowMs = o.now != null ? Number(o.now) : Date.now();
    var m = oneOf(milestone, MILESTONES, null);
    if (!m) return null;
    var rec = {
      event: EVENT,
      milestone: m,
      handoff_id: opaqueId(hh.handoff_id),
      channel: channelOf(hh),
      agent: agentOf(hh),
      cli: channelOf(hh) === 'local' && hh.recipient ? token(hh.recipient.cli, 24) : null,
      doc_kind: oneOf(hh.doc_kind, DOC_KINDS, 'unknown'),
      reply_as: hh.reply_as === 'suggestions' ? 'suggestions' : null,
      comments: count(Array.isArray(hh.comment_ids) ? hh.comment_ids.length : 0),
      since_s: seconds(hh.at, nowMs),
    };
    if (m === 'delivered') {
      var d = hh.delivery || {};
      rec.status = oneOf(d.status, STATUSES, 'failed');
      rec.error = rec.status === 'failed' ? (token(d.error, 40) || 'error') : null;
      rec.resend = Boolean(o.resend);
    }
    if (m === 'picked_up') rec.via = oneOf(o.via, VIAS, null);
    if (m === 'outcome') {
      rec.outcome = oneOf(o.outcome, OUTCOMES, null);
      var ids = Array.isArray(hh.comment_ids) ? hh.comment_ids : [];
      var done = Array.isArray(hh.resolved_ids) ? hh.resolved_ids : [];
      rec.resolved = count(ids.filter(function (id) { return done.indexOf(id) !== -1; }).length);
      var t0 = Date.parse(hh.at || '');
      Object.keys(STORED).forEach(function (k) {
        var at = Date.parse(STORED[k](hh) || '');
        rec[k + '_s'] = isFinite(t0) && isFinite(at) ? Math.max(0, Math.round((at - t0) / 100) / 10) : null;
      });
    }
    return rec;
  }

  // Log one milestone line; returns the record. `log` is for tests.
  function emit(h, milestone, opts) {
    var o = opts || {};
    var rec = record(h, milestone, o);
    if (!rec) return null;
    var log = typeof o.log === 'function' ? o.log : function (line) { console.log(line); };
    try { log(JSON.stringify(rec)); } catch (e) {}
    return rec;
  }

  return {
    EVENT: EVENT, MILESTONES: MILESTONES, CHANNELS: CHANNELS, OUTCOMES: OUTCOMES,
    record: record, emit: emit, channelOf: channelOf, agentOf: agentOf, docKind: docKind,
  };
});
