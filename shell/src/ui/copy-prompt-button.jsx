import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

// Shared by the document modal, comment composer, and Agents dashboard so
// prompt spacing and copy feedback stay consistent.
export function CopyPromptButton({ text, className = '' }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch { /* The prompt remains selectable beside the button. */ }
  };
  return (
    <button
      type="button"
      className={`tdoc-copy-prompt${copied ? ' is-copied' : ''}${className ? ` ${className}` : ''}`}
      onClick={copy}
      title={copied ? 'Copied' : 'Copy prompt'}
      aria-label={copied ? 'Prompt copied' : 'Copy prompt'}
    >
      {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}
