// The homepage demo's agents (config.demoComments): the real composer, @
// list, agent pill, handoff status line and Ask AI panel, with nothing sent
// anywhere. This is the data layer only. The shell keeps its real flows
// (askOn, askPrivately, editOn, makePublic, Ask AI's Ask and Send / Edit)
// and, on the demo, calls this backend instead of the three write endpoints
// they use: /api/docs/<slug>/hand-off, /api/docs/<slug>/<kind>/publish and
// /api/notify/handoff. Answers are canned and arrive after a short delay; the
// comments live in the demo comments store (use-comments.js, `demo`), so a
// refresh clears them like any other demo comment.

import { TDOC_AI } from './ai-answerer.js';

// One agent that may "edit" (it answers, and says it would edit), shown with
// the Claude mark: a local agent whose program is claude.
export const DEMO_AGENT = Object.freeze({
  kind: 'agent',
  provider: 'local',
  cli: 'claude',
  server_id: 'tdoc-demo',
  agent_sub: 'tdoc-demo-claude',
  agent_name: 'Claude (demo)',
  handle: 'Claude (demo)',
  status: 'active',
  demo: true,
});

// The composer's @ list on the demo: Claude (demo) may edit, tdoc AI answers.
export const DEMO_AGENT_CHOICES = Object.freeze([
  Object.freeze({ ...DEMO_AGENT, can_edit: true }),
  Object.freeze({ ...TDOC_AI, can_edit: false }),
]);

export const DEMO_ANSWER = 'Demo answer: tdoc turns the HTML your agent writes into a doc people can comment on. '
  + 'Select any passage and comment; name an agent with @ and it answers in the thread, or edits the doc and publishes '
  + 'a new version you can compare. Sign in and connect your own agent to get real answers about your own docs.';

export const DEMO_EDIT_REPLY = 'Demo reply: on your own doc I would make this change and publish a new version, and this '
  + 'reply would link to the diff. This is the homepage demo, so nothing was edited or sent anywhere.';

// How long each step takes: delivered → on it → the reply.
export const DEMO_DELAYS = Object.freeze({ answer: 900, ack: 1200, reply: 3200 });

const wordCount = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;
const sameWords = (a, b) => String(a || '').replace(/\s+/g, ' ').trim().toLowerCase()
  === String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();

// The homepage's scripted Edit, per landing doc (flag demoEditRewrite). Ask
// AI's Edit opens with `prompt` in the input; sending it (unchanged) hands it
// to Claude (demo) as usual, and once Claude (demo) is on it the frame
// rewrites the paragraph `before` into `after` (frame-probe.js
// tdoc:demoRewrite) before the reply arrives. A different instruction gets
// the plain demo reply: the demo never pretends to have done what it can't.
function scriptedRewrite({ prompt, before, after }) {
  return Object.freeze({
    prompt,
    before,
    after,
    reply: `Done: that paragraph is ${wordCount(after)} words now, down from ${wordCount(before)}, and opens with the point. `
      + 'On your own doc this publishes a new version and links the diff here. This demo changed only your screen.',
  });
}
export const DEMO_REWRITES = Object.freeze({
  'tornado-doc': scriptedRewrite({
    prompt: 'Make the paragraph under "Many people, many agents" shorter and punchier.',
    before: 'Anyone with the link can comment: your team, your reviewers, and their own AIs. '
      + 'Every agent answers in its own name, so one page holds the whole review.',
    after: 'One link, one page: your team, your reviewers and their AIs all comment, each agent in its own name.',
  }),
});

