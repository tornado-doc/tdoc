// The CLI and Worker use this exact validator before accepting a preview card.
// SVG is a small, self-contained drawing format here, not a general web page.
function previewNormalizeSvg(input) {
  if (typeof input !== 'string' || input.length > 128 * 1024 || new TextEncoder().encode(input).length > 128 * 1024) {
    return { error: 'invalid_preview_svg' };
  }
  // Prelude comments are accepted before the drawing only. Removing comments
  // inside markup can join otherwise harmless fragments into a new tag.
  let svg = input.replace(/^\uFEFF/, '').trim();
  const prelude = svg.match(/^(?:<\?xml\s[^?]*\?>\s*|<!--[\s\S]*?-->\s*)*/i);
  svg = svg.slice(prelude[0].length);
  const root = svg.match(/^<svg\b([^>]*)>/);
  if (!root || !/(?:^|\s)xmlns\s*=\s*["']http:\/\/www\.w3\.org\/2000\/svg["']/.test(root[1])
    || !/(?:^|\s)width\s*=\s*["']1200["']/.test(root[1]) || !/(?:^|\s)height\s*=\s*["']630["']/.test(root[1])) {
    return { error: 'invalid_preview_dimensions' };
  }
  if (!/<\/svg\s*>\s*$/.test(svg) || /<\s*[!?]/.test(svg)
    || /(?:^|[\s<])(?:on[a-z]+|href|filter|mask|opacity|stroke-dasharray)\s*=|\bxlink:href\s*=/i.test(svg)) {
    return { error: 'unsafe_preview_svg' };
  }
  // No external resources, scriptable CSS or custom entities. Local paint
  // servers (url(#id)) are permitted for gradients defined in this SVG.
  const resourceScan = svg.replace(/\bxmlns=["']http:\/\/www\.w3\.org\/2000\/svg["']/g, '')
    .replace(/\bxmlns:xlink=["']http:\/\/www\.w3\.org\/1999\/xlink["']/g, '');
  if (/(?:https?:|data:|javascript:|@import|expression\s*\(|&#|&(?!(?:amp|lt|gt|quot|apos);))/i.test(resourceScan)) {
    return { error: 'unsafe_preview_svg' };
  }
  const allowed = new Set(['svg', 'g', 'defs', 'linearGradient', 'radialGradient', 'stop', 'rect', 'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'text', 'tspan']);
  const tags = [...svg.matchAll(/<\/?\s*([A-Za-z][\w:-]*)\b[^>]*>/g)];
  if (!tags.length || tags.length > 500 || tags.some((match) => !allowed.has(match[1]))) {
    return { error: 'unsafe_preview_svg' };
  }
  const paintTags = new Set(['rect', 'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'text', 'tspan']);
  let paintCount = 0;
  let paintedRectArea = 0;
  let geometryLength = 0;
  const numericAttribute = (tag, name, fullScale = 1) => {
    const raw = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'i'));
    if (!raw) return null;
    const value = raw[2].trim();
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?%?$/i.test(value)) return NaN;
    return value.endsWith('%') ? Number(value.slice(0, -1)) * fullScale / 100 : Number(value);
  };
  for (const match of tags) {
    if (match[0].startsWith('</')) continue;
    if (paintTags.has(match[1])) paintCount += 1;
    const geometry = match[0].match(/\s(?:d|points)\s*=\s*(["'])(.*?)\1/s);
    if (geometry) geometryLength += geometry[2].length;
    const strokeWidth = numericAttribute(match[0], 'stroke-width');
    if (strokeWidth !== null && (!Number.isFinite(strokeWidth) || strokeWidth > 64)) return { error: 'unsafe_preview_svg' };
    if (/\bspreadMethod\s*=\s*["'](?:reflect|repeat)["']/i.test(match[0])) return { error: 'unsafe_preview_svg' };
    if (match[1] === 'radialGradient') {
      const radius = numericAttribute(match[0], 'r', 1);
      if (radius !== null && (!Number.isFinite(radius) || radius < 0.1)) return { error: 'unsafe_preview_svg' };
    }
    if (match[1] === 'rect') {
      const width = numericAttribute(match[0], 'width', 1200);
      const height = numericAttribute(match[0], 'height', 630);
      if ((width !== null && !Number.isFinite(width)) || (height !== null && !Number.isFinite(height))) return { error: 'unsafe_preview_svg' };
      paintedRectArea += (width == null ? 1200 : width) * (height == null ? 630 : height);
    }
  }
  if (paintCount > 96 || paintedRectArea > 1200 * 630 * 10 || geometryLength > 20000) return { error: 'unsafe_preview_svg' };
  const stack = [];
  let cursor = 0;
  let textLength = 0;
  for (const match of tags) {
    const betweenTags = svg.slice(cursor, match.index);
    if (betweenTags.includes('<')) return { error: 'invalid_preview_svg' };
    textLength += betweenTags.length;
    cursor = match.index + match[0].length;
    if (/^<\//.test(match[0])) {
      if (stack.pop() !== match[1]) return { error: 'invalid_preview_svg' };
    } else if (!/\/\s*>$/.test(match[0])) {
      stack.push(match[1]);
    }
  }
  if (stack.length || svg.slice(cursor).trim()) return { error: 'invalid_preview_svg' };
  if (textLength > 20000 || [...svg.matchAll(/\bd\s*=\s*(["'])(.*?)\1/gs)].some((match) => match[2].length > 20000)) {
    return { error: 'unsafe_preview_svg' };
  }
  const ids = new Set([...svg.matchAll(/\bid\s*=\s*(["'])([A-Za-z][\w.-]*)\1/g)].map((match) => match[2]));
  let paintRefs = 0;
  for (const match of svg.matchAll(/url\s*\(\s*([^)]*)\)/gi)) {
    paintRefs += 1;
    const local = match[1].trim().match(/^#([A-Za-z][\w.-]*)$/);
    if (!local || !ids.has(local[1])) return { error: 'unsafe_preview_svg' };
  }
  if (paintRefs > 16) return { error: 'unsafe_preview_svg' };
  // The renderer should never see a URI or costly effects hidden inside CSS.
  if (/\bstyle\s*=\s*(["'])(.*?)\1/gs.test(svg)) {
    for (const [, , style] of svg.matchAll(/\bstyle\s*=\s*(["'])(.*?)\1/gs)) {
      if (/(?:^|[;\s])(?:filter|mask|opacity|stroke-width|stroke-dasharray|animation|import|background|content)\s*:/i.test(style)) return { error: 'unsafe_preview_svg' };
    }
  }
  return { svg };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { previewNormalizeSvg };
