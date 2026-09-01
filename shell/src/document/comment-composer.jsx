import React, { useState } from 'react';
import { MentionField } from './mention-field.jsx';
import { TOP_BAR_HEIGHT } from './model.js';

export function CommentComposer({ selection, onSubmit, onClose, mentionable = [] }) {
  const [text, setText] = useState('');
  const rect = selection.rect || {};
  const width = 320;
  const estimatedHeight = 190;
  const left = Math.max(8, Math.min(rect.left || 8, window.innerWidth - width - 8));
  let top = TOP_BAR_HEIGHT + (rect.bottom || 0) + 8;

  if (top + estimatedHeight > window.innerHeight - 8) {
    top = Math.max(
      TOP_BAR_HEIGHT + 4,
      TOP_BAR_HEIGHT + (rect.top || 0) - estimatedHeight - 8,
    );
  }

  const quoted = String(selection.text || '');
  const preview = selection.kind === 'element'
    ? selection.label || 'Selected element'
    : `"${quoted.slice(0, 80)}${quoted.length > 80 ? '…' : ''}"`;

  const submit = () => {
    if (text.trim()) onSubmit(text);
  };

  return (
    <div
      className="tdoc-popup"
      style={{ top, left }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="head">
        <span className="h">{preview}</span>
        <button type="button" className="x" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <MentionField
        autoFocus
        placeholder="What should change? Type @ to notify someone"
        value={text}
        people={mentionable}
        onChange={setText}
        onSubmit={submit}
      />
      <div className="foot">
        <span className="hint">⌘+Enter to submit</span>
        <button className="submit" type="button" onClick={submit}>Comment</button>
      </div>
    </div>
  );
}
