import React, { Component, lazy, Suspense } from 'react';
import { AppDialog } from '../ui/dialog.jsx';
const ExcalidrawEditor = lazy(() => import('./excalidraw-editor.jsx'));

class DiagramBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <p role="alert">The diagram editor could not load. Close and reopen it to try again. The document is unchanged.</p> : this.props.children;
  }
}

export function DiagramDialog({ diagram, canApply, onApply, onClose }) {
  if (!diagram) return null;
  return <AppDialog open onOpenChange={(open) => { if (!open) onClose(); }}
    className="tdoc-diagram-dialog" title={diagram.title || 'Edit diagram'}
    description={canApply ? 'Apply your changes, then save the document to create a new version.' : 'Try editing a copy. Changes here do not change the published document. Download your copy to keep it.'}
    actions={<button type="button" onClick={onClose}>Close</button>}>
    <DiagramBoundary key={diagram.id}><Suspense fallback={<p role="status">Loading Excalidraw…</p>}>
      <ExcalidrawEditor scene={diagram.scene} canApply={canApply} onApply={onApply} />
    </Suspense></DiagramBoundary>
  </AppDialog>;
}
