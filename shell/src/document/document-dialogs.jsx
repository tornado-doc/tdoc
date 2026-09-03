import React, { useEffect, useState } from 'react';
import { AppDialog } from '../ui/dialog.jsx';
import { getPublishSignin, publishDocument } from './api.js';
import { copyText } from './model.js';

export function ShareDialog({ open, url, onOpenChange, onCopied }) {
  const copy = async () => {
    await copyText(url);
    onCopied();
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Share"
      description="Anyone with this link can read. To comment, they sign in."
      actions={(
        <>
          <button type="button" onClick={() => onOpenChange(false)}>Close</button>
          <button type="button" className="primary" onClick={copy}>Copy link</button>
        </>
      )}
    >
      <div className="code url" id="tdoc-share-url">{url}</div>
    </AppDialog>
  );
}

// Being named on a doc you are not part of has two very different endings,
// and the author's job differs by which one it is. Someone who already uses
// tdoc will find the mention on their own — the link only makes it sooner.
// Someone who never has will not, ever: tdoc has no channel off the site, so
// the inbox row sits in an inbox they have no reason to open. Telling both
// groups "send them the link" is exactly how the second person quietly never
// hears about it, so each name says which case it is.
function reachLine({ login, known, invited }) {
  const who = `@${login}`;
  const tail = known
    ? 'the mention is waiting in their tdoc inbox'
    : 'has never used tdoc, so only this link will reach them';
  return invited ? `${who} · invited — ${tail}` : `${who} — ${tail}`;
}

export function MentionReachDialog({ open, newcomers, url, onOpenChange, onCopied }) {
  const people = newcomers || [];
  const strangers = people.filter((person) => !person.known);
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title={strangers.length ? 'Send them the link' : 'Named on this doc'}
      description={strangers.length
        ? 'tdoc cannot email anyone. For the people below who have never used tdoc, this link is the only way the mention reaches them.'
        : 'They are not on this doc yet, but they use tdoc — the mention is in their inbox. Send the link if you want them to see it sooner.'}
      actions={(
        <>
          <button type="button" onClick={() => onOpenChange(false)}>Close</button>
          <button
            type="button"
            className="primary"
            onClick={async () => { await copyText(url); onCopied(); }}
          >
            Copy link
          </button>
        </>
      )}
    >
      <div className="status" id="tdoc-mention-reach">
        {people.map((person) => (
          <div key={person.login} className={person.known ? 'reach' : 'reach new'}>
            {reachLine(person)}
          </div>
        ))}
      </div>
      <div className="code url" style={{ marginTop: 10 }}>{url}</div>
    </AppDialog>
  );
}

// The publish endpoint answers once, at the end. Everything the user needs
// mid-flight — above all the GitHub device code — has to be fetched alongside
// it. Codes are opaque otherwise: "Failed: publish_timeout" was the entire
// story a first-time publisher got.
const PUBLISH_ERRORS = {
  publish_timeout: 'Publish timed out. If a GitHub sign-in was waiting, the code expired before it was approved — try again.',
  publish_failed: 'Publish failed. The full output is in the terminal running `tdoc serve`.',
  publish_spawn_failed: 'Could not start the publish script. Check that bin/tdoc-publish is executable.',
};

function PublishSignin({ signin }) {
  return (
    <div className="status" style={{ marginTop: 10 }}>
      <div>
        {signin.opened
          ? 'A GitHub page just opened in your browser. Enter this code there:'
          : 'Finish signing in with GitHub, then enter this code:'}
      </div>
      <div className="code" style={{ marginTop: 8 }}>{signin.user_code}</div>
      <div className="actions" style={{ justifyContent: 'flex-start', gap: 8, marginTop: 8 }}>
        <button type="button" onClick={() => copyText(signin.user_code)}>Copy code</button>
        <button
          type="button"
          onClick={() => window.open(signin.verification_uri, '_blank', 'noopener')}
        >
          Open GitHub →
        </button>
      </div>
      <div style={{ marginTop: 8 }}>Waiting for you to approve it — publishing resumes on its own.</div>
    </div>
  );
}

export function PublishDialog({ open, slug, onOpenChange }) {
  const [status, setStatus] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [signin, setSignin] = useState(null);

  // The poll belongs to "a publish is running and the dialog is on screen",
  // not to the publish call. This dialog is never unmounted — only `open`
  // flips — and Base UI dismisses on Escape and backdrop click, so a user who
  // glances away mid-sign-in and comes back must find the code still here.
  // Owning the interval in an effect makes reopening restart it; creating it
  // inside publish() meant one stray click hid the code for the rest of the
  // flow, which is the exact failure this whole change exists to remove.
  useEffect(() => {
    if (!busy || !open) return undefined;
    let alive = true;
    const tick = () => { getPublishSignin(slug).then((s) => { if (alive) setSignin(s); }).catch(() => {}); };
    tick();
    const id = setInterval(tick, 1500);
    return () => { alive = false; clearInterval(id); };
  }, [busy, open, slug]);

  const publish = async () => {
    setBusy(true);
    setSignin(null);
    setStatus('Publishing — this can take 20–60s on first run…');
    try {
      const result = await publishDocument(slug);
      setUrl(result.url);
      setStatus('');
    } catch (error) {
      setStatus(PUBLISH_ERRORS[error.message] || `Failed: ${error.message}`);
    } finally {
      setSignin(null);
      setBusy(false);
    }
  };

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Publish this doc"
      actions={url ? null : (
        <>
          <button type="button" onClick={() => onOpenChange(false)}>Cancel</button>
          <button type="button" id="tdoc-pub-go" className="primary" disabled={busy} onClick={publish}>Publish</button>
        </>
      )}
    >
      <p>We'll deploy this so anyone with the link can read it. Commenting just needs a sign-in.</p>
      <div className="step"><span className="n">·</span><span>Slug: <code id="tdoc-pub-slug">{slug}</code></span></div>
      {status ? <div className="status" style={{ marginTop: 10 }}>{status}</div> : null}
      {signin ? <PublishSignin signin={signin} /> : null}
      {url ? (
        <div style={{ marginTop: 10 }}>
          <div className="code url" id="tdoc-pub-url">{url}</div>
          <div className="actions" style={{ justifyContent: 'flex-start', gap: 8 }}>
            <button type="button" className="primary" onClick={() => copyText(url)}>Copy link</button>
            <button type="button" onClick={() => window.open(url, '_blank', 'noopener')}>View live →</button>
          </div>
        </div>
      ) : null}
    </AppDialog>
  );
}

export function MessageDialog({ message, onOpenChange }) {
  return (
    <AppDialog
      open={Boolean(message)}
      onOpenChange={onOpenChange}
      title={message?.title || 'Something went wrong'}
      actions={<button type="button" onClick={() => onOpenChange(false)}>Close</button>}
    >
      <p>{message?.message}</p>
    </AppDialog>
  );
}
