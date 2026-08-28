import { useCallback, useEffect, useRef, useState } from 'react';

export function useFrameBridge(handlers) {
  const frameRef = useRef(null);
  const handlersRef = useRef(handlers);
  const [layout, setLayout] = useState({
    pins: [],
    scrollY: 0,
    articleRight: window.innerWidth - 44,
    docHeight: 1e7,
    footerVisible: false,
  });

  handlersRef.current = handlers;

  const send = useCallback((message) => {
    frameRef.current?.contentWindow?.postMessage({
      source: 'tdoc-shell',
      ...message,
    }, '*');
  }, []);

  useEffect(() => {
    const receive = (event) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = event.data;
      if (!message || message.source !== 'tdoc-frame') return;

      if (message.type === 'tdoc:pins') {
        setLayout((current) => ({
          ...current,
          pins: message.pins || [],
          scrollY: message.scrollY || 0,
          articleRight: message.articleRight || window.innerWidth - 44,
          docHeight: message.docHeight || 1e7,
        }));
      } else if (message.type === 'tdoc:scroll') {
        setLayout((current) => ({
          ...current,
          scrollY: message.scrollY || 0,
          footerVisible: Boolean(
            message.innerH && message.scrollY + message.innerH >= message.height - 4
          ),
        }));
      }

      const handler = handlersRef.current?.[message.type];
      handler?.(message);
    };

    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  return { frameRef, layout, send };
}
