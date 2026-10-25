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
  if (/^<!doctype\b/i.test(svg)) return { error: 'preview_doctype_not_allowed' };
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
  if (!tags.length || tags.some((match) => !allowed.has(match[1]))) {
    return { error: 'unsafe_preview_svg' };
  }
  // Extra SVG viewports and a rescaled root can magnify a small shape over
  // the full card, bypassing the painted-area budget below.
  const rootViewBox = root[1].match(/\sviewBox\s*=\s*(["'])(.*?)\1/i);
  if (tags.filter((match) => match[1] === 'svg' && !match[0].startsWith('</')).length !== 1
    || (rootViewBox && !/^0\s+0\s+1200\s+630$/.test(rootViewBox[2].trim()))) {
    return { error: 'preview_viewport_limit' };
  }
  if (tags.length > 128) return { error: 'preview_element_limit' };
  const paintTags = new Set(['rect', 'circle', 'ellipse', 'line', 'path', 'polygon', 'polyline', 'text', 'tspan']);
  const canvasArea = 1200 * 630;
  let paintCount = 0;
  let paintedArea = 0;
  let gradientArea = 0;
  let gradientUses = 0;
  let geometryLength = 0;
  let totalStops = 0;
  const paintStack = [];
  const attribute = (tag, name) => {
    const raw = tag.match(new RegExp(`\\s${name}\\s*=\\s*(["'])(.*?)\\1`, 'is'));
    return raw ? raw[2].trim() : null;
  };
  const numericAttribute = (tag, name, fullScale = 1) => {
    const value = attribute(tag, name);
    if (value == null) return null;
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?:%|px)?$/i.test(value)) return NaN;
    if (value.endsWith('%')) return Number(value.slice(0, -1)) * fullScale / 100;
    return Number(value.replace(/px$/i, ''));
  };
  for (const match of tags) {
    const tag = match[0];
    if (tag.startsWith('</')) { paintStack.pop(); continue; }
    if (/\s(?:transform)\s*=/i.test(tag)) return { error: 'preview_transform_unsupported' };
    const parent = paintStack[paintStack.length - 1] || { fill: 'black', stroke: 'none', strokeWidth: 1, gradient: null, stops: 0 };
    const style = attribute(tag, 'style') || '';
    const css = Object.fromEntries(style.split(';').map((part) => part.split(/:(.*)/s)).filter((part) => part.length >= 2).map(([key, value]) => [key.trim().toLowerCase(), value.trim()]));
    const safeCss = new Set(['fill', 'stroke', 'fill-opacity', 'stroke-opacity', 'stop-color', 'stop-opacity', 'font-weight', 'font-family', 'text-anchor']);
    if (Object.keys(css).some((key) => !safeCss.has(key))) return { error: 'preview_style_limit' };
    const fill = css.fill || attribute(tag, 'fill') || parent.fill;
    const stroke = css.stroke || attribute(tag, 'stroke') || parent.stroke;
    const strokeWidth = numericAttribute(tag, 'stroke-width');
    if (strokeWidth !== null && (!Number.isFinite(strokeWidth) || strokeWidth < 0 || strokeWidth > 64)) return { error: 'preview_stroke_limit' };
    const fontSize = numericAttribute(tag, 'font-size');
    if (fontSize !== null && (!Number.isFinite(fontSize) || fontSize < 0 || fontSize > 96)) return { error: 'preview_font_size_limit' };
    const inheritedStrokeWidth = strokeWidth == null ? parent.strokeWidth : strokeWidth;
    const state = { fill, stroke, strokeWidth: inheritedStrokeWidth, gradient: parent.gradient, stops: 0 };
    if (match[1] === 'linearGradient' || match[1] === 'radialGradient') state.gradient = state;
    if (match[1] === 'stop' && parent.gradient) {
      parent.gradient.stops += 1;
      totalStops += 1;
      if (parent.gradient.stops > 16 || totalStops > 32) return { error: 'preview_gradient_stops_limit' };
    }
    if (paintTags.has(match[1])) paintCount += 1;
    const geometry = tag.match(/\s(?:d|points)\s*=\s*(["'])(.*?)\1/s);
    if (geometry) geometryLength += geometry[2].length;
    if (/\bspreadMethod\s*=\s*["'](?:reflect|repeat)["']/i.test(tag)) return { error: 'preview_gradient_spread_limit' };
    if (match[1] === 'radialGradient') {
      const radius = numericAttribute(tag, 'r', 1);
      if (radius !== null && (!Number.isFinite(radius) || radius < 0.25)) return { error: 'preview_gradient_radius_limit' };
    }
    let area = 0;
    if (match[1] === 'rect') {
      const width = numericAttribute(tag, 'width', 1200);
      const height = numericAttribute(tag, 'height', 630);
      if ((width !== null && (!Number.isFinite(width) || width < 0)) || (height !== null && (!Number.isFinite(height) || height < 0))) return { error: 'preview_geometry_limit' };
      const w = width == null ? 1200 : width;
      const h = height == null ? 630 : height;
      area = w * h + (stroke !== 'none' ? 2 * (w + h) * inheritedStrokeWidth : 0);
    } else if (match[1] === 'circle' || match[1] === 'ellipse') {
      const rx = numericAttribute(tag, match[1] === 'circle' ? 'r' : 'rx', 1200);
      const ry = match[1] === 'circle' ? rx : numericAttribute(tag, 'ry', 630);
      if (![rx, ry].every((n) => n == null || (Number.isFinite(n) && n >= 0))) return { error: 'preview_geometry_limit' };
      area = Math.PI * (rx || 0) * (ry || 0) + (stroke !== 'none' ? 2 * Math.PI * Math.max(rx || 0, ry || 0) * inheritedStrokeWidth : 0);
    } else if (['path', 'polygon', 'polyline'].includes(match[1])) {
      // Paths can use relative commands, curves, and winding. Charge one
      // canvas each rather than guessing a bounding box that undercounts.
      area = canvasArea;
    } else if (match[1] === 'line') {
      const x1 = numericAttribute(tag, 'x1', 1200) || 0;
      const y1 = numericAttribute(tag, 'y1', 630) || 0;
      const x2 = numericAttribute(tag, 'x2', 1200) || 0;
      const y2 = numericAttribute(tag, 'y2', 630) || 0;
      if (![x1, y1, x2, y2].every(Number.isFinite)) return { error: 'preview_geometry_limit' };
      area = Math.hypot(x2 - x1, y2 - y1) * inheritedStrokeWidth;
    } else if (match[1] === 'text' || match[1] === 'tspan') {
      area = canvasArea / 16;
    }
    if (paintTags.has(match[1])) {
      if (!Number.isFinite(area)) return { error: 'preview_geometry_limit' };
      paintedArea += area;
      if (/url\s*\(/i.test(fill) || /url\s*\(/i.test(stroke)) {
        gradientUses += 1;
        gradientArea += area;
      }
    }
    if (!/\/\s*>$/.test(tag)) paintStack.push(state);
  }
  if (paintCount > 48) return { error: 'preview_shape_limit' };
  if (paintedArea > canvasArea * 3) return { error: 'preview_painted_area_limit' };
  if (gradientUses > 4 || gradientArea > canvasArea) return { error: 'preview_gradient_paint_limit' };
  if (geometryLength > 4000) return { error: 'preview_geometry_limit' };
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
  if (textLength > 1200) return { error: 'preview_text_limit' };
  if ([...svg.matchAll(/\sd\s*=\s*(["'])(.*?)\1/gs)].some((match) => match[2].length > 4000)) {
    return { error: 'preview_geometry_limit' };
  }
  const ids = new Set([...svg.matchAll(/\bid\s*=\s*(["'])([A-Za-z][\w.-]*)\1/g)].map((match) => match[2]));
  let paintRefs = 0;
  for (const match of svg.matchAll(/url\s*\(\s*([^)]*)\)/gi)) {
    paintRefs += 1;
    const local = match[1].trim().match(/^(?:#([A-Za-z][\w.-]*)|"#([A-Za-z][\w.-]*)"|'#([A-Za-z][\w.-]*)')$/);
    if (!local || !ids.has(local[1] || local[2] || local[3])) return { error: 'unsafe_preview_svg' };
  }
  if (paintRefs > 16) return { error: 'preview_paint_refs_limit' };
  // The renderer should never see a URI or costly effects hidden inside CSS.
  if (/\bstyle\s*=\s*(["'])(.*?)\1/gs.test(svg)) {
    for (const [, , style] of svg.matchAll(/\bstyle\s*=\s*(["'])(.*?)\1/gs)) {
      if (/(?:^|[;\s])(?:filter|mask|opacity|stroke-width|stroke-dasharray|animation|import|background|content)\s*:/i.test(style)) return { error: 'unsafe_preview_svg' };
    }
  }
  return { svg };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { previewNormalizeSvg };
