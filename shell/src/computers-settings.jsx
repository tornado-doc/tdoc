import React, { useEffect, useRef, useState } from 'react';
import { Monitor } from 'lucide-react';
import { AppDialog } from './ui/dialog.jsx';
import { AppSelect } from './ui/select.jsx';
import { CopyPromptButton } from './ui/copy-prompt-button.jsx';
import { SetupGate, AUTOMATIC_PROMPT } from './setup-gate.jsx';

const aiName = cli => cli === 'claude' ? 'Claude Code' : cli === 'codex' ? 'Codex' : cli;
const stateName = state => state === 'ready' ? 'Ready' : state === 'not_installed' ? 'Not installed' : 'Needs a check';
async function call(body) {
  const r = await fetch('/api/me/computers', body ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { credentials: 'same-origin' });
  const result = await r.json();
  if (!r.ok) throw new Error(result.message || (result.error === 'computer_not_ready' ? 'That AI is not ready. Check its connection and try again.' : 'Could not save. Please try again.'));
  return result;
}

export function ComputersBody({ identity, preview = null }) {
  const [data, setData] = useState(preview);
  const revision = useRef(0);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState(false);
  const [repair, setRepair] = useState(null);
  useEffect(() => {
    if (preview) return undefined;
    let cancelled = false; let timer;
    const load = async () => {
      const observed = revision.current;
      try { const next = await call(); if (!cancelled && observed === revision.current) { setData(next); setNotice(previous => previous === 'Could not load your computers. Retrying…' ? '' : previous); } }
      catch { if (!cancelled) setNotice('Could not load your computers. Retrying…'); }
      if (!cancelled) timer = window.setTimeout(load, 15000);
    };
    load(); return () => { cancelled = true; window.clearTimeout(timer); };
  }, [preview]);
  const update = async (body) => {
    if (busy) return;
    revision.current++; setBusy(true); setNotice('');
    try {
      if (preview) setData(previous => ({ ...previous, ...(body.action === 'default' ? { default: { provider: 'local', device: body.device, cli: body.cli } } : { computers: previous.computers.map(c => c.device === body.device ? { ...c, paused: body.action === 'pause', status: body.action === 'pause' ? 'paused' : 'active' } : c) }) }));
      else { await call(body); setData(await call()); }
      setNotice(body.action === 'pause' ? 'Automatic updates paused. Any work already running can finish.' : body.action === 'resume' ? 'Automatic updates resumed. Waiting comments will be picked up when this computer is online.' : 'Saved. This AI will handle docs with no agent selected. Existing doc choices stay the same.');
    } catch (e) { setNotice(e.message); }
    finally { setBusy(false); }
  };
  const computers = data?.computers || [];
  const options = computers.flatMap(c => c.status === 'active' && !c.paused ? c.runtimes.filter(r => r.state === 'ready').map(r => ({ value: `${c.device}/${r.cli}`, label: `${aiName(r.cli)} · ${c.device}` })) : []);
  const current = data?.default?.provider === 'local' ? `${data.default.device}/${data.default.cli}` : '';
  const selected = options.some(o => o.value === current) ? current : '';
  return <>
    <div className="tm-settings-head"><div><h2>Computers &amp; AI</h2><p>Manage automatic comment updates here, any time.</p></div><button type="button" className="new-folder-btn" onClick={() => setSetup(true)}>Connect a computer</button></div>
    {notice ? <p role="status" className="muted">{notice}</p> : null}
    {!data ? <p role="status">Loading your computers…</p> : !computers.length ? <p className="empty">No computers connected. You can still use tdoc in your AI conversation.</p> : <>
      <label className="tdoc-computer-default">AI for new docs <AppSelect ariaLabel="AI for new docs" disabled={busy || !options.length} value={selected} options={[{ value: '', label: data.default && !selected ? 'Keep current agent' : 'Choose an AI' }, ...options]} onChange={value => { if (value) { const [device, cli] = value.split('/'); update({ device, cli, action: 'default' }); } }} /></label>
      <div className="pane">{computers.map(c => <section className="doc-row tdoc-computer-row" key={c.device} aria-label={c.device}>
        <Monitor size={20} aria-hidden="true" />
        <div className="doc-info"><strong className="doc-title">{c.device}</strong><p className="doc-meta">{c.paused ? 'Automatic updates paused' : c.status === 'active' ? 'Connected' : 'Offline · wake this computer to receive updates'}</p>
          <ul className="tdoc-computer-runtimes">{c.runtimes.map(r => <li key={r.cli}>{aiName(r.cli)}{r.version ? ` ${r.version}` : ''} <span>{stateName(r.state)}</span></li>)}</ul>
        </div>
        <div className="tdoc-dev-actions"><button type="button" className="tdoc-fbspace-btn" disabled={busy} onClick={() => update({ device: c.device, action: c.paused ? 'resume' : 'pause' })}>{c.paused ? 'Resume updates' : 'Pause updates'}</button><button type="button" className="tdoc-fbspace-btn" onClick={() => setRepair(c.device)}>Check setup</button></div>
      </section>)}</div>
      <p className="manage-hint">Pausing stops new work from being picked up. To remove a computer’s account access, use <a href="#agent-access">Agent access</a>.</p>
    </>}
    {setup ? <SetupGate boot={{ identity, oidcAuth: true }} startAt="connect" preview={preview ? { stage: 'connect' } : null} onClose={() => setSetup(false)} /> : null}
    {repair ? <AppDialog open title={`Check ${repair}`} onOpenChange={open => { if (!open) setRepair(null); }} description="Paste this instruction into Claude Code or Codex on that computer." actions={<button type="button" onClick={() => setRepair(null)}>Done</button>}><p>Your AI will update the tdoc tools and skill, check sign-in, and reconnect automatic updates. Approve in your browser if asked.</p><CopyPromptButton text={AUTOMATIC_PROMPT} /><details><summary>View instruction</summary><p className="tdoc-conn-pre">{AUTOMATIC_PROMPT}</p></details></AppDialog> : null}
  </>;
}
