const i=`
  :root { color-scheme: light; --ink: #17171a; --muted: #6b6b76; --accent: #2f5bea; --dark: #14161c; }
  body { margin: 0; background: #f4f4f6; color: var(--ink);
    font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 48px 16px 96px; }
  .slide { container-type: inline-size; aspect-ratio: 16/9; position: relative; overflow: hidden;
    margin: 0 0 48px; border-radius: 12px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .slide.dark { background: var(--dark); color: #fff; }
  .inner { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 4.2cqw 5.2cqw 3.4cqw; }
  .top, .foot { display: flex; justify-content: space-between; gap: 2cqw; color: var(--muted);
    font-size: max(1.1cqw, 12px); }
  .dark .top, .dark .foot { color: #a9acb8; }
  .body { flex: 1; display: flex; flex-direction: column; justify-content: center; min-height: 0; }
  .slide h1 { margin: 0 0 1.6cqw; font-size: max(6cqw, 30px); line-height: 1.1; letter-spacing: -0.02em; }
  .slide h2 { margin: 0 0 2.4cqw; font-size: max(4.2cqw, 24px); line-height: 1.15; letter-spacing: -0.015em; }
  .slide p, .slide li { margin: 0; font-size: max(1.9cqw, 15px); line-height: 1.45; }
  .slide ul { margin: 0; padding-left: 1.2em; display: flex; flex-direction: column; gap: 1.2cqw; }
  .slide .lead { color: #c9ccd6; font-size: max(2.2cqw, 16px); }
  .accent { color: var(--accent); }
  .dark .accent { color: #8fa8ff; }
  @container (max-width: 640px) {
    .inner { position: static; min-height: 56vw; padding: 24px 20px; }
  }
`;function e(a="Untitled deck"){return`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${a}</title>
<style>${i}</style>
</head>
<body>
<main>
<section class="slide dark" data-tdoc-slide data-tdoc-artifact="Slide 1: title">
  <div class="inner">
    <div class="top"><span>Presentation</span><span>${new Date().getFullYear()}</span></div>
    <div class="body">
      <h1>${a}</h1>
      <p class="lead">A one-line subtitle: what this deck is about.</p>
    </div>
    <div class="foot"><span>Your name</span><span>01 / 03</span></div>
  </div>
</section>
<section class="slide" data-tdoc-slide data-tdoc-artifact="Slide 2: the point">
  <div class="inner">
    <div class="top"><span>Section</span><span></span></div>
    <div class="body">
      <h2>The headline says the <span class="accent">conclusion</span></h2>
      <ul>
        <li>First point that proves it</li>
        <li>Second point</li>
        <li>Third point</li>
      </ul>
    </div>
    <div class="foot"><span>Source: where this comes from</span><span>02 / 03</span></div>
  </div>
</section>
<section class="slide dark" data-tdoc-slide data-tdoc-artifact="Slide 3: next steps">
  <div class="inner">
    <div class="top"><span>Next steps</span><span></span></div>
    <div class="body">
      <h2>What we <span class="accent">ask</span> of you</h2>
      <p class="lead">One line on the decision or the next step.</p>
    </div>
    <div class="foot"><span>Thank you</span><span>03 / 03</span></div>
  </div>
</section>
</main>
</body>
</html>
`}export{e as blankDeckHtml};
