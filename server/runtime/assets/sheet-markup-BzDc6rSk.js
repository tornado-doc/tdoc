function u(t){return String(t??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function H(t){const e=String(t||"").trim();return/^https?:\/\//i.test(e)||/^mailto:[^\s]+$/i.test(e)?e:/^www\.\S+$/i.test(e)?"https://"+e:""}const y="✓";function b(t){return/^(✓|✔|☑|✅|x|true|yes|y|1|done|on)$/i.test(String(t??"").trim())}function T(t,e){if(t==="tags")return(Array.isArray(e)?e:String(e||"").split(/[,;|\n]/).map(i=>i.trim()).filter(Boolean)).map(i=>`<span data-tag>${u(i)}</span>`).join(" ");if(t==="checkbox")return b(e)?y:"";const a=e==null?"":String(e);if(t==="url"){const r=H(a);if(r)return`<a href="${u(r)}">${u(a)}</a>`}return E(a)}function E(t){return String(t).split(/\r\n|\r|\n/).map(u).join("<br>")}const $=40,w=1200,S=24,A=800;function g(t,e,a){const r=Math.round(Number(t));return Number.isFinite(r)&&r>0?Math.max(e,Math.min(a,r)):0}function x(t){const e=String(t||"").toLowerCase();return e==="left"||e==="center"||e==="right"?e:""}function C(t){const e=g(t.width,$,w),a=x(t.align);return(e?` data-width="${e}"`:"")+(t.wrap?' data-wrap="wrap"':"")+(a?` data-align="${a}"`:"")}function I(t,{caption:e=!1}={}){const a=t.columns||[],r=a.map((n,o)=>{const c=n.palette?` data-palette="${u(n.palette)}"`:"";return`<th data-key="${u(n.key||`c${o+1}`)}" data-type="${u(n.type||"text")}"${c}${C(n)}>${u(n.name)}</th>`}).join(""),i=(t.rows||[]).map((n,o)=>{const c=n.id||`r${o+1}`,p=a.map((d,k)=>`<td>${T(d.type,n.cells[k])}</td>`).join(""),h=g(n.height,S,A);return`<tr data-row="${u(c)}"${h?` data-height="${h}"`:""}>${p}</tr>`}).join(`
`),s=t.name||"Sheet 1",l=e?`<caption>${u(s)}</caption>
`:"";return`<table data-tdoc-sheet data-name="${u(s)}">
${l}<thead><tr>${r}</tr></thead>
<tbody>
${i}
</tbody>
</table>`}const N=`table[data-tdoc-sheet]{border-collapse:collapse;font-size:14px;margin:0 0 2rem}
table[data-tdoc-sheet] caption{text-align:left;font-weight:600;padding:0 0 .5rem}
table[data-tdoc-sheet] th,table[data-tdoc-sheet] td{border-bottom:1px solid #e4e4e9;padding:.35rem .6rem;text-align:left;vertical-align:top}
table[data-tdoc-sheet] th{position:sticky;top:0;background:#fafafb;font-weight:600;white-space:nowrap}
table[data-tdoc-sheet] [data-tag]{display:inline-block;margin:0 .25rem .15rem 0;padding:0 .5rem;border-radius:999px;background:#eef0f3;font-size:.85em;line-height:1.6}`;function j({title:t,sheets:e,note:a}){const r=String(t||"Untitled sheet"),i=(e||[]).map((s,l)=>`<div class="tdoc-table-scroll">
${I({...s,name:s.name||`Sheet ${l+1}`},{caption:e.length>1})}
</div>`);return`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${u(r)}</title>
<style>
  body { margin: 0; background: #fff; color: #17171a;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 72rem; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
  h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 .5rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.2rem; margin: 2rem 0 .75rem; }
  .sheet-note { color: #55555f; margin: 0 0 1.5rem; }
  ${N.split(`
`).join(`
  `)}
</style>
</head>
<body>
<main>
<h1>${u(r)}</h1>
${a?`<p class="sheet-note">${u(a)}</p>
`:""}${i.join(`
`)}
</main>
</body>
</html>
`}function B(t){const e=String(t).split(/\r\n|\n|\r/,20).filter(i=>i.trim());let a=",",r=-1;for(const i of["	",",",";"]){const s=e.map(o=>D(o,i).length);if(!s.length||s[0]<2)continue;const n=s.filter(o=>o===s[0]).length*100+s[0];n>r&&(r=n,a=i)}return a}function D(t,e){return M(t,e,{maxRows:1})[0]||[]}function M(t,e,{maxRows:a=1/0}={}){const r=String(t||"").replace(/^﻿/,""),i=e||B(r),s=[];let l=[],n="",o=0,c=!1,p=!0;const h=r.length;for(;o<h;){const d=r[o];if(c){if(d==='"'){if(r[o+1]==='"'){n+='"',o+=2;continue}c=!1,o++;continue}n+=d,o++;continue}if(d==='"'&&p){c=!0,p=!1,o++;continue}if(d===i){l.push(n),n="",p=!0,o++;continue}if(d===`
`||d==="\r"){if(l.push(n),s.push(l),l=[],n="",p=!0,d==="\r"&&r[o+1]===`
`&&o++,o++,s.length>=a)return s;continue}n+=d,p=!1,o++}return(n!==""||l.length)&&(l.push(n),s.push(l)),s}function R(t="Untitled sheet"){return j({title:t,sheets:[{name:"Sheet 1",columns:[{name:"Name",type:"text"},{name:"Status",type:"tags",palette:"Done:green, In progress:blue, Blocked:red, To do:gray"},{name:"Due",type:"date"},{name:"Amount",type:"number"},{name:"Done",type:"checkbox"}],rows:Array.from({length:5},()=>({cells:["",[],"","",""]}))}]})}const v="table[data-tdoc-sheet]";function f(t,e){const a=[];return(e==="head"?t.tHead?[t.tHead]:[]:Array.prototype.filter.call(t.tBodies||[],()=>!0)).forEach(i=>Array.prototype.forEach.call(i.rows,s=>a.push(s))),a}function m(t){return String(t.textContent||"").replace(/\s+/g," ").trim()}function L(t){const e=t.childNodes;if(!e||!e.length||e.length===1&&e[0].nodeType===3)return m(t);const a=[""];if((function i(s){const l=s.childNodes;for(let n=0;n<l.length;n++){const o=l[n];if(o.nodeType===3)a[a.length-1]+=o.data;else if(o.nodeType===1){const c=String(o.tagName).toUpperCase();c==="BR"?a.push(""):c!=="SCRIPT"&&c!=="STYLE"&&i(o)}}})(t),a.length===1)return m(t);const r=a.map(i=>i.replace(/\s+/g," ").trim());for(;r.length&&!r[r.length-1];)r.pop();for(;r.length&&!r[0];)r.shift();return r.join(`
`)}function _(t){const e=f(t,"head");if(e.length)return Array.prototype.slice.call(e[e.length-1].cells);const a=f(t,"body")[0];return a&&a.cells.length&&Array.prototype.every.call(a.cells,r=>r.tagName==="TH")?Array.prototype.slice.call(a.cells):[]}function z(t,e){if(!t)return e==="tags"?[]:"";if(e==="tags"){const a=[];for(let i=t.firstElementChild;i;i=i.nextElementSibling)i.hasAttribute("data-tag")&&a.push(i);const r=a.length?a:t.querySelectorAll("[data-tag]");return r.length?Array.prototype.map.call(r,m).filter(Boolean):m(t).split(/[,;|]/).map(i=>i.trim()).filter(Boolean)}return e==="checkbox"?b(m(t))?y:"":e==="url"?m(t):L(t)}function U(t,e){const a=_(t),r=n=>String(n||"text").toLowerCase(),i=a.map((n,o)=>({key:n.getAttribute("data-key")||"",name:m(n)||`Column ${o+1}`,type:r(n.getAttribute("data-type")),palette:n.getAttribute("data-palette")||"",width:g(n.getAttribute("data-width"),$,w),wrap:n.getAttribute("data-wrap")==="wrap",align:x(n.getAttribute("data-align")),th:n})),s=a.length?a[0].parentElement:null,l=[];return f(t,"body").forEach(n=>{if(n===s)return;const o=[],c=[];for(let h=0;h<i.length;h++){const d=n.cells[h]||null;o.push(d),c.push(z(d,i[h].type))}const p=n.hasAttribute("data-height")?g(n.getAttribute("data-height"),S,A):0;l.push({id:n.getAttribute("data-row")||"",tr:n,tds:o,cells:c,height:p})}),{name:t.getAttribute("data-name")||"",columns:i,rows:l,table:t}}export{A as MAX_HEIGHT,w as MAX_WIDTH,S as MIN_HEIGHT,$ as MIN_WIDTH,N as SHEET_FALLBACK_CSS,v as SHEET_SELECTOR,R as blankSheetHtml,T as cellHtml,x as cleanAlign,g as cleanSize,B as detectDelimiter,u as escapeHtml,_ as headerCells,M as parseDelimited,z as readCell,U as readSheetTable,H as safeHref,j as sheetDocumentHtml,I as tableHtml};
