#!/usr/bin/env node
// Weekly agent reply metrics: how long agents take with handed-off comments.
//
// Per agent kind × delivery channel, per ISO week (the week the handoff was
// created, UTC): handoffs, median and p90 seconds from delivered to picked
// up, to first reply and to new version (a version or suggestions, whichever
// came first), and the share with no agent reply 24 hours after the handoff.
// A handoff younger than 24 hours is not counted in that share.
//
// Two inputs, either or both (records are merged by handoff_id):
//
//  1. agent_timing log lines (worker/worker.js, server/agent-timing.js).
//     Anything with one JSON object per line works: a saved `wrangler tail`,
//     a Workers Logs / Logpush export. Lines that are not agent_timing are
//     skipped, so a raw tail is fine:
//       npx wrangler tail --format json --search agent_timing > tail.jsonl
//       node scripts/agent-metrics.mjs --logs tail.jsonl
//     (The tail only sees what happens while it runs; for history use 2.)
//
//  2. The stored handoff records (KV META `handoffs:<slug>`), which keep
//     every milestone's timestamp, so a handoff nobody ever answered still
//     counts. Export them, then point the script at the file:
//       npx wrangler kv key list --binding META --prefix handoffs: --remote > keys.json
//       node -e 'for (const k of require("./keys.json")) console.log(k.name)' \
//         | while read k; do printf '%s\t' "$k"; npx wrangler kv key get --binding META --remote "$k"; echo; done > handoffs.tsv
//       node scripts/agent-metrics.mjs --kv handoffs.tsv
//     Each line of handoffs.tsv is `<key>\t<JSON list>` (or just the JSON
//     list). Only timestamps, kinds and counts are read from it; the
//     comment ids, instruction and recipient never reach the output.
//
// Options: --weeks N (default 8, newest first), --json (rows as JSON),
// --now <ISO> (for tests).
//
// Run with: node scripts/agent-metrics.mjs [--logs FILE]... [--kv FILE]...

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const AgentTiming = require('../server/agent-timing.js');

const DAY_S = 24 * 3600;
const MILESTONES = ['delivered', 'picked_up', 'first_reply', 'suggested', 'new_version'];

// One handoff's facts: kinds, created time (ms) and each milestone's offset
// in seconds since it was created.
function blank(id) {
  return { handoff_id: id, created_ms: null, channel: 'none', agent: 'none', doc_kind: 'unknown', delivery: null, s: {}, outcome: null };
}
function setMin(h, k, v) {
  if (v == null || !Number.isFinite(Number(v))) return;
  const n = Number(v);
  if (h.s[k] == null || n < h.s[k]) h.s[k] = n;
}

function parseJsonLoose(line) {
  const at = line.indexOf('{');
  if (at === -1) return null;
  try { return JSON.parse(line.slice(at)); } catch { return null; }
}
// A wrangler tail JSON event carries the line in logs[].message[]; a plain
// line is the record itself.
function* agentTimingRecords(obj) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.event === AgentTiming.EVENT) { yield obj; return; }
  const logs = Array.isArray(obj.logs) ? obj.logs : [];
  for (const l of logs) {
    for (const m of Array.isArray(l && l.message) ? l.message : [l && l.message]) {
      const r = typeof m === 'string' ? parseJsonLoose(m) : m;
      if (r && r.event === AgentTiming.EVENT) yield r;
    }
  }
  // Logpush / Workers Logs exports: the message under a field.
  for (const k of ['message', '$metadata']) {
    const v = obj[k];
    const r = typeof v === 'string' ? parseJsonLoose(v) : null;
    if (r && r.event === AgentTiming.EVENT) yield r;
  }
}

export function fromLogLines(text, into = new Map(), { tailTimes = true } = {}) {
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.includes(AgentTiming.EVENT)) continue;
    const obj = parseJsonLoose(line);
    const eventMs = obj && Number(obj.eventTimestamp);
    for (const r of agentTimingRecords(obj)) {
      if (!r.handoff_id) continue;
      const h = into.get(r.handoff_id) || blank(r.handoff_id);
      if (r.channel) h.channel = r.channel;
      if (r.agent) h.agent = r.agent;
      if (r.doc_kind && r.doc_kind !== 'unknown') h.doc_kind = r.doc_kind;
      // The created time: the id is `h_<ms>_…`, minted when it was.
      const idMs = Number((/^h_(\d{10,})_/.exec(r.handoff_id) || [])[1]);
      if (h.created_ms == null && Number.isFinite(idMs)) h.created_ms = idMs;
      else if (h.created_ms == null && tailTimes && Number.isFinite(eventMs) && r.since_s != null) h.created_ms = eventMs - r.since_s * 1000;
      if (r.milestone === 'delivered') {
        if (r.status !== 'failed') setMin(h, 'delivered', r.since_s);
        if (!h.delivery || r.status !== 'failed') h.delivery = r.status;
      } else if (r.milestone === 'outcome') {
        h.outcome = r.outcome || h.outcome;
        for (const k of MILESTONES) setMin(h, k, r[`${k}_s`]);
      } else if (MILESTONES.includes(r.milestone)) {
        setMin(h, r.milestone, r.since_s);
      }
      into.set(r.handoff_id, h);
    }
  }
  return into;
}

