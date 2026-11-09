import { useEffect, useState } from 'react';

// One phone breakpoint for every comment surface: below this width the doc
// page swaps the margin for a drawer and the feedback widget's panel takes
// the whole screen. (CSS uses the same number: @media (max-width: 700px).)
export const NARROW_PX = 700;

export function isNarrowViewport(width = typeof window !== 'undefined' ? window.innerWidth : NARROW_PX) {
  return width < NARROW_PX;
}

// `bodyClass` puts the answer on <body> for CSS (the doc page's tdoc-narrow);
// the widget lives in a shadow root on someone else's page and passes none.
export function useNarrowViewport({ bodyClass = null } = {}) {
  const [narrow, setNarrow] = useState(() => isNarrowViewport());

  useEffect(() => {
    const update = () => setNarrow(isNarrowViewport());
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (!bodyClass) return;
    document.body.classList.toggle(bodyClass, narrow);
  }, [narrow, bodyClass]);

  return narrow;
}
