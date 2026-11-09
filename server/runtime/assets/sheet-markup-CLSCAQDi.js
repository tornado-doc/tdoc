function l(t){return String(t??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function f(t){const e=String(t||"").trim();return/^https?:\/\//i.test(e)||/^mailto:[^\s]+$/i.test(e)?e:/^www\.\S+$/i.test(e)?"https://"+e:""}const h="✓";function g(t){return/^(✓|✔|☑|✅|x|true|yes|y|1|done|on)$/i.test(String(t??"").trim())}function b(t,e){if(t==="tags")return(Array.isArray(e)?e:String(e||"").split(/[,;|\n]/).map(s=>s.trim()).filter(Boolean)).map(s=>`<span data-tag>${l(s)}</span>`).join(" ");if(t==="checkbox")return g(e)?h:"";const o=e==null?"":String(e);if(t==="url"){const i=f(o);if(i)return`<a href="${l(i)}">${l(o)}</a>`}return l(o)}function y(t,{caption:e=!1}={}){const o=t.columns||[],i=o.map((n,a)=>{const d=n.palette?` data-palette="${l(n.palette)}"`:"";return`<th data-key="${l(n.key||`c${a+1}`)}" data-type="${l(n.type||"text")}"${d}>${l(n.name)}</th>`}).join(""),s=(t.rows||[]).map((n,a)=>{const d=n.id||`r${a+1}`,p=o.map((u,m)=>`<td>${b(u.type,n.cells[m])}</td>`).join("");return`<tr data-row="${l(d)}">${p}</tr>`}).join(`
`),r=t.name||"Sheet 1",c=e?`<caption>${l(r)}</caption>
`:"";return`<table data-tdoc-sheet data-name="${l(r)}">
${c}<thead><tr>${i}</tr></thead>
<tbody>
${s}
</tbody>
</table>`}const $=`table[data-tdoc-sheet]{border-collapse:collapse;font-size:14px;margin:0 0 2rem}
table[data-tdoc-sheet] caption{text-align:left;font-weight:600;padding:0 0 .5rem}
table[data-tdoc-sheet] th,table[data-tdoc-sheet] td{border-bottom:1px solid #e4e4e9;padding:.35rem .6rem;text-align:left;vertical-align:top}
table[data-tdoc-sheet] th{position:sticky;top:0;background:#fafafb;font-weight:600;white-space:nowrap}
table[data-tdoc-sheet] [data-tag]{display:inline-block;margin:0 .25rem .15rem 0;padding:0 .5rem;border-radius:999px;background:#eef0f3;font-size:.85em;line-height:1.6}`;function S({title:t,sheets:e,note:o}){const i=String(t||"Untitled sheet"),s=(e||[]).map((r,c)=>`<div class="tdoc-table-scroll">
${y({...r,name:r.name||`Sheet ${c+1}`},{caption:e.length>1})}
</div>`);return`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${l(i)}</title>
<style>
  body { margin: 0; background: #fff; color: #17171a;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 72rem; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
  h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 .5rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.2rem; margin: 2rem 0 .75rem; }
  .sheet-note { color: #55555f; margin: 0 0 1.5rem; }
  ${$.split(`
`).join(`
  `)}
</style>
</head>
<body>
<main>
<h1>${l(i)}</h1>
${o?`<p class="sheet-note">${l(o)}</p>
`:""}${s.join(`
`)}
</main>
</body>
</html>
`}function x(t){const e=String(t).split(/\r\n|\n|\r/,20).filter(s=>s.trim());let o=",",i=-1;for(const s of["	",",",";"]){const r=e.map(a=>k(a,s).length);if(!r.length||r[0]<2)continue;const n=r.filter(a=>a===r[0]).length*100+r[0];n>i&&(i=n,o=s)}return o}function k(t,e){return w(t,e,{maxRows:1})[0]||[]}function w(t,e,{maxRows:o=1/0}={}){const i=String(t||"").replace(/^﻿/,""),s=e||x(i),r=[];let c=[],n="",a=0,d=!1,p=!0;const u=i.length;for(;a<u;){const m=i[a];if(d){if(m==='"'){if(i[a+1]==='"'){n+='"',a+=2;continue}d=!1,a++;continue}n+=m,a++;continue}if(m==='"'&&p){d=!0,p=!1,a++;continue}if(m===s){c.push(n),n="",p=!0,a++;continue}if(m===`
`||m==="\r"){if(c.push(n),r.push(c),c=[],n="",p=!0,m==="\r"&&i[a+1]===`
`&&a++,a++,r.length>=o)return r;continue}n+=m,p=!1,a++}return(n!==""||c.length)&&(c.push(n),r.push(c)),r}function H(t="Untitled sheet"){return S({title:t,sheets:[{name:"Sheet 1",columns:[{name:"Name",type:"text"},{name:"Status",type:"tags",palette:"Done:green, In progress:blue, Blocked:red, To do:gray"},{name:"Due",type:"date"},{name:"Amount",type:"number"},{name:"Done",type:"checkbox"}],rows:Array.from({length:5},()=>({cells:["",[],"","",""]}))}]})}export{$ as SHEET_FALLBACK_CSS,H as blankSheetHtml,b as cellHtml,x as detectDelimiter,l as escapeHtml,w as parseDelimited,f as safeHref,S as sheetDocumentHtml,y as tableHtml};
