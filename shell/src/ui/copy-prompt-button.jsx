import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { AppButton } from './button.jsx';

// The one Copy control (prompts, commands, links, the agent hand-off line).
// It is an AppButton (quiet, small) with the copy icon, so every Copy looks
// the same; only the words and what gets copied differ per surface.
//
// Uncontrolled (default): copies `text` itself and says "Copied" for 1.8s.
// Controlled: a surface that already owns its copy logic and copied state
// (a toast, an onboarding event, a fallback message) passes `onCopy` and
// `copied`; the button only draws it. Labels default to Copy / Copied, and
// the accessible name to "Copy prompt" unless the surface names its action.
export function CopyPromptButton({
  text = '',
  className = '',
  label,
  copiedLabel = 'Copied',
  onCopy = null,
  copied: copiedProp,
  // false: the copied state is not a success ("Select & copy"), so no tick.
  showTick = true,
  ...props
}) {
  const [copiedSelf, setCopiedSelf] = useState(false);
  const controlled = copiedProp !== undefined;
  const copied = controlled ? Boolean(copiedProp) : copiedSelf;
  const copy = async () => {
    if (onCopy) { onCopy(); return; }
    try {
      await navigator.clipboard.writeText(text);
      setCopiedSelf(true);
      window.setTimeout(() => setCopiedSelf(false), 1800);
    } catch { /* The prompt remains selectable beside the button. */ }
  };
  const named = label !== undefined;
  return (
    <AppButton
      variant="quiet"
      size="s"
      className={`tdoc-copy-prompt${copied && showTick ? ' is-copied' : ''}${className ? ` ${className}` : ''}`}
      onClick={copy}
      title={named ? undefined : (copied ? 'Copied' : 'Copy prompt')}
      aria-label={named ? undefined : (copied ? 'Prompt copied' : 'Copy prompt')}
      {...props}
    >
      {copied && showTick ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
      <span>{copied ? copiedLabel : (named ? label : 'Copy')}</span>
    </AppButton>
  );
}
