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
      description="Anyone with this link can read. To comment, they sign in with GitHub."
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

// An @mention on a private doc puts the named person on the allowlist, but
// nothing tells them that happened — tdoc has no channel off the site. So the
// one thing the owner still has to do is handed to them here, with the link
// ready to paste.
export function MentionInviteDialog({ open, invited, url, onOpenChange, onCopied }) {
  const names = (invited || []).map((login) => `@${login}`).join(', ');
  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Invited to this doc"
      description={`${names} can now open this document, and the mention is in their tdoc inbox. tdoc cannot email them — send the link so they know it is there.`}
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
      <div className="code url">{url}</div>
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
      <p>We'll deploy this so anyone with the link can read it. GitHub sign-in is required for commenting.</p>
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