function demoId(prefix) {
  return `demo_${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The reply's author, as the server stamps an agent reply.
export function demoAgentAuthor(target) {
  if (target && target.tdoc_ai) {
    return { kind: 'agent', login: 'tdoc-ai', handle: 'tdoc AI', name: 'tdoc AI', provider: 'tdoc', tdoc_ai: true };
  }
  return { kind: 'agent', login: 'claude-demo', handle: DEMO_AGENT.handle, name: DEMO_AGENT.handle, provider: 'local', cli: 'claude' };
}

// `update(fn)` replaces the demo comment list (useComments' demoUpdate);
// `delays` is DEMO_DELAYS unless a test pins it. `rewrite`: this doc's
// DEMO_REWRITES entry plus `play()` (the frame's rewrite; resolves true once
// it has run) and `onDone(ok)`, or null.
export function createDemoBackend({ update, delays = DEMO_DELAYS, rewrite: script = null }) {
  // Private answers by ask id, for Make public / Post as comment.
  const answers = new Map();
  const timers = new Set();
  // Comments whose text is the scripted prompt (Edit with only the prompt
  // posts it as a whole-document comment first; see markScripted).
  const scripted = new Set();
  let disposed = false;
  const later = (ms, fn) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
  };
  const rootOf = (list, id) => list.find((c) => c.id === id || (c.replies || []).some((r) => r.id === id));
  const patchRoot = (id, fn) => update((list) => {
    const root = rootOf(list, id);
    return root ? list.map((c) => (c === root ? fn(c) : c)) : list;
  });
  const reply = (id, target, text) => patchRoot(id, (c) => ({
    ...c,
    replies: [...(c.replies || []), {
      id: demoId('reply'),
      text,
      author: demoAgentAuthor(target),
      created: new Date().toISOString(),
      parent_id: id,
      agent_status: 'answered',
    }],
  }));
  // A handoff as the real one goes: delivered, then the agent is on it, then
  // its reply.
  const startHandoff = (ids, recipient, scriptedRun = false) => {
    const at = new Date().toISOString();
    for (const id of ids) {
      patchRoot(id, (c) => ({
        ...c,
        handoff_status: 'sent',
        handoff_to: recipient,
        handoff_at: at,
        handoff_id: demoId('handoff'),
        handoff_delivery: { status: 'delivered', at },
        handoff_acked_at: null,
        handoff_resend_allowed: false,
      }));
      later(delays.ack, () => patchRoot(id, (c) => ({ ...c, handoff_acked_at: new Date().toISOString() })));
      if (!scriptedRun) later(delays.reply, () => reply(id, recipient, DEMO_EDIT_REPLY));
    }
    // The scripted Edit: once the agent is on it, the doc changes in front
    // of the visitor; the reply lands when the change has.
    if (scriptedRun) {
      later(delays.ack, async () => {
        let ok = false;
        try { ok = Boolean(await script.play()); } catch { ok = false; }
        if (disposed) return;
        for (const id of ids) reply(id, recipient, ok ? script.reply : DEMO_EDIT_REPLY);
        script.onDone?.(ok);
      });
    }
  };
  return {
    // POST /api/docs/<slug>/hand-off
    async handOff(_slug, payload = {}) {
      const target = payload.recipient && payload.recipient.tdoc_ai ? TDOC_AI : (payload.recipient || DEMO_AGENT);
      if (payload.ask_only && payload.only_me) {
        await wait(delays.answer);
        const askId = demoId('ask');
        answers.set(askId, DEMO_ANSWER);
        return { ok: true, ask_id: askId, answer: DEMO_ANSWER };
      }
      if (payload.ask_only) {
        await wait(delays.answer);
        if (payload.comment_id) reply(payload.comment_id, target, DEMO_ANSWER);
        return { ok: true };
      }
      if (payload.comment_id) startHandoff([payload.comment_id], target);
      return { ok: true, sent: 1, delivery: { status: 'delivered', at: new Date().toISOString() } };
    },
    // POST /api/docs/<slug>/<kind>/publish
    async publishAsk(_slug, kind, { askId, commentId }) {
      const text = answers.get(askId) || DEMO_ANSWER;
      reply(commentId, kind === 'ask' ? TDOC_AI : DEMO_AGENT, text);
      return { ok: true };
    },
    // The comment Edit posted for an instruction-only send: if its text is
    // the scripted prompt, its handoff plays the rewrite.
    markScripted(id, text) {
      if (script && id && sameWords(text, script.prompt)) scripted.add(id);
    },
    // POST /api/notify/handoff (Ask AI's Send to agent / Edit)
    async postNotifyHandoff({ comment_ids: ids = [], recipient, instruction = '' }) {
      const run = Boolean(script) && (sameWords(instruction, script.prompt) || ids.some((id) => scripted.has(id)));
      startHandoff(ids, recipient || DEMO_AGENT, run);
      return { ok: true, sent: ids.length, delivery: { status: 'delivered', at: new Date().toISOString() } };
    },
    dispose() {
      disposed = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
    },
  };
}
