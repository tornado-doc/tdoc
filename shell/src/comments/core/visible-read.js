// A thread is read after it has stayed mostly in view for a full second.
// Leaving the viewport or backgrounding the tab restarts that second.
export function observeVisibleRead(element, onRead) {
  if (!element || typeof IntersectionObserver !== 'function') return () => {};
  let timer = null;
  let visible = false;
  let done = false;
  const cancel = () => { if (timer != null) clearTimeout(timer); timer = null; };
  const schedule = () => {
    if (!visible || done || document.visibilityState === 'hidden' || timer != null) return;
    timer = setTimeout(() => {
      timer = null;
      if (!visible || document.visibilityState === 'hidden' || done) return;
      done = true;
      onRead();
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    }, 1000);
  };
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') cancel();
    else schedule();
  };
  const observer = new IntersectionObserver(([entry]) => {
    visible = Boolean(entry?.isIntersecting && entry.intersectionRatio >= 0.6);
    if (visible) schedule(); else cancel();
  }, { threshold: [0, 0.6, 1] });
  observer.observe(element);
  document.addEventListener('visibilitychange', onVisibility);
  return () => {
    cancel();
    observer.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
