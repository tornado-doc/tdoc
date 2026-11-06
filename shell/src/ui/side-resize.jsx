import React, { useEffect, useRef, useState } from 'react';
import { readStored, writeStored } from '../safe-storage.js';

// A panel fixed to the right edge that can be dragged wider and narrower by its
// left edge: remembered on this device, with the keyboard too (arrows, Home,
// End). Phones get a full-width panel and no handle: the caller decides that.
const STEP = 16;
const SPARE = 320; // What the page behind always keeps.

const roomFor = (min, max) => Math.max(min, Math.min(max, window.innerWidth - SPARE));
const clampTo = (value, min, max) => Math.max(min, Math.min(roomFor(min, max), value));

export function useSideWidth({ storageKey, initial, min, max }) {
  const [wanted, setWanted] = useState(() => {
    const stored = Number(readStored(storageKey));
    return Number.isFinite(stored) && stored > 0 ? stored : initial;
  });
  const [, setViewport] = useState(0);
  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const set = (next) => {
    const value = clampTo(Math.round(next), min, max);
    setWanted(value);
    writeStored(storageKey, String(value));
  };
  return { width: clampTo(wanted, min, max), setWidth: set, min, max: roomFor(min, max) };
}

export function SideResizeHandle({ side, label = 'Resize panel' }) {
  const { width, setWidth, min, max } = side;
  const drag = useRef(null);
  return (
    <div
      className="ui-side-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { x: event.clientX, width };
      }}
      onPointerMove={(event) => {
        if (drag.current) setWidth(drag.current.width + drag.current.x - event.clientX);
      }}
      onPointerUp={() => { drag.current = null; }}
      onPointerCancel={() => { drag.current = null; }}
      onKeyDown={(event) => {
        const next = { ArrowLeft: width + STEP, ArrowRight: width - STEP, Home: min, End: max }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        setWidth(next);
      }}
    />
  );
}
