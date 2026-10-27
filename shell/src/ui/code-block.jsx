import React from 'react';
import { CopyPromptButton } from './copy-prompt-button.jsx';

// A command or code sample: normal-contrast monospace on the light surface,
// wrapping only at spaces (a long token scrolls sideways instead of breaking
// mid-word), with the shared Copy button inside its top-right corner.
// Styles: .ui-code-block in ui.css (dialogs load only ui.css / chrome.css).
// `wrap={false}`: a multi-line script whose columns matter scrolls sideways.
export function CodeBlock({ text, className = '', copy = true, wrap = true }) {
  return (
    <div className={`ui-code-block${copy ? ' has-copy' : ''}${wrap ? '' : ' no-wrap'}${className ? ` ${className}` : ''}`}>
      {/* The button floats inside the <pre>: wrapped lines flow around it and
          a long unbreakable token drops below it instead of running under. */}
      <pre>{copy ? <CopyPromptButton text={text} className="ui-code-copy" /> : null}<code>{text}</code></pre>
    </div>
  );
}
