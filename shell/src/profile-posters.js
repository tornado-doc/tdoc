// Client-side share posters for a claimed handle. White big-type cards
// filled with tdoc.dev/@handle — no server render.
// All sizes: Caveat annotation (white stroke + blue fill), blue @handle.
// Optional curly arrow; annotation lines are caller-editable.

export const POSTER_KINDS = [
  {
    id: 'x-header',
    label: 'X header',
    hint: '1500 × 500 — profile banner',
    width: 1500,
    height: 500,
  },
  {
    id: 'og',
    label: 'Link preview',
    hint: '1200 × 630 — Open Graph / Discord',
    width: 1200,
    height: 630,
  },
  {
    id: 'square',
    label: 'Square',
    hint: '1080 × 1080 — posts / stories crop',
    width: 1080,
    height: 1080,
  },
];

export const DEFAULT_ANNOTATION_LINES = ['my thoughts are here', '@ ai native doc'];

const ACCENT = '#1652f0';
const INK = '#1a1a1a';
const MUTED = '#6b6a66';
const HAND_STACK = '"Caveat", "Segoe Print", "Bradley Hand", "Comic Sans MS", cursive';
const UI_STACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';

function normalizeHandle(handle) {
  return String(handle || '').replace(/^@/, '').trim().toLowerCase();
}

let fontsPromise = null;

/** Load Caveat so canvas paint matches the hand-tuned banner. */
export function ensurePosterFonts() {
  if (typeof document === 'undefined') return Promise.resolve();
  if (fontsPromise) return fontsPromise;
  fontsPromise = (async () => {
    if (!document.getElementById('tdoc-poster-fonts')) {
      const link = document.createElement('link');
      link.id = 'tdoc-poster-fonts';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&display=swap';
      document.head.appendChild(link);
    }
    try {
      if (document.fonts && document.fonts.load) {
        await document.fonts.load(`700 32px ${HAND_STACK}`);
        await document.fonts.ready;
      }
    } catch {
      /* system cursive fallback still paints */
    }
  })();
  return fontsPromise;
}

if (typeof document !== 'undefined') {
  ensurePosterFonts();
}

function fitText(ctx, text, maxWidth, maxPx, minPx) {
  let size = maxPx;
  while (size > minPx) {
    ctx.font = `700 ${size}px ${UI_STACK}`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 2;
  }
  ctx.font = `700 ${minPx}px ${UI_STACK}`;
  return minPx;
}

/** Stroked curly arrow (hand-tuned SVG path, scaled to canvas). */
function drawCurlyArrow(ctx, fromX, fromY, toX, toY) {
  ctx.save();
  ctx.strokeStyle = ACCENT;
  ctx.fillStyle = ACCENT;
  ctx.lineWidth = Math.max(3.4, (toY - fromY) * 0.045);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const c1x = fromX - (fromX - toX) * 0.15;
  const c1y = fromY + (toY - fromY) * 0.35;
  const c2x = toX + (fromX - toX) * 0.35;
  const c2y = fromY + (toY - fromY) * 0.75;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.bezierCurveTo(c1x, c1y, c2x, c2y, toX, toY);
  ctx.stroke();

  const tx = toX - c2x;
  const ty = toY - c2y;
  const len = Math.hypot(tx, ty) || 1;
  const ux = tx / len;
  const uy = ty / len;
  const head = Math.max(12, ctx.lineWidth * 3.4);
  const px = -uy;
  const py = ux;
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - ux * head + px * head * 0.45, toY - uy * head + py * head * 0.45);
  ctx.lineTo(toX - ux * head - px * head * 0.45, toY - uy * head - py * head * 0.45);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Hand-font annotation with white stroke + blue fill (Excalidraw vibe). */
function drawHandLine(ctx, text, x, y, size, rotateRad) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotateRad);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `700 ${size}px ${HAND_STACK}`;
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.lineWidth = Math.max(4, size * 0.14);
  ctx.strokeStyle = '#ffffff';
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = ACCENT;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function normalizeAnnotationLines(lines) {
  const raw = Array.isArray(lines) ? lines : DEFAULT_ANNOTATION_LINES;
  const cleaned = raw.map((line) => String(line || '').trim()).filter(Boolean).slice(0, 3);
  return cleaned.length ? cleaned : DEFAULT_ANNOTATION_LINES;
}

