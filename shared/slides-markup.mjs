// tdoc's slide kit: the starter deck behind New › Slides › Blank deck, and the
// slides the browser editor adds to any deck (server/slides-edit.js). Three
// layouts -- Title, Bullets, Big number -- in the frame
// authoring/structure/slides.md teaches agents, so the slides viewer gives
// them Present, the phone reflow and slide numbers like any agent-made deck.
// Every word on them is ordinary text, so the editor edits it in place.
//
// This file is also bundled into the doc frame's script (frame-probe-source.js
// wraps it as TdocSlideKit), which takes no bundler at runtime: no imports,
// and `export` only on function and const declarations.
//
// The classes are prefixed (tds-) and their rules travel with the slides in
// one <style data-tdoc-slide-kit>: a slide added to an agent's deck brings its
// look along without touching the deck's own .slide rules.

export const KIT_CSS = [
  '.tds-slide{container-type:inline-size;aspect-ratio:16/9;position:relative;overflow:hidden;box-sizing:border-box;margin:0 0 48px;border-radius:12px;background:#fff;color:#17171a;box-shadow:0 1px 3px rgba(0,0,0,.08);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;}',
  '.tds-slide.tds-dark{background:#14161c;color:#fff;}',
  '.tds-inner{position:absolute;inset:0;display:flex;flex-direction:column;padding:4.2cqw 5.2cqw 3.4cqw;}',
  '.tds-top,.tds-foot{display:flex;justify-content:space-between;gap:2cqw;color:#6b6b76;font-size:max(1.1cqw,12px);}',
  '.tds-dark .tds-top,.tds-dark .tds-foot{color:#a9acb8;}',
  '.tds-body{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0;}',
  '.tds-slide h1{margin:0 0 1.6cqw;font-size:max(6cqw,30px);line-height:1.1;letter-spacing:-0.02em;}',
  '.tds-slide h2{margin:0 0 2.4cqw;font-size:max(4.2cqw,24px);line-height:1.15;letter-spacing:-0.015em;}',
  '.tds-slide h2.tds-display{font-size:max(5.4cqw,28px);}',
  '.tds-slide p,.tds-slide li{margin:0;font-size:max(1.9cqw,15px);line-height:1.45;}',
  '.tds-slide ul{margin:0;padding-left:1.2em;display:flex;flex-direction:column;gap:1.2cqw;}',
  '.tds-slide .tds-lead{color:#6b6b76;font-size:max(2.2cqw,16px);}',
  '.tds-dark .tds-lead{color:#c9ccd6;}',
  '.tds-accent{color:#2f5bea;}',
  '.tds-dark .tds-accent{color:#8fa8ff;}',
  '.tds-cols{display:grid;grid-template-columns:1fr 1fr;gap:4cqw;align-items:center;}',
  '.tds-slide .tds-num{margin:0 0 1cqw;font-size:max(11cqw,48px);font-weight:700;line-height:1;letter-spacing:-0.03em;color:#2f5bea;}',
  '.tds-figure{margin:0;aspect-ratio:4/3;border-radius:1cqw;overflow:hidden;background:#f0f1f4;}',
  '.tds-figure img{display:block;width:100%;height:100%;object-fit:cover;}',
  // An image slot nobody has filled is not shown to readers; while editing it
  // is a dashed box that says how to fill it.
  '.tds-figure:empty{display:none;}',
  'html[data-tdoc-editing] .tds-figure:empty{display:flex;align-items:center;justify-content:center;background:transparent;border:1.5px dashed #c8cbd4;}',
  'html[data-tdoc-editing] .tds-figure:empty::before{content:"Image: use the image button on this slide";padding:0 1em;text-align:center;color:#8a8d99;font-size:max(1.4cqw,13px);}',
  '@container (max-width: 640px){.tds-inner{position:static;min-height:56vw;padding:24px 20px;}.tds-cols{grid-template-columns:1fr;}}',
].join('\n');

export const SLIDE_LAYOUTS = [
  { id: 'title', label: 'Title', hint: 'A section or a statement, on dark' },
  { id: 'bullets', label: 'Bullets', hint: 'A headline and three points' },
  { id: 'number', label: 'Big number', hint: 'One number, a line, an image' },
];

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

// A slide's own id, written into data-tdoc-slide, so comments on it follow it
// wherever the deck moves it and whatever its heading becomes
// (selection/anchors/container.js reads the value as the slide's identity).
export function newSlideId() {
  let tail = '';
  try {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    tail = Array.from(bytes, (b) => (b % 36).toString(36)).join('');
  } catch (e) {
    tail = Math.random().toString(36).slice(2, 8);
  }
  return `s-${tail}`;
}

function frame(id, dark, name, top, body, foot) {
  return `<section class="tds-slide${dark ? ' tds-dark' : ''}" data-tdoc-slide="${escapeHtml(id)}" data-tdoc-artifact="${escapeHtml(name)}">
  <div class="tds-inner">
    <div class="tds-top"><span>${top}</span><span></span></div>
    <div class="tds-body">
${body}
    </div>
    <div class="tds-foot"><span>${foot}</span><span></span></div>
  </div>
</section>`;
}

// One slide's markup. `layout` is a SLIDE_LAYOUTS id, or 'cover' / 'closing'
// for the starter deck's first and last.
export function slideHtml(layout, options = {}) {
  const id = options.id || newSlideId();
  if (layout === 'cover') {
    const title = escapeHtml(options.title || 'Untitled deck');
    return frame(id, true, 'Cover', 'Presentation',
      `      <h1>${title}</h1>\n      <p class="tds-lead">A one-line subtitle: what this deck is about.</p>`, 'Your name');
  }
  if (layout === 'closing') {
    return frame(id, true, 'Next steps', 'Next steps',
      '      <h2>What we <span class="tds-accent">ask</span> of you</h2>\n      <p class="tds-lead">One line on the decision or the next step.</p>', 'Thank you');
  }
  if (layout === 'title') {
    return frame(id, true, 'Section', 'Section',
      '      <h2 class="tds-display">Section title</h2>\n      <p class="tds-lead">One line on what comes next.</p>', '');
  }
  if (layout === 'number') {
    return frame(id, false, 'Big number', 'Finding',
      '      <div class="tds-cols">\n        <div><p class="tds-num">42%</p><p>What the number means, in one line.</p></div>\n'
      + '        <figure class="tds-figure" data-tdoc-slide-image data-tdoc-edit-atomic></figure>\n      </div>', 'Source: where this comes from');
  }
  return frame(id, false, 'Bullets', 'Section',
    '      <h2>The headline says the <span class="tds-accent">conclusion</span></h2>\n'
    + '      <ul>\n        <li>First point that proves it</li>\n        <li>Second point</li>\n        <li>Third point</li>\n      </ul>',
    'Source: where this comes from');
}

export function blankDeckHtml(title = 'Untitled deck') {
  const safe = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safe}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f4f4f6; color: #17171a;
    font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 48px 16px 96px; }
</style>
<style data-tdoc-slide-kit>
${KIT_CSS}
</style>
</head>
<body>
<main>
${slideHtml('cover', { title })}
${slideHtml('bullets')}
${slideHtml('closing')}
</main>
</body>
</html>
`;
}
