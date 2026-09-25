// Client-side share posters for a claimed handle. White big-type cards
// (Feedback-page vibe), filled with tdoc.dev/@handle — no server render.
// X header keeps the curly-arrow annotation from the hand-tuned banner.

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

function normalizeHandle(handle) {
  return String(handle || '').replace(/^@/, '').trim().toLowerCase();
}

function fitText(ctx, text, maxWidth, maxPx, minPx) {
  let size = maxPx;
  while (size > minPx) {
    ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) return size;
    size -= 2;
  }
  ctx.font = `700 ${minPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  return minPx;
}

/** Curly arrow from annotation down onto the handle URL (X banner). */
function drawCurlyArrow(ctx, fromX, fromY, toX, toY) {
  ctx.save();
  ctx.strokeStyle = '#1a1a1a';
  ctx.fillStyle = '#1a1a1a';
  ctx.lineWidth = Math.max(3, (toY - fromY) * 0.04);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const midY = fromY + (toY - fromY) * 0.55;
  const pull = (toX - fromX) * 0.35;
  ctx.beginPath();
  ctx.moveTo(fromX, fromY);
  ctx.bezierCurveTo(fromX + pull, fromY + 8, toX - pull * 0.2, midY, toX, toY);
  ctx.stroke();

  // Arrowhead pointing down toward the URL.
  const head = Math.max(10, ctx.lineWidth * 3.2);
  ctx.beginPath();
  ctx.moveTo(toX, toY);
  ctx.lineTo(toX - head * 0.55, toY - head);
  ctx.lineTo(toX + head * 0.55, toY - head);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawAnnotation(ctx, width, height, urlY) {
  const annSize = Math.max(18, Math.round(height * 0.055));
  const subSize = Math.max(14, Math.round(height * 0.038));
  const ax = width * 0.5;
  const ay = height * 0.18;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#1a1a1a';
  ctx.font = `600 ${annSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText('my thoughts are here', ax, ay);
  ctx.fillStyle = '#6b6a66';
  ctx.font = `500 ${subSize}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText('@ ai native doc', ax, ay + annSize * 1.15);

  // Arrow starts under the annotation, lands just above the URL — no overlap.
  const fromY = ay + annSize * 1.15 + subSize * 0.9;
  const toY = urlY - Math.max(18, height * 0.06);
  drawCurlyArrow(ctx, ax + width * 0.08, fromY, ax, toY);
}

/** @returns {HTMLCanvasElement} */
export function renderHandlePoster(handle, kindId) {
  const kind = POSTER_KINDS.find((k) => k.id === kindId) || POSTER_KINDS[0];
  const h = normalizeHandle(handle);
  const line = `tdoc.dev/@${h || 'you'}`;
  const { width, height } = kind;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // X header crops edges + bottom-left avatar; keep copy in a safe band.
  const padX = kind.id === 'x-header' ? width * 0.12 : width * 0.1;
  const maxW = width - padX * 2;
  const maxPx = kind.id === 'square' ? Math.round(height * 0.09) : Math.round(height * 0.16);
  const minPx = Math.round(height * 0.06);
  const size = fitText(ctx, line, maxW, maxPx, minPx);

  // Slightly above center so X avatar / bottom crop does not eat the URL.
  // X header sits a bit lower to leave room for the annotation + arrow above.
  const cy = kind.id === 'x-header' ? height * 0.58 : height * 0.48;
  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText(line, width / 2, cy);

  if (kind.id === 'x-header') {
    drawAnnotation(ctx, width, height, cy - size * 0.35);
  }

  ctx.fillStyle = '#6b6a66';
  ctx.font = `500 ${Math.max(14, Math.round(height * 0.035))}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText('tdoc', width / 2, height - Math.round(height * 0.08));

  return canvas;
}

export function posterPreviewDataUrl(handle, kindId) {
  try {
    return renderHandlePoster(handle, kindId).toDataURL('image/png');
  } catch {
    return '';
  }
}

export function downloadHandlePoster(handle, kindId) {
  const kind = POSTER_KINDS.find((k) => k.id === kindId) || POSTER_KINDS[0];
  const h = normalizeHandle(handle);
  const canvas = renderHandlePoster(h, kind.id);
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
