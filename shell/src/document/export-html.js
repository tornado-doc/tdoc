// The document's HTML, asked of the frame (tdoc:exportHtml). One answer per
// request id; a frame that does not answer in 15s is an error, not a hang.
export function createExportHtmlRequest(send) {
  const pending = new Map();
  return {
    request() {
      const requestId = `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => { pending.delete(requestId); reject(new Error('The document did not answer.')); }, 15_000);
        pending.set(requestId, (html) => { window.clearTimeout(timer); resolve(html); });
        send({ type: 'tdoc:exportHtml', requestId });
      });
    },
    handle(message) {
      const done = pending.get(message.requestId);
      if (!done || typeof message.html !== 'string') return;
      pending.delete(message.requestId);
      done(message.html);
    },
  };
}
