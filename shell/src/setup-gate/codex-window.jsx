import React from 'react';

// The window the line is pasted into, drawn once.
//
// There was a copy of this per scene, which is how the second one ended up
// bouncing an app in a dock on a screen where no app is launched. One window,
// two scripts: a scene hands it a title and a stream of turns, and every part
// of the chrome -- the bar, the centred column, the composer that never goes
// away -- belongs to the window, not to the script.
//
// Measured against a real one rather than remembered: the bar carries its
// controls on both sides with the thread's name centred between them, the
// conversation is a column down the middle and not the full width, the human's
// turn is a dark bubble on the right, the assistant's is plain text with no
// bubble at all, a tool call collapses behind one grey line, and the composer
// sits at the bottom whether or not anything has been sent.

export function CodexWindow({ title, children, typing }) {
  return (
    <div className="cw">
      <div className="cw-bar">
        <span className="cw-lights"><i /><i /><i /></span>
        <span className="cw-bar-icons"><SidebarIcon /><ComposeIcon /></span>
        <span className="cw-title">{title}</span>
        <span className="cw-dots">⋯</span>
        <span className="cw-bar-right"><ShareIcon /> Share<ListIcon /><PanelIcon /></span>
      </div>
      <div className="cw-body">
        <div className="cw-col">{children}</div>
      </div>
      <Composer typing={typing} />
    </div>
  );
}

// The day and time above the first turn.
export function Stamp({ children }) {
  return <div className="cw-stamp">{children}</div>;
}

// The human's turn: a dark bubble, right-aligned, never the full width.
export function Ask({ children, caret = false }) {
  return (
    <div className="cw-ask">
      <span>{children}{caret ? <i className="cw-caret" /> : null}</span>
    </div>
  );
}

// What the assistant did before it answered. One grey line and a chevron,
// which is the whole of it until somebody opens it -- so the lines the tool
// printed only show while `open`, the way they only show when expanded.
export function Worked({ label, open = false, children }) {
  return (
    <div className="cw-worked">
      <button type="button" className="cw-worked-row" tabIndex={-1}>
        {label}<span className={open ? 'cw-chev open' : 'cw-chev'}>›</span>
      </button>
      {open ? <pre className="cw-tool">{children}</pre> : null}
      <hr className="cw-rule" />
    </div>
  );
}

// The assistant's turn. Plain text: no bubble, no avatar, no tint.
export function Answer({ children }) {
  return <div className="cw-answer">{children}</div>;
}

export function Feedback() {
  return (
    <div className="cw-feedback" aria-hidden="true">
      <CopyIcon /><ThumbIcon /><ShareArrowIcon /><EditIcon />
    </div>
  );
}

// Always there, whether or not anything has been said. A window whose composer
// disappears after the first message is not a window anybody has used.
function Composer({ typing }) {
  return (
    <div className="cw-composer">
      <div className="cw-field">{typing || 'Work with ChatGPT'}</div>
      <div className="cw-tools">
        <span className="cw-plus">+</span>
        <span className="cw-access"><WarnIcon /> Full access</span>
        <span className="cw-sp" />
        <span className="cw-model">GPT-5.6 Sol <em>Medium</em> ⌄</span>
        <MicIcon />
        <span className="cw-send">
          {/* A black disc with nothing in it is not a control. The real one
              carries the voice-mode waveform. */}
          <svg viewBox="0 0 22 22" width="15" height="15" aria-hidden="true">
            <g fill="#fff">
              <rect x="4" y="9" width="1.7" height="4" rx=".85" />
              <rect x="7.6" y="6.4" width="1.7" height="9.2" rx=".85" />
              <rect x="11.2" y="4.6" width="1.7" height="12.8" rx=".85" />
              <rect x="14.8" y="7.8" width="1.7" height="6.4" rx=".85" />
            </g>
          </svg>
        </span>
      </div>
    </div>
  );
}

/* --- the bar's own glyphs, drawn rather than named, so nothing 404s --- */
const s = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' };
const SidebarIcon = () => (<svg viewBox="0 0 20 20" width="17" height="17" {...s}><rect x="2.5" y="4" width="15" height="12" rx="2.5" /><path d="M8 4v12" /></svg>);
const ComposeIcon = () => (<svg viewBox="0 0 20 20" width="17" height="17" {...s}><path d="M4 13.5V16h2.5l7.6-7.6-2.5-2.5L4 13.5Z" /><path d="M12.4 5.1l2.5 2.5" /></svg>);
const ShareIcon = () => (<svg viewBox="0 0 20 20" width="15" height="15" {...s}><path d="M10 13V4" /><path d="M6.6 7.4 10 4l3.4 3.4" /><path d="M4.5 12.5V15a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5v-2.5" /></svg>);
const ListIcon = () => (<svg viewBox="0 0 20 20" width="16" height="16" {...s}><path d="M7 6h9M7 10h9M7 14h9" /><circle cx="4" cy="6" r=".9" fill="currentColor" stroke="none" /><circle cx="4" cy="10" r=".9" fill="currentColor" stroke="none" /><circle cx="4" cy="14" r=".9" fill="currentColor" stroke="none" /></svg>);
const PanelIcon = () => (<svg viewBox="0 0 20 20" width="16" height="16" {...s}><rect x="2.5" y="4" width="15" height="12" rx="2.5" /><path d="M13 4v12" /></svg>);
const CopyIcon = () => (<svg viewBox="0 0 20 20" width="15" height="15" {...s}><rect x="7" y="7" width="9" height="9" rx="2" /><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4H5.5A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" /></svg>);
const ThumbIcon = () => (<svg viewBox="0 0 20 20" width="15" height="15" {...s}><path d="M7 16V9l3.2-5a1.6 1.6 0 0 1 2.8 1.3L12.4 8H15a1.6 1.6 0 0 1 1.6 2l-1 5.1A1.6 1.6 0 0 1 14 16H7Z" /><path d="M7 9H4.6v7H7" /></svg>);
const ShareArrowIcon = () => (<svg viewBox="0 0 20 20" width="15" height="15" {...s}><path d="M4 16c0-4.4 3-6.6 8-6.8" /><path d="M9 5.5 15 10l-6 4.5" /></svg>);
const EditIcon = () => (<svg viewBox="0 0 20 20" width="15" height="15" {...s}><rect x="3" y="4" width="14" height="12" rx="2" /><path d="M12.6 7.4 8 12h1.8l4.6-4.6-1.8-1.8Z" /></svg>);
const WarnIcon = () => (<svg viewBox="0 0 20 20" width="13" height="13" {...s}><circle cx="10" cy="10" r="7" /><path d="M10 6.6v4.2" /><circle cx="10" cy="13.4" r=".8" fill="currentColor" stroke="none" /></svg>);
const MicIcon = () => (<svg viewBox="0 0 20 20" width="16" height="16" {...s}><rect x="7.6" y="3.2" width="4.8" height="8.6" rx="2.4" /><path d="M5 10a5 5 0 0 0 10 0" /><path d="M10 15v2" /></svg>);
