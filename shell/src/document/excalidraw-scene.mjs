// Author data crosses into a trusted React editor. Bound it before restoring.
const TYPES = new Set(['rectangle', 'diamond', 'ellipse', 'line', 'arrow', 'text', 'freedraw']);
export function parseDiagramScene(json) {
  if (typeof json !== 'string' || json.length > 2_000_000) throw new Error('Diagram source exceeds 2 MB.');
  const scene = JSON.parse(json);
  if (scene?.type !== 'excalidraw' || !Array.isArray(scene.elements) || scene.elements.length > 5000) throw new Error('Invalid diagram source.');
  const ids = new Set();
  for (const element of scene.elements) {
    if (!element || !TYPES.has(element.type)) throw new Error('This version supports shapes, text and connectors only.');
    if (typeof element.id !== 'string' || ids.has(element.id)) throw new Error('Diagram element IDs must be unique.');
    ids.add(element.id);
    for (const key of ['x', 'y', 'width', 'height']) {
      if (!Number.isFinite(element[key]) || Math.abs(element[key]) > 1_000_000) throw new Error('Invalid diagram geometry.');
    }
  }
  return { ...scene, files: {} };
}
