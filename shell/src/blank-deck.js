import { createDocument, saveDocumentVersion } from './document/api.js';

// New › Slides › Blank deck: a three-card starter deck (shared/slides-markup.mjs),
// opened straight into Edit mode. The same create + first save as New sheet,
// so the deck is v1 and titled from its cover's heading.
export async function createBlankDeck(team) {
  const { blankDeckHtml } = await import('../../shared/slides-markup.mjs');
  const created = await createDocument(team || '');
  const saved = await saveDocumentVersion(created.slug, created.version || 1, blankDeckHtml());
  const next = new URL(saved.url || created.url, location.origin);
  next.searchParams.set('edit', '1');
  return { url: `${next.pathname}${next.search}` };
}
