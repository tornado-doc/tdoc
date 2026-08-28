import React, { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { AppDialog } from './ui/dialog.jsx';
import { pollDeviceSignIn, startDeviceSignIn } from './document/api.js';
import { copyText } from './document/model.js';

function isGitHubUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'https:' && /(^|\.)github\.com$/.test(url.hostname);
  } catch {
    return false;
  }
}

export function SignInDialog({ open, onOpenChange, onSuccess }) {
  const [device, setDevice] = useState(null);
  const [status, setStatus] = useState('Starting…');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    let timer;
    let interval = 5;

    // The device code travels through the closure, not through React state:
    // this effect instance's `device` is the value captured at mount (null),
    // so reading it inside the timer would poll with nothing forever.
    const poll = (deviceCode) => {
      timer = window.setTimeout(async () => {
        try {
          const result = await pollDeviceSignIn(deviceCode);
          if (cancelled) return;
          if (result.ok && result.identity) {
            onSuccess(result.identity);
            return;
          }
          if (result.error === 'slow_down') interval += 5;
          else if (result.error && result.error !== 'authorization_pending' && !result.pending) {
            setError(result.message || result.error);
            return;
          }
        } catch (pollError) {
          if (pollError.status !== 400) setStatus('Network error - retrying…');
        }
        if (!cancelled) poll(deviceCode);
      }, interval * 1000);
    };

    const start = async () => {
      setDevice(null);
      setError('');
      setCopied(false);
      setStatus('Starting…');
      try {
        const result = await startDeviceSignIn();
        if (cancelled) return;
        setDevice(result);
        interval = Math.max(5, Number(result.interval) || 5);
        setStatus('Open GitHub to approve, then return to this tab.');
        copyText(result.user_code).then(setCopied);
        poll(result.device_code);
      } catch (startError) {
        if (!cancelled) setError(startError.message);
      }
    };

    start();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, onSuccess]);

  const verificationUrl = device?.verification_uri_complete || device?.verification_uri;

  return (
    <AppDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Sign in with GitHub"
      actions={<button type="button" onClick={() => onOpenChange(false)}>Cancel</button>}
    >
      <ol className="tdoc-signin-steps">
        <li>
          <span>Copy this code</span>
          <button
            type="button"
            className="tdoc-device-code"
            disabled={!device?.user_code}
            onClick={() => copyText(device.user_code).then(setCopied)}
          >
            {device?.user_code || '…'}
          </button>
          {copied ? <small>Copied</small> : null}
        </li>
        <li>
          {isGitHubUrl(verificationUrl) ? (
            <a
              className="tdoc-open-github"
              href={verificationUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => device?.user_code && copyText(device.user_code)}
            >
              Open GitHub <ExternalLink size={14} />
            </a>
          ) : <span>Waiting for GitHub…</span>}
        </li>
        <li><span className={error ? 'error' : undefined}>{error || status}</span></li>
      </ol>
    </AppDialog>
  );
}
