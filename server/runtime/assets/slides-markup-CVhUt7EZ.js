const l=['.tds-slide{container-type:inline-size;aspect-ratio:16/9;position:relative;overflow:hidden;box-sizing:border-box;margin:0 0 48px;border-radius:12px;background:#fff;color:#17171a;box-shadow:0 1px 3px rgba(0,0,0,.08);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;}',".tds-slide.tds-dark{background:#14161c;color:#fff;}",".tds-inner{position:absolute;inset:0;display:flex;flex-direction:column;padding:4.2cqw 5.2cqw 3.4cqw;}",".tds-top,.tds-foot{display:flex;justify-content:space-between;gap:2cqw;color:#6b6b76;font-size:max(1.1cqw,12px);}",".tds-dark .tds-top,.tds-dark .tds-foot{color:#a9acb8;}",".tds-body{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0;}",".tds-slide h1{margin:0 0 1.6cqw;font-size:max(6cqw,30px);line-height:1.1;letter-spacing:-0.02em;}",".tds-slide h2{margin:0 0 2.4cqw;font-size:max(4.2cqw,24px);line-height:1.15;letter-spacing:-0.015em;}",".tds-slide h2.tds-display{font-size:max(5.4cqw,28px);}",".tds-slide p,.tds-slide li{margin:0;font-size:max(1.9cqw,15px);line-height:1.45;}",".tds-slide ul{margin:0;padding-left:1.2em;display:flex;flex-direction:column;gap:1.2cqw;}",".tds-slide .tds-lead{color:#6b6b76;font-size:max(2.2cqw,16px);}",".tds-dark .tds-lead{color:#c9ccd6;}",".tds-accent{color:#2f5bea;}",".tds-dark .tds-accent{color:#8fa8ff;}",".tds-cols{display:grid;grid-template-columns:1fr 1fr;gap:4cqw;align-items:center;}",".tds-slide .tds-num{margin:0 0 1cqw;font-size:max(11cqw,48px);font-weight:700;line-height:1;letter-spacing:-0.03em;color:#2f5bea;}",".tds-figure{margin:0;aspect-ratio:4/3;border-radius:1cqw;overflow:hidden;background:#f0f1f4;}",".tds-figure img{display:block;width:100%;height:100%;object-fit:cover;}",".tds-figure:empty{display:none;}","html[data-tdoc-editing] .tds-figure:empty{display:flex;align-items:center;justify-content:center;background:transparent;border:1.5px dashed #c8cbd4;}",'html[data-tdoc-editing] .tds-figure:empty::before{content:"Image: use the image button on this slide";padding:0 1em;text-align:center;color:#8a8d99;font-size:max(1.4cqw,13px);}',"@container (max-width: 640px){.tds-inner{position:static;min-height:56vw;padding:24px 20px;}.tds-cols{grid-template-columns:1fr;}}"].join(`
`);function n(t){return String(t).replace(/[&<>"]/g,e=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[e])}function r(){let t="";try{const e=new Uint8Array(6);crypto.getRandomValues(e),t=Array.from(e,i=>(i%36).toString(36)).join("")}catch{t=Math.random().toString(36).slice(2,8)}return`s-${t}`}function s(t,e,i,a,o,c){return`<section class="tds-slide${e?" tds-dark":""}" data-tdoc-slide="${n(t)}" data-tdoc-artifact="${n(i)}">
  <div class="tds-inner">
    <div class="tds-top"><span>${a}</span><span></span></div>
    <div class="tds-body">
${o}
    </div>
    <div class="tds-foot"><span>${c}</span><span></span></div>
  </div>
</section>`}function d(t,e={}){const i=e.id||r();if(t==="cover"){const a=n(e.title||"Untitled deck");return s(i,!0,"Cover","Presentation",`      <h1>${a}</h1>
      <p class="tds-lead">A one-line subtitle: what this deck is about.</p>`,"Your name")}return t==="closing"?s(i,!0,"Next steps","Next steps",`      <h2>What we <span class="tds-accent">ask</span> of you</h2>
      <p class="tds-lead">One line on the decision or the next step.</p>`,"Thank you"):t==="title"?s(i,!0,"Section","Section",`      <h2 class="tds-display">Section title</h2>
      <p class="tds-lead">One line on what comes next.</p>`,""):t==="number"?s(i,!1,"Big number","Finding",`      <div class="tds-cols">
        <div><p class="tds-num">42%</p><p>What the number means, in one line.</p></div>
        <figure class="tds-figure" data-tdoc-slide-image data-tdoc-edit-atomic></figure>
      </div>`,"Source: where this comes from"):s(i,!1,"Bullets","Section",`      <h2>The headline says the <span class="tds-accent">conclusion</span></h2>
      <ul>
        <li>First point that proves it</li>
        <li>Second point</li>
        <li>Third point</li>
      </ul>`,"Source: where this comes from")}function p(t="Untitled deck"){return`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${n(t)}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f4f4f6; color: #17171a;
    font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 960px; margin: 0 auto; padding: 48px 16px 96px; }
</style>
<style data-tdoc-slide-kit>
${l}
</style>
</head>
<body>
<main>
${d("cover",{title:t})}
${d("bullets")}
${d("closing")}
</main>
</body>
</html>
`}export{l as KIT_CSS,p as blankDeckHtml,r as newSlideId,d as slideHtml};
