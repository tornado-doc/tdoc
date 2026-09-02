export const TOP_BAR_HEIGHT = 48;

export const QUICK_REACTIONS = [
  '👍',
  '❤️',
  '🔥',
  '🎉',
  '😂',
  '🤔',
  '👀',
  '🚀',
  '✅',
  '❌',
  '❓',
  '❗',
  'LGTM',
];

export function avatarFor(author) {
  const key = String(author?.login || author?.name || '').toLowerCase();
  if (author?.kind !== 'agent') return author?.avatar_url || '';
  if (key.includes('claude') || key.includes('anthropic')) {
    return 'https://cdn.simpleicons.org/claude/d97757';
  }
  if (key.includes('grok') || key.includes('xai')) return 'https://github.com/xai-org.png';
  if (key.includes('gemini')) return 'https://cdn.simpleicons.org/googlegemini/8e75b2';
  if (key.includes('cursor')) return 'https://cdn.simpleicons.org/cursor/000000';
  return 'https://github.com/openai.png';
}

export function anchorFromSelection(selection) {
  if (selection.kind === 'element') {
    return {
      kind: 'element',
      selector: selection.selector,
      label: selection.label,
    };
  }
  return {
    kind: 'text',
    text: selection.text,
    context_before: selection.context_before,
    context_after: selection.context_after,
    // Which occurrence of this text was selected, counted by the frame. The
    // resolver falls back to it when context cannot tell two matches apart;
    // an anchor written before this existed simply has no number, and
    // resolves the way it always did.
    ...(typeof selection.occurrence === 'number' && typeof selection.occurrences === 'number'
      ? { occurrence: selection.occurrence, occurrences: selection.occurrences }
      : {}),
  };
}

export function layoutPins(pins, docHeight) {
  const rows = pins
    .map((pin) => ({ y: pin.docY, comment: pin }))
    .sort((left, right) => left.y - right.y);

  const elementGroups = new Map();
  for (const row of rows) {
    const key = row.comment.elementKey;
    if (!key) continue;
    if (!elementGroups.has(key)) elementGroups.set(key, []);
    elementGroups.get(key).push(row);
  }
  for (const group of elementGroups.values()) {
    if (group.length < 2) continue;
    const height = group[0].comment.elementHeight || 0;
    const usable = Math.max(0, height - 28);
    if (usable < 32) continue;
    const step = Math.max(32, usable / (group.length - 1));
    group.forEach((row, index) => {
      row.y = group[0].comment.elementTop + index * step;
    });
  }
  rows.sort((left, right) => left.y - right.y);
  const clusters = [];

  for (const row of rows) {
    const previous = clusters.at(-1);
    if (previous && row.y - previous.maxY <= 12) {
      previous.items.push(row);
      previous.maxY = row.y;
      previous.y = (previous.items[0].y + row.y) / 2;
    } else {
      clusters.push({ y: row.y, maxY: row.y, items: [row] });
    }
  }

  const placed = [];
  let previousY = -Infinity;
  for (const cluster of clusters) {
    const y = Math.max(cluster.y, previousY + 32);
    if (y > (docHeight || 1e7) && placed.length) {
      placed.at(-1).items.push(...cluster.items);
      continue;
    }
    placed.push({
      ...cluster,
      y,
      key: cluster.items.map((item) => item.comment.id).sort().join('|'),
    });
    previousY = y;
  }
  return placed;
}

export function copyText(text) {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => false);
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return Promise.resolve(copied);
}
