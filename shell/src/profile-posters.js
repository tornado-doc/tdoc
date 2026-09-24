// Client-side share posters for a claimed handle. White big-type cards
// (Feedback-page vibe), filled with tdoc.dev/@handle — no server render.

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
  const cy = kind.id === 'x-header' ? height * 0.42 : height * 0.48;
  ctx.fillStyle = '#1a1a1a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText(line, width / 2, cy);

  ctx.fillStyle = '#6b6a66';
  ctx.font = `500 ${Math.max(14, Math.round(height * 0.035))}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  ctx.fillText('tdoc', width / 2, height - Math.round(height * 0.08));

  return canvas;
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
