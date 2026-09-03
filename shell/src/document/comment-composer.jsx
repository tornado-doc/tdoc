import React, { useEffect, useState } from 'react';
import { MentionField } from './mention-field.jsx';
import { TOP_BAR_HEIGHT } from './model.js';

// The shell's chrome does not scroll — the frame does — so the composer's
// coordinates are viewport coordinates. On a phone the keyboard shrinks that
// viewport out from under a position that was computed once at render: the card
// ends up below the fold, iOS scrolls the page to reveal the focused textarea,
// and the whole thing appears to fly off. visualViewport is what actually
// reports that shrink; window.innerHeight can lag or not change at all.
function readViewport() {
  const visual = typeof window !== 'undefined' ? window.visualViewport : null;
  return {
    width: Math.round(visual ? visual.width : window.innerWidth),
    height: Math.round(visual ? visual.height : window.innerHeight),
  };
}

export function CommentComposer({ selection, onSubmit, onClose, mentionable = [] }) {
  const [text, setText] = useState('');
  const [viewport, setViewport] = useState(readViewport);

  useEffect(() => {
    const onChange = () => setViewport(readViewport());
    const visual = window.visualViewport;
    // `scroll` too: iOS shifts the visual viewport as well as resizing it.
    visual?.addEventListener('resize', onChange);
    visual?.addEventListener('scroll', onChange);
    window.addEventListener('resize', onChange);
    return () => {
      visual?.removeEventListener('resize', onChange);
      visual?.removeEventListener('scroll', onChange);
      window.removeEventListener('resize', onChange);
    };
  }, []);

  const rect = selection.rect || {};
  const width = 320;
  const estimatedHeight = 190;
  const left = Math.max(8, Math.min(rect.left || 8, viewport.width - width - 8));
  let top = TOP_BAR_HEIGHT + (rect.bottom || 0) + 8;

  if (top + estimatedHeight > viewport.height - 8) {
    top = Math.max(
      TOP_BAR_HEIGHT + 4,
      TOP_BAR_HEIGHT + (rect.top || 0) - estimatedHeight - 8,
    );
  }
  // Above the selection can still overflow when the keyboard leaves less room
  // than the card needs. Staying on screen wins over staying next to the quote.
  top = Math.min(top, Math.max(TOP_BAR_HEIGHT + 4, viewport.height - estimatedHeight - 8));

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
