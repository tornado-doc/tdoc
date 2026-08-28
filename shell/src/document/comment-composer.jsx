import React, { useState } from 'react';
import { X } from 'lucide-react';
import { TOP_BAR_HEIGHT } from './model.js';

export function CommentComposer({ selection, onSubmit, onClose }) {
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

  const preview = selection.kind === 'element'
    ? selection.label || 'Selected element'
    : `“${String(selection.text || '').slice(0, 80)}”`;

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
        <button type="button" className="x" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <textarea
        autoFocus
        placeholder="What should change?"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit();
        }}
      />
      <div className="foot">
        <span className="hint">⌘+Enter to submit</span>
        <button className="submit" type="button" onClick={submit}>Comment</button>
      </div>
    </div>
  );
}
