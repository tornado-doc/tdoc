// Lightweight markdown subset for comment bodies. Pure tokens — the React
// layer maps them to nodes (never HTML strings, never a markdown library).
// Scope: headings, **bold**, `inline code`, fenced ``` blocks, lists,
// and http(s) links. URLs are deliberately limited to http(s).

const INLINE_RE = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<]+[^\s<.,:;!?)]))/g;

function parseInline(text) {
  const source = String(text || '');
  if (!source) return [];
  const nodes = [];
  let last = 0;
  let match;
  INLINE_RE.lastIndex = 0;
  while ((match = INLINE_RE.exec(source))) {
    if (match.index > last) nodes.push({ type: 'text', value: source.slice(last, match.index) });
    if (match[2] != null) nodes.push({ type: 'strong', value: match[2] });
    else if (match[3] != null) nodes.push({ type: 'code', value: match[3] });
    else if (match[4] != null) nodes.push({ type: 'link', label: match[4], value: match[5] });
    else nodes.push({ type: 'link', value: match[6] });
    last = match.index + match[0].length;
  }
  if (last < source.length) nodes.push({ type: 'text', value: source.slice(last) });
  return nodes;
}

function isListLine(line) {
  return /^([-*]|\d+\.) /.test(line);
}

function isHeadingLine(line) { return /^#{1,6} /.test(line); }

function parseParagraph(para) {
  const lines = String(para || '').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (isHeadingLine(lines[i])) {
      const level = lines[i].match(/^#+/)[0].length;
      blocks.push({ type: 'heading', level, children: parseInline(lines[i].slice(level + 1)) });
      i += 1;
      continue;
    }
    if (isListLine(lines[i])) {
      const ordered = /^\d+\. /.test(lines[i]);
      const items = [];
      while (i < lines.length && isListLine(lines[i]) && /^\d+\. /.test(lines[i]) === ordered) {
        items.push(parseInline(lines[i].replace(/^([-*]|\d+\.) /, '')));
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    const chunk = [];
    while (i < lines.length && !isListLine(lines[i]) && !isHeadingLine(lines[i])) {
      chunk.push(lines[i]);
      i += 1;
    }
    const body = chunk.join('\n');
    if (body) blocks.push({ type: 'paragraph', children: parseInline(body) });
  }
  return blocks;
}

/** Parse a plain text run into a token tree (markdown subset). */
export function parseRichText(text) {
  const source = String(text || '');
  if (!source) return [];

  const fence = /```([^\n`]*)\n?([\s\S]*?)```/g;
  const segments = [];
  let last = 0;
  let match;
  while ((match = fence.exec(source))) {
    if (match.index > last) segments.push({ type: 'text', value: source.slice(last, match.index) });
    segments.push({ type: 'fence', value: match[2].replace(/\n$/, '') });
    last = match.index + match[0].length;
  }
  if (last < source.length) segments.push({ type: 'text', value: source.slice(last) });
  if (!segments.length) segments.push({ type: 'text', value: source });

  const out = [];
  for (const seg of segments) {
    if (seg.type === 'fence') {
      out.push({ type: 'fence', value: seg.value });
      continue;
    }
    const paragraphs = seg.value.split(/\n{2,}/);
    for (let p = 0; p < paragraphs.length; p += 1) {
      if (p > 0) out.push({ type: 'break' });
      out.push(...parseParagraph(paragraphs[p]));
    }
  }
  return out;
}
