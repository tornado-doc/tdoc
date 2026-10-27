import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { CommentThreadList } from './comment-thread-list.jsx';
import { commentPinState } from './comment-pin.jsx';

// The author frame reserves a slot after its first heading. The shell owns the
// actual controls, so author CSS and scripts cannot change comment behavior.
export function DocumentCommentsSection({ slot, frameTop, scrollY, comments, active,
  selectedId, cardProps, seenMap, handoffViewer, isOwner, onAdd, onHeight, onScroll,
  composer = null }) {
  const sectionRef = useRef(null);
  const touchY = useRef(null);
  const scrollInFrame = (delta) => {
    const section = sectionRef.current;
    if (!section) return false;
    const atTop = section.scrollTop <= 0;
    const atBottom = section.scrollTop + section.clientHeight >= section.scrollHeight - 1;
    if ((delta < 0 && atTop) || (delta > 0 && atBottom)) {
      onScroll(delta);
      return true;
    }
    return false;
  };
  useLayoutEffect(() => {
    const section = sectionRef.current;
    if (!section || !slot || !active) { onHeight(0); return undefined; }
    const measure = () => onHeight(Math.ceil(section.getBoundingClientRect().height / (slot.scale || 1)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(section);
    return () => observer.disconnect();
  }, [active, onHeight, slot?.scale, slot?.width, Boolean(slot)]);
  useEffect(() => {
    const section = sectionRef.current;
    if (!section || !active) return undefined;
    // The overlay sits above the frame. At its scroll edges, forward gestures
    // into the frame; native non-passive listeners let us stop the page from
    // also scrolling (React's wheel/touch listeners are passive).
    const wheel = (event) => {
      if (scrollInFrame(event.deltaY)) event.preventDefault();
    };
    const touchStart = (event) => { touchY.current = event.touches[0]?.clientY ?? null; };
    const touchMove = (event) => {
      const y = event.touches[0]?.clientY;
      if (y == null || touchY.current == null) return;
      const delta = touchY.current - y;
      touchY.current = y;
      if (scrollInFrame(delta) && event.cancelable) event.preventDefault();
    };
    const touchEnd = () => { touchY.current = null; };
    section.addEventListener('wheel', wheel, { passive: false });
    section.addEventListener('touchstart', touchStart, { passive: true });
    section.addEventListener('touchmove', touchMove, { passive: false });
    section.addEventListener('touchend', touchEnd);
    return () => {
      section.removeEventListener('wheel', wheel);
      section.removeEventListener('touchstart', touchStart);
      section.removeEventListener('touchmove', touchMove);
      section.removeEventListener('touchend', touchEnd);
    };
  }, [active, onScroll]);

  if (!slot || !active) return null;
  const left = Math.max(12, Math.min(slot.left, window.innerWidth - 44));
  const width = Math.max(0, Math.min(slot.width, window.innerWidth - left - 12));
  return (
    <div className="tdoc-document-comments-layer" style={{ top: frameTop }}>
      <section
        ref={sectionRef}
        className="tdoc-document-comments"
        aria-label="Comments on this document"
        style={{ top: slot.docY - scrollY, left, width,
          maxHeight: Math.max(120, window.innerHeight - frameTop - 16) }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {comments.length ? <h2>On this document</h2> : null}
        <CommentThreadList
          comments={comments}
          cardProps={cardProps}
          selectedId={selectedId}
          isAnchored={() => true}
          isUnread={(comment) => commentPinState(comment, { seenMap, handoffViewer, isOwner }).unread}
          itemClassName="tdoc-document-comment-row"
        />
        {composer || (onAdd ? (
          <button type="button" className="tdoc-document-comment-add" onClick={onAdd}>Add a comment…</button>
        ) : null)}
      </section>
    </div>
  );
}
