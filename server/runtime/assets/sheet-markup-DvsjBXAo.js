function c(t){return String(t??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function T(t){const e=String(t||"").trim();return/^https?:\/\//i.test(e)||/^mailto:[^\s]+$/i.test(e)?e:/^www\.\S+$/i.test(e)?"https://"+e:""}const b="✓";function $(t){return/^(✓|✔|☑|✅|x|true|yes|y|1|done|on)$/i.test(String(t??"").trim())}function E(t,e){if(t==="tags")return(Array.isArray(e)?e:String(e||"").split(/[,;|\n]/).map(i=>i.trim()).filter(Boolean)).map(i=>`<span data-tag>${c(i)}</span>`).join(" ");if(t==="checkbox")return $(e)?b:"";const a=e==null?"":String(e);if(t==="url"){const r=T(a);if(r)return`<a href="${c(r)}">${c(a)}</a>`}return C(a)}function C(t){return String(t).split(/\r\n|\r|\n/).map(c).join("<br>")}const w=40,S=1200,A=24,x=800;function f(t,e,a){const r=Math.round(Number(t));return Number.isFinite(r)&&r>0?Math.max(e,Math.min(a,r)):0}function k(t){const e=String(t||"").toLowerCase();return e==="left"||e==="center"||e==="right"?e:""}function I(t){const e=f(t.width,w,S),a=k(t.align);return(e?` data-width="${e}"`:"")+(t.wrap?' data-wrap="wrap"':"")+(a?` data-align="${a}"`:"")}function N(t,{caption:e=!1}={}){const a=t.columns||[],r=a.map((n,o)=>{const u=n.palette?` data-palette="${c(n.palette)}"`:"";return`<th data-key="${c(n.key||`c${o+1}`)}" data-type="${c(n.type||"text")}"${u}${I(n)}>${c(n.name)}</th>`}).join(""),i=(t.rows||[]).map((n,o)=>{const u=n.id||`r${o+1}`,p=n.formulas||[],h=a.map((H,g)=>`<td${p[g]?` data-formula="${c(p[g])}"`:""}>${E(H.type,n.cells[g])}</td>`).join(""),d=f(n.height,A,x);return`<tr data-row="${c(u)}"${d?` data-height="${d}"`:""}>${h}</tr>`}).join(`
`),s=t.name||"Sheet 1",l=e?`<caption>${c(s)}</caption>
`:"";return`<table data-tdoc-sheet data-name="${c(s)}">
${l}<thead><tr>${r}</tr></thead>
<tbody>
${i}
</tbody>
</table>`}const j=`table[data-tdoc-sheet]{border-collapse:collapse;font-size:14px;margin:0 0 2rem}
table[data-tdoc-sheet] caption{text-align:left;font-weight:600;padding:0 0 .5rem}
table[data-tdoc-sheet] th,table[data-tdoc-sheet] td{border-bottom:1px solid #e4e4e9;padding:.35rem .6rem;text-align:left;vertical-align:top}
table[data-tdoc-sheet] th{position:sticky;top:0;background:#fafafb;font-weight:600;white-space:nowrap}
table[data-tdoc-sheet] [data-tag]{display:inline-block;margin:0 .25rem .15rem 0;padding:0 .5rem;border-radius:999px;background:#eef0f3;font-size:.85em;line-height:1.6}`;function B({title:t,sheets:e,note:a}){const r=String(t||"Untitled sheet"),i=(e||[]).map((s,l)=>`<div class="tdoc-table-scroll">
${N({...s,name:s.name||`Sheet ${l+1}`},{caption:e.length>1})}
</div>`);return`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${c(r)}</title>
<style>
  body { margin: 0; background: #fff; color: #17171a;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 72rem; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
  h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 .5rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.2rem; margin: 2rem 0 .75rem; }
  .sheet-note { color: #55555f; margin: 0 0 1.5rem; }
  ${j.split(`
`).join(`
  `)}
</style>
</head>
<body>
<main>
<h1>${c(r)}</h1>
${a?`<p class="sheet-note">${c(a)}</p>
`:""}${i.join(`
`)}
</main>
</body>
</html>
`}function D(t){const e=String(t).split(/\r\n|\n|\r/,20).filter(i=>i.trim());let a=",",r=-1;for(const i of["	",",",";"]){const s=e.map(o=>M(o,i).length);if(!s.length||s[0]<2)continue;const n=s.filter(o=>o===s[0]).length*100+s[0];n>r&&(r=n,a=i)}return a}function M(t,e){return L(t,e,{maxRows:1})[0]||[]}function L(t,e,{maxRows:a=1/0}={}){const r=String(t||"").replace(/^﻿/,""),i=e||D(r),s=[];let l=[],n="",o=0,u=!1,p=!0;const h=r.length;for(;o<h;){const d=r[o];if(u){if(d==='"'){if(r[o+1]==='"'){n+='"',o+=2;continue}u=!1,o++;continue}n+=d,o++;continue}if(d==='"'&&p){u=!0,p=!1,o++;continue}if(d===i){l.push(n),n="",p=!0,o++;continue}if(d===`
`||d==="\r"){if(l.push(n),s.push(l),l=[],n="",p=!0,d==="\r"&&r[o+1]===`
`&&o++,o++,s.length>=a)return s;continue}n+=d,p=!1,o++}return(n!==""||l.length)&&(l.push(n),s.push(l)),s}function v(t="Untitled sheet"){return B({title:t,sheets:[{name:"Sheet 1",columns:[{name:"Name",type:"text"},{name:"Status",type:"tags",palette:"Done:green, In progress:blue, Blocked:red, To do:gray"},{name:"Due",type:"date"},{name:"Amount",type:"number"},{name:"Done",type:"checkbox"}],rows:Array.from({length:5},()=>({cells:["",[],"","",""]}))}]})}const U="table[data-tdoc-sheet]";function y(t,e){const a=[];return(e==="head"?t.tHead?[t.tHead]:[]:Array.prototype.filter.call(t.tBodies||[],()=>!0)).forEach(i=>Array.prototype.forEach.call(i.rows,s=>a.push(s))),a}function m(t){return String(t.textContent||"").replace(/\s+/g," ").trim()}function _(t){const e=t.childNodes;if(!e||!e.length||e.length===1&&e[0].nodeType===3)return m(t);const a=[""];if((function i(s){const l=s.childNodes;for(let n=0;n<l.length;n++){const o=l[n];if(o.nodeType===3)a[a.length-1]+=o.data;else if(o.nodeType===1){const u=String(o.tagName).toUpperCase();u==="BR"?a.push(""):u!=="SCRIPT"&&u!=="STYLE"&&i(o)}}})(t),a.length===1)return m(t);const r=a.map(i=>i.replace(/\s+/g," ").trim());for(;r.length&&!r[r.length-1];)r.pop();for(;r.length&&!r[0];)r.shift();return r.join(`
`)}function z(t){const e=y(t,"head");if(e.length)return Array.prototype.slice.call(e[e.length-1].cells);const a=y(t,"body")[0];return a&&a.cells.length&&Array.prototype.every.call(a.cells,r=>r.tagName==="TH")?Array.prototype.slice.call(a.cells):[]}function R(t,e){if(!t)return e==="tags"?[]:"";if(e==="tags"){const a=[];for(let i=t.firstElementChild;i;i=i.nextElementSibling)i.hasAttribute("data-tag")&&a.push(i);const r=a.length?a:t.querySelectorAll("[data-tag]");return r.length?Array.prototype.map.call(r,m).filter(Boolean):m(t).split(/[,;|]/).map(i=>i.trim()).filter(Boolean)}return e==="checkbox"?$(m(t))?b:"":e==="url"?m(t):_(t)}function q(t,e){const a=z(t),r=n=>String(n||"text").toLowerCase(),i=a.map((n,o)=>({key:n.getAttribute("data-key")||"",name:m(n)||`Column ${o+1}`,type:r(n.getAttribute("data-type")),palette:n.getAttribute("data-palette")||"",width:f(n.getAttribute("data-width"),w,S),wrap:n.getAttribute("data-wrap")==="wrap",align:k(n.getAttribute("data-align")),th:n})),s=a.length?a[0].parentElement:null,l=[];return y(t,"body").forEach(n=>{if(n===s)return;const o=[],u=[];for(let h=0;h<i.length;h++){const d=n.cells[h]||null;o.push(d),u.push(R(d,i[h].type))}const p=n.hasAttribute("data-height")?f(n.getAttribute("data-height"),A,x):0;l.push({id:n.getAttribute("data-row")||"",tr:n,tds:o,cells:u,height:p})}),{name:t.getAttribute("data-name")||"",columns:i,rows:l,table:t}}export{x as MAX_HEIGHT,S as MAX_WIDTH,A as MIN_HEIGHT,w as MIN_WIDTH,j as SHEET_FALLBACK_CSS,U as SHEET_SELECTOR,v as blankSheetHtml,E as cellHtml,k as cleanAlign,f as cleanSize,D as detectDelimiter,c as escapeHtml,z as headerCells,L as parseDelimited,R as readCell,q as readSheetTable,T as safeHref,B as sheetDocumentHtml,N as tableHtml};
