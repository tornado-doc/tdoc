import React, { useCallback, useEffect, useState } from 'react';
import { AppDialog } from './ui/dialog.jsx';
import { AppButton } from './ui/button.jsx';
import { ShareLinkRow } from './document/document-dialogs.jsx';
import { InviteField } from './document/owner-access-dialog.jsx';
import { copyText } from './document/model.js';

// One Share for a feedback space's invites, drawn in the widget (on the
// owner's own site, or tdoc) and in tdoc's Share window (/feedback/share,
// on anyone else's site). `request(path, init)` -> JSON or throws: the
// widget's token transport, or same-origin fetch with the cookie.
// Share, in the widget (Julie, 2026-11-03): the doc Share dialog's parts
// (the link row, the invite field) for a feedback space's invites. A link
// is one-time; a person is invited by email or GitHub handle and told by
// a tdoc notification and an email. Every invite is listed here to
// withdraw. Owner (team admin) only; the server checks.
export function FeedbackSharePanel({ slug, open, onClose, request }) {
  const [state, setState] = useState(null);
  // What just happened, said inside the dialog (a toast would sit under
  // its backdrop).
  const [note, setNote] = useState(null);
  const say = (text, bad = false) => setNote({ text, bad });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const reload = useCallback(async () => {
    try { setState(await request(`/api/feedback/invites?slug=${encodeURIComponent(slug)}`)); setError(''); }
    catch (err) { setError(err.message || 'Could not load invites'); }
  }, [slug]);
  useEffect(() => { if (open && slug) reload(); }, [open, slug, reload]);
  const invites = (state && state.invites) || [];
  const host = (state && state.host) || '';
  const link = invites.find((i) => i.kind === 'link' && i.status === 'pending');
  const create = (fields) => request('/api/feedback/invites', { method: 'POST', body: JSON.stringify({ slug, ...fields }) });
  const copyLink = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const url = link ? link.link : (await create({})).invite.link;
      say(await copyText(url) ? 'Invite link copied' : 'Link ready: copy it from the field');
      await reload();
    } catch (err) { say(err.message || 'Could not make a link', true); }
    finally { setBusy(false); }
  };
  const invitePeople = async (next) => {
    for (const who of next) {
      try {
        const out = await create({ invitee: who });
        say(out.emailed && out.emailed.length ? `Invited ${who} · email sent` : `Invited ${who}`);
      } catch (err) { say(err.message || `Could not invite ${who}`, true); }
    }
    await reload();
  };
  const withdraw = async (invite) => {
    try {
      await request('/api/feedback/invites/revoke', { method: 'POST', body: JSON.stringify({ slug, id: invite.id }) });
      say('Invite withdrawn');
    } catch (err) { say(err.message || 'Could not withdraw', true); }
    await reload();
  };
  const statusOf = (i) => {
    if (i.status === 'accepted') return i.kind === 'link' ? `Joined · ${i.accepted_name || 'used'}` : 'Joined';
    if (i.status === 'expired') return 'Expired';
    return i.kind === 'link' ? `Not used yet · until ${new Date(i.expires).toLocaleDateString()}` : (i.kind === 'email' ? 'Invited · joins when they sign in with this address' : 'Invited');
  };
  return (
    <AppDialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      title="Share"
      description={state && state.team
        ? `Your team sees these comments. Invite others to comment on ${host} too.`
        : `Only you and the people you invite see these comments on ${host}.`}
      actions={<AppButton onClick={onClose}>Close</AppButton>}
    >
      <section className="manage-section">
        <label className="field">Invite link</label>
        <ShareLinkRow url={link ? link.link : 'A one-time link, made when you copy it'} id="tdoc-fb-invite-link" onCopy={copyLink} disabled={busy || !state} />
        <p className="manage-hint">{state && state.site ? `Opens ${host}, where they click Join.` : `Opens a tdoc page that sets up the bookmark, then ${host}.`} One person, within 7 days.</p>
      </section>
      <section className="manage-section">
        <label className="field">Invite people</label>
        <InviteField users={[]} onChange={invitePeople} search={false} placeholder="Email or GitHub username, then Enter" />
        <p className="manage-hint">They get a tdoc notification and an email with the link.</p>
      </section>
      {error ? <p className="manage-hint tdoc-invite-error" role="alert">{error}</p> : null}
      <p className={`manage-hint${note && note.bad ? ' tdoc-invite-error' : ''}`} role="status" id="tdoc-fb-share-status">{note ? note.text : ''}</p>
      {invites.length ? (
        <section className="manage-section">
          <label className="field">Invites</label>
          <ul className="tdoc-invite-list">
            {invites.map((i) => (
              <li key={i.id} className="tdoc-invite-row">
                <span className="tdoc-invite-who">
                  <span className="tdoc-invite-name">{i.kind === 'link' ? 'Invite link' : i.invitee}</span>
                  <span className="tdoc-invite-status">{statusOf(i)}</span>
                </span>
                <AppButton size="s" variant="quiet" onClick={() => withdraw(i)}>Withdraw</AppButton>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </AppDialog>
  );
}


async function sameOriginRequest(path, init = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin', ...init,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error((body && (body.message || body.error)) || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

// /feedback/share/<slug>: the same Share in a small tdoc window, opened by
// the widget's Share on a site that is not the owner's own.
export function FeedbackShare({ boot }) {
  const { slug } = boot;
  return (
    <div className="tdoc-app docs-hub tdoc-feedback-page">
      <FeedbackSharePanel slug={slug} open request={sameOriginRequest} onClose={() => { try { window.close(); } catch (_) {} }} />
    </div>
  );
}