function drawAnnotation(ctx, width, height, handleX, urlY, { lines, showArrow }) {
  const ax = width * 0.6;
  const ay = height * 0.096;
  const annSize = Math.max(22, Math.round(height * (height > 600 ? 0.04 : 0.064)));
  const lineGap = annSize * 1.2;
  const tilt = (-5 * Math.PI) / 180;
  const textLines = normalizeAnnotationLines(lines);

  textLines.forEach((line, i) => {
    drawHandLine(ctx, line, ax, ay + i * lineGap, annSize, tilt);
  });

  if (!showArrow) return;
  const fromX = ax + annSize * 2.8;
  const fromY = ay + textLines.length * lineGap * 0.85;
  const toX = handleX;
  const toY = urlY - Math.max(14, height * 0.04);
  drawCurlyArrow(ctx, fromX, fromY, toX, toY);
}

function drawHandleUrl(ctx, width, cy, size, handle) {
  const prefix = 'tdoc.dev/';
  const suffix = `@${handle || 'you'}`;
  ctx.font = `700 ${size}px ${UI_STACK}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const prefixW = ctx.measureText(prefix).width;
  const suffixW = ctx.measureText(suffix).width;
  const total = prefixW + suffixW;
  const startX = (width - total) / 2;
  ctx.fillStyle = INK;
  ctx.fillText(prefix, startX, cy);
  ctx.fillStyle = ACCENT;
  ctx.fillText(suffix, startX + prefixW, cy);
  return startX + prefixW + suffixW * 0.45;
}

/**
 * @param {string} handle
 * @param {string} kindId
 * @param {{ annotationLines?: string[], showArrow?: boolean }} [opts]
 * @returns {HTMLCanvasElement}
 */
export function renderHandlePoster(handle, kindId, opts = {}) {
  const kind = POSTER_KINDS.find((k) => k.id === kindId) || POSTER_KINDS[0];
  const h = normalizeHandle(handle);
  const line = `tdoc.dev/@${h || 'you'}`;
  const { width, height } = kind;
  const showArrow = opts.showArrow !== false;
  const annotationLines = normalizeAnnotationLines(opts.annotationLines);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  const padX = kind.id === 'x-header' ? width * 0.12 : width * 0.1;
  const maxW = width - padX * 2;
  const maxPx = kind.id === 'square' ? Math.round(height * 0.09) : Math.round(height * 0.16);
  const minPx = Math.round(height * 0.06);
  const size = fitText(ctx, line, maxW, maxPx, minPx);

  // Leave room above for annotation on every size.
  const cy = kind.id === 'square' ? height * 0.52 : height * 0.52;
  const handleX = drawHandleUrl(ctx, width, cy, size, h);
  drawAnnotation(ctx, width, height, handleX, cy - size * 0.35, {
    lines: annotationLines,
    showArrow,
  });

  ctx.fillStyle = MUTED;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const subSize = Math.max(14, Math.round(height * (kind.id === 'x-header' ? 0.048 : 0.035)));
  ctx.font = `500 ${subSize}px ${UI_STACK}`;
  ctx.fillText(
    kind.id === 'x-header' ? 'writing, in public' : 'tdoc',
    width / 2,
    kind.id === 'x-header' ? cy + size * 0.72 : height - Math.round(height * 0.08),
  );

  return canvas;
}

export function posterPreviewDataUrl(handle, kindId, opts) {
  try {
    return renderHandlePoster(handle, kindId, opts).toDataURL('image/png');
  } catch {
    return '';
  }
}

export function downloadHandlePoster(handle, kindId, opts) {
  const kind = POSTER_KINDS.find((k) => k.id === kindId) || POSTER_KINDS[0];
  const h = normalizeHandle(handle);
  const canvas = renderHandlePoster(h, kind.id, opts);
  const a = document.createElement('a');
  a.download = `tdoc-${h || 'handle'}-${kind.id}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
}

export function profileUrl(handle) {
  const h = normalizeHandle(handle);
  return h ? `https://tdoc.dev/@${h}` : 'https://tdoc.dev';
}

/** Claim / change-handle navigations set this so Share opens even if ?share= is dropped. */
export const SHARE_FLAG_KEY = 'tdoc-open-share-poster';

export function markShareAfterNav() {
  try { sessionStorage.setItem(SHARE_FLAG_KEY, '1'); } catch { /* ignore */ }
}

export function consumeShareAfterNav() {
  try {
    if (sessionStorage.getItem(SHARE_FLAG_KEY) !== '1') return false;
    sessionStorage.removeItem(SHARE_FLAG_KEY);
    return true;
  } catch {
    return false;
  }
}
