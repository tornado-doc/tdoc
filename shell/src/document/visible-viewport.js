import { useEffect, useState } from 'react';

// The keyboard can both shrink and shift the visual viewport on iOS. Fixed
// overlays need its visible band, not just the layout viewport dimensions.
export function readVisibleViewport() {
  const visual = window.visualViewport;
  const width = Math.round(visual?.width > 0 ? visual.width : window.innerWidth);
  const height = Math.round(visual?.height > 0 ? visual.height : window.innerHeight);
  const offsetTop = Math.round(visual?.offsetTop || 0);
  const offsetLeft = Math.round(visual?.offsetLeft || 0);
  return {
    width, height, offsetTop, offsetLeft,
    bottom: Math.max(0, window.innerHeight - offsetTop - height),
  };
}

export function useVisibleViewport(enabled = true) {
  const [viewport, setViewport] = useState(readVisibleViewport);
  useEffect(() => {
    if (!enabled) return undefined;
    const update = () => setViewport(readVisibleViewport());
    update();
    const visual = window.visualViewport;
    visual?.addEventListener('resize', update);
    visual?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      visual?.removeEventListener('resize', update);
      visual?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [enabled]);
  return viewport;
}
