function c(t){return String(t??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function b(t){const e=String(t||"").trim();return/^https?:\/\//i.test(e)||/^mailto:[^\s]+$/i.test(e)?e:/^www\.\S+$/i.test(e)?"https://"+e:""}const g="✓";function y(t){return/^(✓|✔|☑|✅|x|true|yes|y|1|done|on)$/i.test(String(t??"").trim())}function $(t,e){if(t==="tags")return(Array.isArray(e)?e:String(e||"").split(/[,;|\n]/).map(a=>a.trim()).filter(Boolean)).map(a=>`<span data-tag>${c(a)}</span>`).join(" ");if(t==="checkbox")return y(e)?g:"";const r=e==null?"":String(e);if(t==="url"){const o=b(r);if(o)return`<a href="${c(o)}">${c(r)}</a>`}return c(r)}function S(t,{caption:e=!1}={}){const r=t.columns||[],o=r.map((n,i)=>{const p=n.palette?` data-palette="${c(n.palette)}"`:"";return`<th data-key="${c(n.key||`c${i+1}`)}" data-type="${c(n.type||"text")}"${p}>${c(n.name)}</th>`}).join(""),a=(t.rows||[]).map((n,i)=>{const p=n.id||`r${i+1}`,u=r.map((d,m)=>`<td>${$(d.type,n.cells[m])}</td>`).join("");return`<tr data-row="${c(p)}">${u}</tr>`}).join(`
`),l=t.name||"Sheet 1",s=e?`<caption>${c(l)}</caption>
`:"";return`<table data-tdoc-sheet data-name="${c(l)}">
${s}<thead><tr>${o}</tr></thead>
<tbody>
${a}
</tbody>
</table>`}const w=`table[data-tdoc-sheet]{border-collapse:collapse;font-size:14px;margin:0 0 2rem}
table[data-tdoc-sheet] caption{text-align:left;font-weight:600;padding:0 0 .5rem}
table[data-tdoc-sheet] th,table[data-tdoc-sheet] td{border-bottom:1px solid #e4e4e9;padding:.35rem .6rem;text-align:left;vertical-align:top}
table[data-tdoc-sheet] th{position:sticky;top:0;background:#fafafb;font-weight:600;white-space:nowrap}
table[data-tdoc-sheet] [data-tag]{display:inline-block;margin:0 .25rem .15rem 0;padding:0 .5rem;border-radius:999px;background:#eef0f3;font-size:.85em;line-height:1.6}`;function x({title:t,sheets:e,note:r}){const o=String(t||"Untitled sheet"),a=(e||[]).map((l,s)=>`<div class="tdoc-table-scroll">
${S({...l,name:l.name||`Sheet ${s+1}`},{caption:e.length>1})}
</div>`);return`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${c(o)}</title>
<style>
  body { margin: 0; background: #fff; color: #17171a;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 72rem; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
  h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 .5rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.2rem; margin: 2rem 0 .75rem; }
  .sheet-note { color: #55555f; margin: 0 0 1.5rem; }
  ${w.split(`
`).join(`
  `)}
</style>
</head>
<body>
<main>
<h1>${c(o)}</h1>
${r?`<p class="sheet-note">${c(r)}</p>
`:""}${a.join(`
`)}
</main>
</body>
</html>
`}function A(t){const e=String(t).split(/\r\n|\n|\r/,20).filter(a=>a.trim());let r=",",o=-1;for(const a of["	",",",";"]){const l=e.map(i=>k(i,a).length);if(!l.length||l[0]<2)continue;const n=l.filter(i=>i===l[0]).length*100+l[0];n>o&&(o=n,r=a)}return r}function k(t,e){return E(t,e,{maxRows:1})[0]||[]}function E(t,e,{maxRows:r=1/0}={}){const o=String(t||"").replace(/^﻿/,""),a=e||A(o),l=[];let s=[],n="",i=0,p=!1,u=!0;const d=o.length;for(;i<d;){const m=o[i];if(p){if(m==='"'){if(o[i+1]==='"'){n+='"',i+=2;continue}p=!1,i++;continue}n+=m,i++;continue}if(m==='"'&&u){p=!0,u=!1,i++;continue}if(m===a){s.push(n),n="",u=!0,i++;continue}if(m===`
`||m==="\r"){if(s.push(n),l.push(s),s=[],n="",u=!0,m==="\r"&&o[i+1]===`
`&&i++,i++,l.length>=r)return l;continue}n+=m,u=!1,i++}return(n!==""||s.length)&&(s.push(n),l.push(s)),l}function B(t="Untitled sheet"){return x({title:t,sheets:[{name:"Sheet 1",columns:[{name:"Name",type:"text"},{name:"Status",type:"tags",palette:"Done:green, In progress:blue, Blocked:red, To do:gray"},{name:"Due",type:"date"},{name:"Amount",type:"number"},{name:"Done",type:"checkbox"}],rows:Array.from({length:5},()=>({cells:["",[],"","",""]}))}]})}const T="table[data-tdoc-sheet]";function h(t,e){const r=[];return(e==="head"?t.tHead?[t.tHead]:[]:Array.prototype.filter.call(t.tBodies||[],()=>!0)).forEach(a=>Array.prototype.forEach.call(a.rows,l=>r.push(l))),r}function f(t){return String(t.textContent||"").replace(/\s+/g," ").trim()}function H(t){const e=h(t,"head");if(e.length)return Array.prototype.slice.call(e[e.length-1].cells);const r=h(t,"body")[0];return r&&r.cells.length&&Array.prototype.every.call(r.cells,o=>o.tagName==="TH")?Array.prototype.slice.call(r.cells):[]}function C(t,e){if(!t)return e==="tags"?[]:"";if(e==="tags"){const r=[];for(let a=t.firstElementChild;a;a=a.nextElementSibling)a.hasAttribute("data-tag")&&r.push(a);const o=r.length?r:t.querySelectorAll("[data-tag]");return o.length?Array.prototype.map.call(o,f).filter(Boolean):f(t).split(/[,;|]/).map(a=>a.trim()).filter(Boolean)}return e==="checkbox"?y(f(t))?g:"":f(t)}function j(t,e){const r=H(t),o=n=>String(n||"text").toLowerCase(),a=r.map((n,i)=>({key:n.getAttribute("data-key")||"",name:f(n)||`Column ${i+1}`,type:o(n.getAttribute("data-type")),palette:n.getAttribute("data-palette")||"",th:n})),l=r.length?r[0].parentElement:null,s=[];return h(t,"body").forEach(n=>{if(n===l)return;const i=[],p=[];for(let u=0;u<a.length;u++){const d=n.cells[u]||null;i.push(d),p.push(C(d,a[u].type))}s.push({id:n.getAttribute("data-row")||"",tr:n,tds:i,cells:p})}),{name:t.getAttribute("data-name")||"",columns:a,rows:s,table:t}}export{w as SHEET_FALLBACK_CSS,T as SHEET_SELECTOR,B as blankSheetHtml,$ as cellHtml,A as detectDelimiter,c as escapeHtml,H as headerCells,E as parseDelimited,C as readCell,j as readSheetTable,b as safeHref,x as sheetDocumentHtml,S as tableHtml};
