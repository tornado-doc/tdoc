function f(t){return String(t??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function D(t){const e=String(t||"").trim();return/^https?:\/\//i.test(e)||/^mailto:[^\s]+$/i.test(e)?e:/^www\.\S+$/i.test(e)?"https://"+e:""}const C="✓";function M(t){return/^(✓|✔|☑|✅|x|true|yes|y|1|done|on)$/i.test(String(t??"").trim())}function L(t,e){if(t==="tags")return(Array.isArray(e)?e:String(e||"").split(/[,;|\n]/).map(r=>r.trim()).filter(Boolean)).map(r=>`<span data-tag>${f(r)}</span>`).join(" ");if(t==="checkbox")return M(e)?C:"";const n=e==null?"":String(e);if(t==="url"){const a=D(n);if(a)return`<a href="${f(a)}">${f(n)}</a>`}return _(n)}function _(t){return String(t).split(/\r\n|\r|\n/).map(f).join("<br>")}const j=40,I=1200,N=24,z=800;function H(t,e,n){const a=Math.round(Number(t));return Number.isFinite(a)&&a>0?Math.max(e,Math.min(n,a)):0}function B(t){const e=String(t||"").toLowerCase();return e==="left"||e==="center"||e==="right"?e:""}function v(t){const e=H(t.width,j,I),n=B(t.align);return(e?` data-width="${e}"`:"")+(t.wrap?' data-wrap="wrap"':"")+(n?` data-align="${n}"`:"")}function R(t,{caption:e=!1}={}){const n=t.columns||[],a=n.map((o,u)=>{const i=o.palette?` data-palette="${f(o.palette)}"`:"";return`<th data-key="${f(o.key||`c${u+1}`)}" data-type="${f(o.type||"text")}"${i}${v(o)}>${f(o.name)}</th>`}).join(""),r=new Set,l=new Map;(t.merges||[]).forEach(o=>{l.set(o.r*256+o.c,o);for(let u=o.r;u<o.r+o.rs;u++)for(let i=o.c;i<o.c+o.cs;i++)(u!==o.r||i!==o.c)&&r.add(u*256+i)});const p=(t.rows||[]).map((o,u)=>{const i=o.id||`r${u+1}`,d=n.map((b,S)=>{if(r.size&&r.has(u*256+S))return"";const g=l.size?l.get(u*256+S):null,h=g?(g.cs>1?` colspan="${g.cs}"`:"")+(g.rs>1?` rowspan="${g.rs}"`:""):"";return`<td${o.attrs&&o.attrs[S]||""}${h}>${L(b.type,o.cells[S])}</td>`}).join(""),y=H(o.height,N,z);return`<tr data-row="${f(i)}"${y?` data-height="${y}"`:""}>${d}</tr>`}).join(`
`),c=t.name||"Sheet 1",s=e?`<caption>${f(c)}</caption>
`:"";return`<table data-tdoc-sheet data-name="${f(c)}">
${s}<thead><tr>${a}</tr></thead>
<tbody>
${p}
</tbody>
</table>`}const q=`table[data-tdoc-sheet]{border-collapse:collapse;font-size:14px;margin:0 0 2rem}
table[data-tdoc-sheet] caption{text-align:left;font-weight:600;padding:0 0 .5rem}
table[data-tdoc-sheet] th,table[data-tdoc-sheet] td{border-bottom:1px solid #e4e4e9;padding:.35rem .6rem;text-align:left;vertical-align:top}
table[data-tdoc-sheet] th{position:sticky;top:0;background:#fafafb;font-weight:600;white-space:nowrap}
table[data-tdoc-sheet] [data-tag]{display:inline-block;margin:0 .25rem .15rem 0;padding:0 .5rem;border-radius:999px;background:#eef0f3;font-size:.85em;line-height:1.6}`;function U({title:t,sheets:e,note:n}){const a=String(t||"Untitled sheet"),r=(e||[]).map((l,p)=>`<div class="tdoc-table-scroll">
${R({...l,name:l.name||`Sheet ${p+1}`},{caption:e.length>1})}
</div>`);return`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${f(a)}</title>
<style>
  body { margin: 0; background: #fff; color: #17171a;
    font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
  main { max-width: 72rem; margin: 0 auto; padding: 3rem 1.5rem 6rem; }
  h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 .5rem; letter-spacing: -0.02em; }
  h2 { font-size: 1.2rem; margin: 2rem 0 .75rem; }
  .sheet-note { color: #55555f; margin: 0 0 1.5rem; }
  ${q.split(`
`).join(`
  `)}
</style>
</head>
<body>
<main>
<h1>${f(a)}</h1>
${n?`<p class="sheet-note">${f(n)}</p>
`:""}${r.join(`
`)}
</main>
</body>
</html>
`}function F(t){const e=String(t).split(/\r\n|\n|\r/,20).filter(r=>r.trim());let n=",",a=-1;for(const r of["	",",",";"]){const l=e.map(s=>O(s,r).length);if(!l.length||l[0]<2)continue;const c=l.filter(s=>s===l[0]).length*100+l[0];c>a&&(a=c,n=r)}return n}function O(t,e){return G(t,e,{maxRows:1})[0]||[]}function G(t,e,{maxRows:n=1/0}={}){const a=String(t||"").replace(/^﻿/,""),r=e||F(a),l=[];let p=[],c="",s=0,o=!1,u=!0;const i=a.length;for(;s<i;){const d=a[s];if(o){if(d==='"'){if(a[s+1]==='"'){c+='"',s+=2;continue}o=!1,s++;continue}c+=d,s++;continue}if(d==='"'&&u){o=!0,u=!1,s++;continue}if(d===r){p.push(c),c="",u=!0,s++;continue}if(d===`
`||d==="\r"){if(p.push(c),l.push(p),p=[],c="",u=!0,d==="\r"&&a[s+1]===`
`&&s++,s++,l.length>=n)return l;continue}c+=d,u=!1,s++}return(c!==""||p.length)&&(p.push(c),l.push(p)),l}function X(t="Untitled sheet"){return U({title:t,sheets:[{name:"Sheet 1",columns:[{name:"Name",type:"text"},{name:"Status",type:"tags",palette:"Done:green, In progress:blue, Blocked:red, To do:gray"},{name:"Due",type:"date"},{name:"Amount",type:"number"},{name:"Done",type:"checkbox"}],rows:Array.from({length:5},()=>({cells:["",[],"","",""]}))}]})}const P="table[data-tdoc-sheet]";function E(t,e){const n=[];return(e==="head"?t.tHead?[t.tHead]:[]:Array.prototype.filter.call(t.tBodies||[],()=>!0)).forEach(r=>Array.prototype.forEach.call(r.rows,l=>n.push(l))),n}function $(t){return String(t.textContent||"").replace(/\s+/g," ").trim()}function K(t){const e=t.childNodes;if(!e||!e.length||e.length===1&&e[0].nodeType===3)return $(t);const n=[""];if((function r(l){const p=l.childNodes;for(let c=0;c<p.length;c++){const s=p[c];if(s.nodeType===3)n[n.length-1]+=s.data;else if(s.nodeType===1){const o=String(s.tagName).toUpperCase();o==="BR"?n.push(""):o!=="SCRIPT"&&o!=="STYLE"&&r(s)}}})(t),n.length===1)return $(t);const a=n.map(r=>r.replace(/\s+/g," ").trim());for(;a.length&&!a[a.length-1];)a.pop();for(;a.length&&!a[0];)a.shift();return a.join(`
`)}function W(t){const e=E(t,"head");if(e.length)return Array.prototype.slice.call(e[e.length-1].cells);const n=E(t,"body")[0];return n&&n.cells.length&&Array.prototype.every.call(n.cells,a=>a.tagName==="TH")?Array.prototype.slice.call(n.cells):[]}function k(t,e){if(!t)return e==="tags"?[]:"";if(e==="tags"){const n=[];for(let r=t.firstElementChild;r;r=r.nextElementSibling)r.hasAttribute("data-tag")&&n.push(r);const a=n.length?n:t.querySelectorAll("[data-tag]");return a.length?Array.prototype.map.call(a,$).filter(Boolean):$(t).split(/[,;|]/).map(r=>r.trim()).filter(Boolean)}return e==="checkbox"?M($(t))?C:"":e==="url"?$(t):K(t)}function Q(t,e){const n=W(t),a=i=>String(i||"text").toLowerCase(),r=n.map((i,d)=>({key:i.getAttribute("data-key")||"",name:$(i)||`Column ${d+1}`,type:a(i.getAttribute("data-type")),palette:i.getAttribute("data-palette")||"",width:H(i.getAttribute("data-width"),j,I),wrap:i.getAttribute("data-wrap")==="wrap",align:B(i.getAttribute("data-align")),th:i})),l=n.length?n[0].parentElement:null,p=[],c=!!(t.querySelector&&t.querySelector("td[colspan],td[rowspan],th[colspan],th[rowspan]")),s=[],o=c?new Array(r.length).fill(0):null,u=E(t,"body").filter(i=>i!==l);return u.forEach((i,d)=>{const y=[],b=[];if(c){let g=0;for(let h=0;h<r.length;h++){if(o[h]>0){o[h]--,y.push(null),b.push(k(null,r[h].type));continue}const A=i.cells[g++]||null;if(y.push(A),b.push(k(A,r[h].type)),!A)continue;let w=Math.min(T(A.getAttribute("colspan")),r.length-h),x=Math.min(T(A.getAttribute("rowspan")),u.length-d);for(let m=1;m<w;m++)if(o[h+m]>0){w=1,x=1;break}if(w>1||x>1){s.push({r:d,c:h,rs:x,cs:w});for(let m=0;m<w;m++)o[h+m]=x-1;for(let m=1;m<w;m++)y.push(null),b.push(k(null,r[h+m].type));h+=w-1}}}else for(let g=0;g<r.length;g++){const h=i.cells[g]||null;y.push(h),b.push(k(h,r[g].type))}const S=i.hasAttribute("data-height")?H(i.getAttribute("data-height"),N,z):0;p.push({id:i.getAttribute("data-row")||"",tr:i,tds:y,cells:b,height:S})}),{name:t.getAttribute("data-name")||"",columns:r,rows:p,table:t,merges:s}}function T(t){const e=Number(t);return Number.isInteger(e)&&e>1?Math.min(e,1e3):1}export{z as MAX_HEIGHT,I as MAX_WIDTH,N as MIN_HEIGHT,j as MIN_WIDTH,q as SHEET_FALLBACK_CSS,P as SHEET_SELECTOR,X as blankSheetHtml,L as cellHtml,B as cleanAlign,H as cleanSize,F as detectDelimiter,f as escapeHtml,W as headerCells,G as parseDelimited,k as readCell,Q as readSheetTable,D as safeHref,U as sheetDocumentHtml,R as tableHtml};
