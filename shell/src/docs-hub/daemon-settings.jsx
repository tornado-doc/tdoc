import React, { useEffect, useState } from 'react';
import { CopyPromptButton } from '../ui/copy-prompt-button.jsx';
import { LOCAL_DAEMON_PROMPT, localSeenText } from '../document/notify-handoff.jsx';

const DAEMON_COMMAND = 'bash "$SKILL_DIR/bin/tdoc-daemon" install-launchd';

export function DaemonSettingsCard({ team = null }) {
  const admin = !team || team.role === 'admin';
  const [local, setLocal] = useState(null);
  useEffect(() => {
    if (!admin) return undefined;
    let live = true;
    fetch('/api/me/connectors', { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((body) => { if (live) setLocal((body.connectors || []).filter((c) => c.kind === 'local')); })
      .catch(() => { if (live) setLocal([]); });
    return () => { live = false; };
  }, [admin]);
  const agents = (local || []).flatMap((c) => c.agents || []);
  const running = agents.some((a) => a.status === 'active');
  const seen = agents[0] ? localSeenText(agents[0]) : '';

  return (
    <section className="tm-settings-card tm-daemon-card" aria-labelledby="tm-daemon-heading">
      <div className="tm-settings-head">
        <div>
          <h2 id="tm-daemon-heading">Always-on agent</h2>
          <p>Run Claude Code or Codex on your own computer without Raft.</p>
        </div>
        {admin && local !== null ? <span className={`tm-daemon-state${running ? ' is-running' : ''}`}>{running ? 'Running' : agents.length ? 'Not running' : 'Not set up'}</span> : null}
      </div>
      {!admin ? (
        <p className="manage-hint">Only a workspace admin can connect and run an agent for team documents.</p>
      ) : (
        <>
          {team ? <p className="manage-hint">For safety, only admins can send this workspace’s comments to a daemon connected to their own tdoc account.</p> : null}
          {agents.length ? (
            <div className="tm-daemon-connected">
              <b>{agents.map((a) => `${a.cli} on ${a.device || a.server_id}`).join(', ')}</b>
              <span>{running ? 'The daemon is checking for work.' : `Start the daemon on that computer${seen ? ` · ${seen}` : ''}.`}</span>
            </div>
          ) : null}
          <ol className="tm-backup-steps">
            <li>Install the tdoc skill and sign in with <code>tdoc-publish --signin-only</code>.</li>
            <li>Run the command below. It writes a macOS LaunchAgent and prints the two commands that enable it at login.</li>
            <li>Return here; its status changes to Running after the first check-in.</li>
          </ol>
          <div className="tm-daemon-command">
            <code>{DAEMON_COMMAND}</code>
            <CopyPromptButton text={DAEMON_COMMAND} />
          </div>
          <details className="tdoc-conn-alt">
            <summary>Or ask the agent to set itself up</summary>
            <code>{LOCAL_DAEMON_PROMPT}</code>
            <CopyPromptButton text={LOCAL_DAEMON_PROMPT} />
          </details>
          <div className="tm-settings-links"><a className="new-folder-btn" href="/me/agents?tab=send">Manage all agents</a></div>
        </>
      )}
    </section>
  );
}
