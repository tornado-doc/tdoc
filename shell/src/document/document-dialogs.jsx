import React, { useState } from 'react';
import { AppDialog } from '../ui/dialog.jsx';
import { publishDocument } from './api.js';
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
      <div className="code" id="tdoc-share-url">{url}</div>
    </AppDialog>
  );
}

export function PublishDialog({ open, slug, onOpenChange }) {
  const [status, setStatus] = useState('');
  const [url, setUrl] = useState('');

  const publish = async () => {
    setStatus('Publishing…');
    try {
      const result = await publishDocument(slug);
      setUrl(result.url);
      setStatus('');
    } catch (error) {
      setStatus(`Failed: ${error.message}`);
    }
  };

  const actions = url ? (
    <>
      <button type="button" onClick={() => copyText(url)}>Copy link</button>
      <button type="button" className="primary" onClick={() => window.open(url, '_blank', 'noopener')}>
        View live
      </button>
    </>
  ) : (
    <>
      <button type="button" onClick={() => onOpenChange(false)}>Cancel</button>
      <button type="button" id="tdoc-pub-go" className="primary" onClick={publish}>Publish</button>
    </>
  );

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Publish this doc"
      description="Deploy this snapshot so anyone with the link can read it."
      actions={actions}
    >
      <p>Slug: <code id="tdoc-pub-slug">{slug}</code></p>
      {status ? <div className="status">{status}</div> : null}
      {url ? <div className="code" id="tdoc-pub-url">{url}</div> : null}
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
