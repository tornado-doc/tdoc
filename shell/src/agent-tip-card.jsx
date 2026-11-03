import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Infinity as Loop, Play, Sparkles, X } from 'lucide-react';
import { AppButton } from './ui/button.jsx';
import { CodeBlock } from './ui/code-block.jsx';
import { listNotifications } from './document/api.js';
import { readStored, writeStored } from './safe-storage.js';

// The agent tip (docs/design/agent-model.md, "Tip card"): a card that floats
// bottom-left, like an editor's "Now available" card, inviting people to have
// comments sent to their agent automatically. It shows when a doc the person
// owns got a comment from someone else and no agent of theirs gets comments
// yet; at most once a session, 5 s after the page opens. Close folds it to a
// pill for the session; after two closes it stops coming back on its own.

const DISMISS_KEY = 'tdoc.agentTip.dismissals';
function sessionGet(key) { try { return sessionStorage.getItem(key); } catch { return null; } }
function sessionSet(key, value) { try { sessionStorage.setItem(key, value); } catch { /* no storage: shows again next visit */ } }
const SEEN_KEY = 'tdoc.agentTip.shown';
const DELAY_MS = 5000;
const SCENE_MS = 2600;
const AGENTS_PAGE = '/me?view=settings#agents';
// What the person pastes into their agent: short, since the tdoc skill
// already knows the rest (Linux, login start-up).
export const TURN_ON_PROMPT = 'Use the tdoc skill to run bin/tdoc-daemon install';

const ROW_ICONS = [Sparkles, Loop, Play];

// One entry per kind of person. `agent` is the name the card uses for their
// agent: the CLI they paired from this account, or Claude Code by default.
export function tipCopy(kind, agent = 'Claude Code') {
  if (kind === 'local') {
    return {
      title: `Auto-send comments to ${agent}`,
      rows: [
        ['Comments go straight to your agent', `${agent} revises the doc and replies.`],
        ['Works with the chat closed', 'A small helper on your computer picks them up.'],
        ['Every change is visible', 'A new version, with a reply on each comment.'],
      ],
      cta: 'Turn on',
    };
  }
  return {
    title: 'Auto-send comments to your agent',
    rows: [
      ['Comments go straight to your agent', 'No more copying them into a chat.'],
      ['Needs an agent on your computer', 'Claude Code or Codex, not claude.ai.'],
      ['Every change is visible', 'A new version, with a reply on each comment.'],
    ],
    cta: 'Set up Claude Code',
  };
}

