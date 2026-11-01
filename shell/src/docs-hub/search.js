const SEARCH_FIELDS = new Set(['title', 'slug', 'preview', 'path']);

// A plain term searches every useful field. Prefixes narrow one term without
// adding another toolbar control; quotes keep a multi-word value together.
export function parseCatalogQuery(input) {
  const terms = [];
  const pattern = /(?:(title|slug|preview|path):)?(?:"([^"]*)"|(\S+))/gi;
  let match;
  while ((match = pattern.exec(String(input || '')))) {
    const field = String(match[1] || '').toLowerCase();
    const value = String(match[2] ?? match[3] ?? '').trim().toLowerCase();
    if (value) terms.push({ field: SEARCH_FIELDS.has(field) ? field : '', value });
  }
  return terms;
}

export function folderPathLabel(folderId, folderById) {
  const names = [];
  const seen = new Set();
  let current = folderById.get(folderId);
  while (current && names.length < 8 && !seen.has(current.id)) {
    seen.add(current.id);
    names.unshift(current.name);
    current = folderById.get(current.parent);
  }
  return names.join(' › ');
}

export function matchesCatalogQuery(doc, path, input) {
  const fields = {
    title: String(doc.title || '').toLowerCase(),
    slug: String(doc.slug || '').toLowerCase(),
    preview: String(doc.excerpt || '').toLowerCase(),
    path: String(path || '').toLowerCase(),
  };
  return parseCatalogQuery(input).every(({ field, value }) => (
    field ? fields[field].includes(value) : Object.values(fields).some((text) => text.includes(value))
  ));
}

export function sortCatalogDocs(docs, sort) {
  return [...docs].sort((a, b) => {
    if (sort === 'title') return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
    return String(b[sort]).localeCompare(String(a[sort]));
  });
}

// What a folder row says it holds: its direct subfolders, and every doc in it
// or anywhere below it. A folder holding only folders is not empty.
export function folderContents(folders, docs) {
  const parentOf = new Map(folders.map((item) => [item.id, item.parent || '']));
  const stats = {};
  for (const item of folders) stats[item.id] = { folders: 0, docs: 0 };
  for (const item of folders) if (stats[item.parent || '']) stats[item.parent].folders += 1;
  for (const doc of docs) {
    const seen = new Set();
    for (let id = doc.folder || ''; stats[id] && !seen.has(id); id = parentOf.get(id)) {
      seen.add(id);
      stats[id].docs += 1;
    }
  }
  return stats;
}
