import React, { useEffect, useState } from 'react';
import { MentionField } from './mention-field.jsx';
import { TOP_BAR_HEIGHT } from './model.js';

// The shell's chrome does not scroll — the frame does — so the composer's
// coordinates are viewport coordinates.
//
// A phone keyboard does TWO things, and reading only the first is why the card
// still flew after the first attempt at this: it shrinks the visual viewport,
// and it SHIFTS it, so the visible band no longer starts at y=0. offsetTop is
// that shift. A card positioned without it sits at a coordinate that is still
// inside the layout viewport and no longer inside the part you can see.
//
// The card is position:fixed for the same reason: absolute positioning ties it
// to the document, and iOS scrolls the document to reveal the focused textarea.
// Fixed plus offsetTop keeps it against the band that is actually on screen.
function readViewport() {
  const visual = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!visual) {
    return { width: window.innerWidth, height: window.innerHeight, offsetTop: 0, offsetLeft: 0 };
  }
  return {
    width: Math.round(visual.width),
    height: Math.round(visual.height),
    offsetTop: Math.round(visual.offsetTop || 0),
    offsetLeft: Math.round(visual.offsetLeft || 0),
  };
}

export const COMPOSER_WIDTH = 320;
export const COMPOSER_HEIGHT = 190;

// Where the card goes, as arithmetic — no DOM, so the keyboard cases are unit
// tested rather than staged in a browser that has no keyboard.
//   viewport: { width, height, offsetTop, offsetLeft } from visualViewport
//   rect:     the selection, in the frame's own viewport coordinates
// The result is a fixed-position coordinate, clamped into the band that is
// actually on screen. Both directions matter: the keyboard can leave less room
// than the card needs, and then staying visible beats staying next to the quote.
export function composerPosition(rect, viewport) {
  const visibleTop = viewport.offsetTop || 0;
  const visibleBottom = visibleTop + viewport.height;
  const offsetLeft = viewport.offsetLeft || 0;

  const left = Math.max(
    offsetLeft + 8,
    Math.min((rect.left || 8) + offsetLeft, offsetLeft + viewport.width - COMPOSER_WIDTH - 8),
  );
  let top = visibleTop + TOP_BAR_HEIGHT + (rect.bottom || 0) + 8;
  if (top + COMPOSER_HEIGHT > visibleBottom - 8) {
    top = visibleTop + TOP_BAR_HEIGHT + (rect.top || 0) - COMPOSER_HEIGHT - 8;
  }
  top = Math.min(top, visibleBottom - COMPOSER_HEIGHT - 8);
  top = Math.max(top, visibleTop + 8);
  return { top, left };
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

  const { top, left } = composerPosition(selection.rect || {}, viewport);

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