async function getJson(path) {
  const r = await fetch(path, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

// Who this person is for the tip, or null when it should not show: they
// already have an agent that gets comments, or nobody else has commented yet.
export async function tipAudience() {
  const connectors = await getJson('/api/me/connectors');
  if ((connectors.connectors || []).length) return null;
  const page = await listNotifications(0);
  if (!(page.items || []).some((item) => item.kind === 'comment')) return null;
  let paired = null;
  try {
    const t = await getJson('/api/me/tokens');
    paired = (t.tokens || []).find((tok) => tok.device) || null;
  } catch { /* no token list: treat as not paired */ }
  const agent = paired && /codex/i.test(paired.client || '') ? 'Codex' : 'Claude Code';
  return paired ? { kind: 'local', agent, device: paired.device } : { kind: 'hosted', agent: 'Claude Code' };
}

function dismissals() {
  return Number(readStored(DISMISS_KEY)) || 0;
}

// The looping product window in the hero: a comment handed to the agent,
// the agent revising, the new version with a reply.
function Hero({ scene, agent, onClose }) {
  return (
    <div className="tdoc-tip-hero">
      <AppButton variant="icon" size="s" className="tdoc-tip-close" aria-label="Close" onClick={onClose}><X size={13} /></AppButton>
      <div className="tdoc-tip-win" aria-hidden="true">
        <div className={`tdoc-tip-scene${scene === 0 ? ' is-on' : ''}`}>
          <div className="tdoc-tip-bar"><i /><i /><i /> tdoc.dev/d/q4-plan</div>
          <div className="tdoc-tip-q"><b>Maya</b> · 10:24 AM<br /><span className="tdoc-tip-at">@agent</span> tighten the pricing section and add the EU numbers</div>
          <div className="tdoc-tip-st">Sent to {agent} automatically</div>
        </div>
        <div className={`tdoc-tip-scene${scene === 1 ? ' is-on' : ''}`}>
          <div className="tdoc-tip-bar"><i /><i /><i /> {agent}</div>
          <div className="tdoc-tip-q">Picked up 1 comment on <b>Q4 plan</b></div>
          <div className="tdoc-tip-st"><span className="tdoc-tip-spin" />Revising…</div>
        </div>
        <div className={`tdoc-tip-scene${scene === 2 ? ' is-on' : ''}`}>
          <div className="tdoc-tip-bar"><i /><i /><i /> Q4 plan · v4</div>
          <div className="tdoc-tip-q"><b>{agent}</b><br />Tightened pricing, added EU figures. <span className="tdoc-tip-ok">Resolved ✓</span></div>
          <div className="tdoc-tip-st">v3 → v4 · replied to 1 comment</div>
        </div>
      </div>
    </div>
  );
}

// The card itself, given who it is for. `onClose` folds it; the parent keeps
// the session and dismissal bookkeeping.
export function AgentTipCard({ audience, onClose }) {
  const copy = tipCopy(audience.kind, audience.agent);
  const [scene, setScene] = useState(0);
  const [held, setHeld] = useState(false);
  const [step, setStep] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (held || step) return undefined;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const id = setInterval(() => setScene((s) => (s + 1) % 3), SCENE_MS);
    return () => clearInterval(id);
  }, [held, step]);

  // After Turn on: watch for the computer to check in, then say so and fold.
  useEffect(() => {
    if (!step || audience.kind !== 'local') return undefined;
    let stop = false;
    const poll = async () => {
      try {
        const b = await getJson('/api/me/connectors');
        if ((b.connectors || []).some((c) => c.kind === 'local' && c.last_seen)) { setReady(true); return; }
      } catch { /* keep waiting */ }
      if (!stop) setTimeout(poll, 4000);
    };
    poll();
    return () => { stop = true; };
  }, [step, audience.kind]);
  useEffect(() => {
    if (!ready) return undefined;
    const id = setTimeout(() => onClose({ done: true }), 3000);
    return () => clearTimeout(id);
  }, [ready, onClose]);

  const act = () => {
    if (audience.kind === 'local') { setStep(true); return; }
    window.location.href = '/start';
  };

  return (
    <div className="tdoc-tip" role="dialog" aria-label={copy.title}>
      <Hero scene={scene} agent={audience.agent} onClose={() => onClose({})} />
      {/* One body for both views: the intro and the Turn on step sit in the
          same grid cell, so the card keeps the size of the taller one and
          only what is inside changes. The view not shown is hidden from
          sight, focus and screen readers. */}
      <div className="tdoc-tip-body">
        <div className="tdoc-tip-pane" aria-hidden={step} inert={step}>
          <p className="tdoc-tip-eyebrow">New for your agents</p>
          <p className="tdoc-tip-title">{copy.title}</p>
          <ul className="tdoc-tip-rows">
            {copy.rows.map(([title, text], i) => {
              const Icon = ROW_ICONS[i];
              return (
                <li key={title} className={i === scene ? '' : 'is-dim'} onMouseEnter={() => { setHeld(true); setScene(i); }}>
                  <Icon size={15} aria-hidden="true" />
                  <span><b className="tdoc-tip-row-title">{title}</b><span>{text}</span></span>
                </li>
              );
            })}
          </ul>
        </div>
        {audience.kind === 'local' ? (
          <div className="tdoc-tip-pane" aria-hidden={!step} inert={!step}>
            <p className="tdoc-tip-eyebrow">Turn on</p>
            <p className="tdoc-tip-title">Paste this into {audience.agent}</p>
            <CodeBlock text={TURN_ON_PROMPT} className="tdoc-tip-code" />
            <p className={`tdoc-tip-status${ready ? ' is-ready' : ''}`} role="status">
              {!step ? null : ready ? 'On. Comments now go to your agent.' : <><span className="tdoc-tip-spin" />Waiting for your computer…</>}
            </p>
          </div>
        ) : null}
      </div>
      <div className="tdoc-tip-foot">
        <AppButton variant="quiet" size="s" onClick={() => (step ? setStep(false) : window.location.assign(AGENTS_PAGE))}>{step ? 'Back' : 'Other agents'}</AppButton>
        <AppButton variant="primary" size="s" className={step ? 'is-hidden' : ''} aria-hidden={step} tabIndex={step ? -1 : undefined} onClick={act}>{copy.cta}</AppButton>
      </div>
    </div>
  );
}

// Decides whether and when the card shows, and remembers closes. Mounted on
// the docs list; renders nothing until the audience check and the delay pass.
export function AgentTip({ enabled = true }) {
  const [audience, setAudience] = useState(null);
  const [folded, setFolded] = useState(false);
  const [gone, setGone] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) return undefined;
    started.current = true;
    if (dismissals() >= 2 || sessionGet(SEEN_KEY)) return undefined;
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const who = await tipAudience();
        if (cancelled || !who) return;
        sessionSet(SEEN_KEY, '1');
        setAudience(who);
      } catch { /* signed out or offline: no tip */ }
    }, DELAY_MS);
    return () => { cancelled = true; clearTimeout(id); };
  }, [enabled]);

  const close = useCallback(({ done } = {}) => {
    if (done) { setGone(true); return; }
    writeStored(DISMISS_KEY, String(dismissals() + 1));
    setFolded(true);
  }, []);

  if (!audience || gone) return null;
  if (folded) {
    return (
      <AppButton className="tdoc-tip-pill" size="s" onClick={() => setFolded(false)}>
        <i aria-hidden="true" />Auto-send comments to your agent
      </AppButton>
    );
  }
  return <AgentTipCard audience={audience} onClose={close} />;
}
