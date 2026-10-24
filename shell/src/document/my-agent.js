// Send to my agent: the third of Comment / Ask AI / Send to my agent, for a
// reader. What it does depends on what the reader's own account has, which
// the server answers (GET /api/docs/<slug>/my-agent):
//   none     nothing connected     → "Connect my agent": /start, then back
//                                     here with the question waiting
//   online   an agent can be woken → "Send to my agent": the reader's own
//                                     agent answers, privately
//   offline  connected, not awake  → "Copy for my agent": the line to paste
// Never anyone else's agent: the server only knows the reader's own.

import { useCallback, useEffect, useRef, useState } from 'react';
import { getMyAgent } from './api.js';
import { readStored, removeStored, writeStored } from '../safe-storage.js';

export const MY_AGENT_LABELS = {
  none: 'Connect my agent',
  online: 'Send to my agent',
  offline: 'Copy for my agent',
};

// The line a person pastes into their agent. The server's handoff starts
// with the same words, so both roads read alike to the agent.
export function agentAskLine(url, question, passage) {
  const q = String(question || '').trim();
  const p = String(passage || '').trim();
  return `Read ${url} and answer: ${q}${p ? `\n\nAbout this passage: "${p}"` : ''}`;
}

// A question waiting on "Connect my agent". It rides through /start and the
// setup page in this browser's storage (the URL carries only where to come
// back to), and is handed to the new agent when the reader returns.
const PENDING_KEY = 'tdoc:pending-agent-ask';
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export function savePendingAsk({ slug, question, passage }) {
  const keep = passage && passage.text ? {
    text: passage.text,
    context_before: passage.context_before,
    context_after: passage.context_after,
    occurrence: passage.occurrence,
    occurrences: passage.occurrences,
  } : null;
  return writeStored(PENDING_KEY, JSON.stringify({ slug, question: String(question || ''), passage: keep, at: Date.now() }));
}

export function peekPendingAsk() {
  try {
    const p = JSON.parse(readStored(PENDING_KEY, 'null'));
    if (!p || typeof p.slug !== 'string' || Date.now() - (Number(p.at) || 0) > PENDING_MAX_AGE_MS) return null;
    return p;
  } catch {
    return null;
  }
}

export function takePendingAsk(slug) {
  const p = peekPendingAsk();
  if (!p || p.slug !== slug) return null;
  removeStored(PENDING_KEY);
  return p;
}

export function connectHref(slug) {
  return `/start?return=${encodeURIComponent(`/d/${slug}`)}`;
}

// Still on its way: not answered, not failed.
export function askWaiting(ask) {
  return Boolean(ask && !ask.answer && ask.delivery?.status !== 'failed');
}

const POLL_MS = 5000;

// The reader's tier and their questions on this doc. Read again when the
// tab comes back (they may have just connected an agent or started its
// helper), and every few seconds while an answer is on its way.
export function useMyAgent(slug, enabled) {
  const [state, setState] = useState(null);
  const live = useRef(true);
  const refresh = useCallback(async () => {
    if (!enabled) return null;
    try {
      const body = await getMyAgent(slug);
      if (live.current && body) setState(body);
      return body;
    } catch {
      return null;
    }
  }, [enabled, slug]);

  useEffect(() => {
    live.current = true;
    if (!enabled) return undefined;
    refresh();
    const onBack = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => {
      live.current = false;
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
    };
  }, [enabled, refresh]);

  const waiting = Boolean(state?.asks?.some(askWaiting));
  useEffect(() => {
    if (!enabled || !waiting) return undefined;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, waiting, refresh]);

  // A question just sent shows at once, before the next read.
  const addAsk = useCallback((ask) => {
    setState((prev) => (prev ? { ...prev, asks: [ask, ...(prev.asks || []).filter((a) => a.ask_id !== ask.ask_id)] } : prev));
  }, []);

  return { state, tier: state?.tier || null, refresh, addAsk };
}
