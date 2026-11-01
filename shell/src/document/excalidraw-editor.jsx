import React, { useRef, useState } from 'react';
import { Excalidraw, exportToSvg, serializeAsJSON } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { parseDiagramScene } from './excalidraw-scene.mjs';

// The official editor is loaded only after opening an opt-in diagram.
export default function ExcalidrawEditor({ scene, onApply, canApply }) {
  const api = useRef(null);
  const fitted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function finish(download = false) {
    if (!api.current || busy) return;
    setBusy(true);
    setError('');
    try {
      const elements = api.current.getSceneElements();
      const appState = api.current.getAppState();
      const files = api.current.getFiles();
      const json = serializeAsJSON(elements, appState, files, 'local');
      parseDiagramScene(json);
      if (download) {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = 'diagram.excalidraw';
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } else {
        const svg = await exportToSvg({ elements, appState: { ...appState, exportWithDarkMode: false, exportBackground: true, exportEmbedScene: false }, files });
        await onApply(json, svg.outerHTML);
      }
    } catch (e) { setError(e.message || 'Could not export the diagram. Your edits are still here.'); }
    finally { setBusy(false); }
  }
  return <>
    <div className="tdoc-excalidraw-canvas">
      <Excalidraw
        initialData={{ ...scene, scrollToContent: true }}
        excalidrawAPI={(value) => { api.current = value; }}
        onChange={(elements) => {
          if (!fitted.current && api.current && elements.length) {
            fitted.current = true;
            requestAnimationFrame(() => api.current?.scrollToContent(api.current.getSceneElements(), { fitToContent: true, viewportZoomFactor: 0.8 }));
          }
        }}
        theme="light" aiEnabled={false} autoFocus
        validateEmbeddable={false}
        onLinkOpen={(_, event) => event.preventDefault()}
        onPaste={(data) => !data.files?.length}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false }, tools: { image: false } }}
      />
    </div>
    {error ? <p role="alert">{error}</p> : null}
    <div className="actions">
      <button type="button" onClick={() => api.current?.scrollToContent(api.current.getSceneElements(), { fitToContent: true, viewportZoomFactor: 0.8 })}>Fit diagram</button>
      <button type="button" disabled={busy} onClick={() => finish(true)}>Download .excalidraw</button>
      {canApply ? <button type="button" className="primary" disabled={busy} onClick={() => finish(false)}>{busy ? 'Applying…' : 'Apply to document'}</button> : null}
    </div>
  </>;
}
