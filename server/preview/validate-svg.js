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
  if (!/<\/svg\s*>\s*$/.test(svg) || /<\s*[!?]/.test(svg) || /\b(?:on[a-z]+|href|filter|mask|opacity|stroke-dasharray)\s*=/i.test(svg)) {
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
  for (const match of svg.matchAll(/url\s*\(\s*([^)]*)\)/gi)) {
    const local = match[1].trim().match(/^#([A-Za-z][\w.-]*)$/);
    if (!local || !ids.has(local[1])) return { error: 'unsafe_preview_svg' };
  }
  // The renderer should never see a URI or costly effects hidden inside CSS.
  if (/\bstyle\s*=\s*(["'])(.*?)\1/gs.test(svg)) {
    for (const [, , style] of svg.matchAll(/\bstyle\s*=\s*(["'])(.*?)\1/gs)) {
      if (/(?:filter|mask|opacity|stroke-dasharray|animation|import|background|content)\s*:/i.test(style)) return { error: 'unsafe_preview_svg' };
    }
  }
  return { svg };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { previewNormalizeSvg };
