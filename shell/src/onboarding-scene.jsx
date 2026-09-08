import React from 'react';

// The loop, drawn as what it is: two windows and the traffic between them.
// The agent's terminal on the left, the doc in a browser on the right, the
// doc going one way and the comments coming back. Not a flowchart — the
// person is about to have exactly these two windows open.
const ACC = '#1652f0';
const INK = '#1a1a1a';
const LINE = '#e8e7e3';
const F = '-apple-system, system-ui, sans-serif';
const MONO = 'ui-monospace, Menlo, monospace';

export function OnboardingScene({ done = false }) {
  return (
    <svg className="tdoc-wiz-scene" width="460" height="250" viewBox="0 0 460 250" role="img" aria-label="Your agent writes the doc; it opens in your browser; your comments go back to the agent.">
      <defs>
        <filter id="tdoc-scene-shadow" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="10" stdDeviation="10" floodColor="#000" floodOpacity="0.10" />
        </filter>
        <marker id="tdoc-scene-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M1 1L8 5L1 9" fill="none" stroke={ACC} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>
      <g filter="url(#tdoc-scene-shadow)"><rect x="16" y="36" width="180" height="150" rx="12" fill="#1c1c1e" /></g>
      <circle cx="32" cy="50" r="4" fill="#ff5f57" /><circle cx="45" cy="50" r="4" fill="#febc2e" /><circle cx="58" cy="50" r="4" fill="#28c840" />
      <text x="30" y="82" fontFamily={MONO} fontSize="11" fill="#9a9a9e">&gt; <tspan fill="#f2f2f2">Make my first tdoc</tspan></text>
      <rect x="30" y="94" width="118" height="6" rx="3" fill="#3a3a3c" /><rect x="30" y="106" width="86" height="6" rx="3" fill="#3a3a3c" /><rect x="30" y="118" width="104" height="6" rx="3" fill="#3a3a3c" />
      <text x="30" y="150" fontFamily={MONO} fontSize="11" fill="#7ee08a">✓ <tspan fill="#f2f2f2">Published</tspan> <tspan fill="#9a9a9e">tdoc.dev/you/…</tspan></text>
      <text x="106" y="214" textAnchor="middle" fontFamily={F} fontSize="12.5" fontWeight="500" fill={INK}>Your agent</text>
      <g filter="url(#tdoc-scene-shadow)"><rect x="264" y="36" width="180" height="150" rx="12" fill="#fff" stroke={LINE} /></g>
      <rect x="276" y="46" width="156" height="14" rx="7" fill="#f2f2f0" /><text x="354" y="56" textAnchor="middle" fontFamily={F} fontSize="8.5" fill="#a3a29d">tdoc.dev/you/q3-plan</text>
      <rect x="278" y="74" width="92" height="8" rx="4" fill={INK} />
      <rect x="278" y="92" width="120" height="6" rx="3" fill="#d9d9d6" /><rect x="278" y="104" width="132" height="6" rx="3" fill="#d9d9d6" /><rect x="278" y="116" width="96" height="6" rx="3" fill="#d9d9d6" />
      <rect x="276" y="130" width="112" height="12" rx="4" fill="#e8eeff" /><rect x="278" y="133" width="106" height="6" rx="3" fill="#8fa8f5" />
      <circle cx="398" cy="136" r="4" fill={ACC} />
      <g filter="url(#tdoc-scene-shadow)"><rect x="332" y="150" width="124" height="46" rx="9" fill="#fff" stroke={LINE} /></g>
      <circle cx="346" cy="164" r="6" fill="#f0c674" /><text x="357" y="168" fontFamily={F} fontSize="9.5" fontWeight="600" fill={INK}>Sam</text>
      <text x="340" y="186" fontFamily={F} fontSize="10" fill={INK}>This number is wrong.</text>
      <text x="354" y="214" textAnchor="middle" fontFamily={F} fontSize="12.5" fontWeight="500" fill={INK}>Your browser</text>
      <path d="M200 64C222 46 238 46 258 64" fill="none" stroke={ACC} strokeWidth="1.8" strokeLinecap="round" markerEnd="url(#tdoc-scene-head)" />
      <text x="230" y="42" textAnchor="middle" fontFamily={F} fontSize="11" fontWeight="500" fill={ACC}>doc</text>
      <path d="M260 160C238 178 222 178 202 160" fill="none" stroke={ACC} strokeWidth="1.8" strokeLinecap="round" markerEnd="url(#tdoc-scene-head)" />
      <text x="230" y="194" textAnchor="middle" fontFamily={F} fontSize="11" fontWeight="500" fill={ACC}>comments</text>
      {done ? (
        <>
          <rect x="404" y="18" width="46" height="22" rx="11" fill={ACC} /><text x="427" y="33" textAnchor="middle" fontFamily={F} fontSize="11.5" fontWeight="700" fill="#fff">v2</text>
          <text x="230" y="120" textAnchor="middle" fontFamily={F} fontSize="18" fill={ACC}>↻</text>
        </>
      ) : null}
    </svg>
  );
}