// The stored records (handoffs:<slug> lists). Reads only times and kinds,
// through the same record() the worker logs with.
export function fromKvExport(text, into = new Map()) {
  for (const line of String(text).split(/\r?\n/)) {
    const at = line.indexOf('[');
    if (at === -1) continue;
    let list;
    try { list = JSON.parse(line.slice(at)); } catch { continue; }
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!raw || typeof raw !== 'object' || !raw.handoff_id) continue;
      const created = Date.parse(raw.at || '');
      const rec = AgentTiming.record(raw, 'outcome', { now: created });
      if (!rec || !rec.handoff_id) continue;
      const h = into.get(rec.handoff_id) || blank(rec.handoff_id);
      h.channel = rec.channel; h.agent = rec.agent;
      if (rec.doc_kind !== 'unknown') h.doc_kind = rec.doc_kind;
      if (Number.isFinite(created)) h.created_ms = created;
      h.delivery = raw.delivery && raw.delivery.status ? String(raw.delivery.status) : h.delivery;
      h.outcome = typeof raw.outcome === 'string' ? raw.outcome : h.outcome;
      for (const k of MILESTONES) setMin(h, k, rec[`${k}_s`]);
      into.set(rec.handoff_id, h);
    }
  }
  return into;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  // Nearest rank: p90 of 10 values is the 9th.
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[i];
}
export function isoWeek(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  const thu = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const jan4 = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thu - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Rows: one per week × agent × channel.
export function summarize(handoffs, { now = Date.now(), weeks = 8 } = {}) {
  const groups = new Map();
  for (const h of handoffs.values()) {
    if (h.created_ms == null) continue;
    const key = `${isoWeek(h.created_ms)}\t${h.agent}\t${h.channel}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  const rows = [];
  for (const [key, list] of groups) {
    const [week, agent, channel] = key.split('\t');
    // Each time from delivered (or from created when the delivered time is
    // unknown, as for a handoff sent before delivery was timed).
    const span = (h, k) => {
      const end = k === 'new_version'
        ? [h.s.new_version, h.s.suggested].filter((v) => v != null).sort((a, b) => a - b)[0]
        : h.s[k];
      if (end == null) return null;
      return Math.max(0, end - (h.s.delivered != null ? h.s.delivered : 0));
    };
    const stat = (k) => {
      const v = list.map((h) => span(h, k)).filter((x) => x != null).sort((a, b) => a - b);
      return { n: v.length, median: quantile(v, 0.5), p90: quantile(v, 0.9) };
    };
    const old = list.filter((h) => now - h.created_ms >= DAY_S * 1000);
    const noReply = old.filter((h) => h.s.first_reply == null || h.s.first_reply > DAY_S);
    rows.push({
      week, agent, channel,
      count: list.length,
      failed: list.filter((h) => h.delivery === 'failed' && h.s.delivered == null).length,
      picked_up: stat('picked_up'),
      first_reply: stat('first_reply'),
      new_version: stat('new_version'),
      no_reply_24h: old.length ? Math.round((1000 * noReply.length) / old.length) / 10 : null,
      no_reply_24h_of: old.length,
    });
  }
  const keepWeeks = [...new Set(rows.map((r) => r.week))].sort().reverse().slice(0, weeks);
  return rows
    .filter((r) => keepWeeks.includes(r.week))
    .sort((a, b) => b.week.localeCompare(a.week) || b.count - a.count || a.agent.localeCompare(b.agent) || a.channel.localeCompare(b.channel));
}

function dur(s) {
  if (s == null) return '-';
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 90 * 60) return `${Math.round(s / 6) / 10}m`;
  return `${Math.round(s / 360) / 10}h`;
}
export function formatTable(rows) {
  const head = ['week', 'agent', 'channel', 'n', 'failed', 'pickup p50', 'p90', 'reply p50', 'p90', 'version p50', 'p90', 'no reply 24h'];
  const body = rows.map((r) => [
    r.week, r.agent, r.channel, String(r.count), String(r.failed),
    dur(r.picked_up.median), dur(r.picked_up.p90),
    dur(r.first_reply.median), dur(r.first_reply.p90),
    dur(r.new_version.median), dur(r.new_version.p90),
    r.no_reply_24h == null ? '-' : `${r.no_reply_24h}% of ${r.no_reply_24h_of}`,
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells) => cells.map((c, i) => (i < 3 ? c.padEnd(w[i]) : c.padStart(w[i]))).join('  ');
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...body.map(line)].join('\n');
}

function main(argv) {
  const logs = []; const kv = []; let weeks = 8; let asJson = false; let now = Date.now();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--logs') logs.push(argv[++i]);
    else if (a === '--kv') kv.push(argv[++i]);
    else if (a === '--weeks') weeks = Math.max(1, Number(argv[++i]) || 8);
    else if (a === '--json') asJson = true;
    else if (a === '--now') now = Date.parse(argv[++i]);
    else if (a === '-h' || a === '--help') { console.log('usage: node scripts/agent-metrics.mjs [--logs FILE]... [--kv FILE]... [--weeks N] [--json]'); return 0; }
    else { console.error(`unknown argument: ${a}`); return 2; }
  }
  if (!logs.length && !kv.length) { console.error('pass --logs FILE and/or --kv FILE (see the header of this script)'); return 2; }
  const all = new Map();
  for (const f of kv) fromKvExport(fs.readFileSync(f, 'utf8'), all);
  for (const f of logs) fromLogLines(fs.readFileSync(f, 'utf8'), all);
  const rows = summarize(all, { now, weeks });
  console.log(asJson ? JSON.stringify(rows, null, 2) : (rows.length ? formatTable(rows) : 'no handoffs found'));
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
