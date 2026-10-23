const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');
const { requirePlaywrightOrSkip } = require('./helpers/fixture-server');
const { chromium } = requirePlaywrightOrSkip('daemon-onboarding-browser.test.js');
const ROOT = path.join(__dirname, '..');
const SHOTS = process.env.TDOC_UI_SHOTS;
(async () => {
 const out = process.env.TDOC_UI_BUILD || fs.mkdtempSync(path.join(os.tmpdir(), 'tdoc-daemon-ui-'));
 const config = path.join(ROOT, `.vite-daemon-ui-${process.pid}.config.mjs`);
 fs.writeFileSync(config, `import {defineConfig} from 'vite'; import react from '@vitejs/plugin-react'; export default defineConfig({plugins:[react()],logLevel:'error',build:{outDir:${JSON.stringify(out)},rollupOptions:{input:${JSON.stringify(path.join(__dirname,'fixtures/ui-harness/daemon-onboarding.jsx'))},output:{entryFileNames:'h.js',assetFileNames:'h[extname]'}}}});`);
 try { if (!process.env.TDOC_UI_BUILD) execFileSync(process.execPath,[path.join(ROOT,'node_modules/vite/bin/vite.js'),'build','--config',config],{cwd:ROOT,stdio:'pipe'}); } finally { fs.rmSync(config,{force:true}); }
 const html='<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/h.css"></head><body><div id="root"></div><script type="module" src="/h.js"></script></body></html>';
 const server=http.createServer((q,r)=>{
  const p=new URL(q.url,'http://fixture').pathname;
  let file;
  if(p==='/h.js'||p==='/h.css') file=path.join(out,p.slice(1));
  else if(p==='/tdoc_logo.svg') file=path.join(ROOT,'assets/tdoc_logo.svg');
  else if(p==='/mac/wallpaper.jpg') file=path.join(ROOT,'assets/mac-wallpaper.jpg');
  else if(/^\/mac\/[a-z]+\.png$/.test(p)) file=path.join(ROOT,'assets','mac-'+path.basename(p));
  if(file&&fs.existsSync(file)) {r.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':p.endsWith('.css')?'text/css':p.endsWith('.svg')?'image/svg+xml':p.endsWith('.jpg')?'image/jpeg':'image/png');return r.end(fs.readFileSync(file));}
  r.setHeader('Content-Type','text/html');r.end(html);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true});
 let passed=0;
 try {
  for(const width of [1280,390]) {
   const context=await browser.newContext({viewport:{width,height:850},reducedMotion:'reduce'});
   const page=await context.newPage(); page.setDefaultTimeout(60000); page.setDefaultNavigationTimeout(90000); const errors=[];page.on('pageerror',e=>{errors.push(e.message); console.error('Browser error:',e.message);});
   page.on('requestfailed',r=>console.error('Request failed:',r.url(),r.failure()?.errorText));
   let agents=[];let failPractice=true;let sent;
   await page.route('**/api/onboarding?daemon=1',route=>route.fulfill({json:{paired:true,record:{agent_connected:'old'},local_agents:agents}}));
   await page.route('**/api/onboarding/event',route=>route.fulfill({json:{ok:true}}));
   await page.route('**/api/onboarding/practice',route=>{sent=route.request().postDataJSON();return failPractice?route.fulfill({status:409,json:{error:'computer_not_ready'}}):route.fulfill({json:{url:'/d/practice?step=comment'}});});
   await page.goto(base);
   if (SHOTS) {fs.mkdirSync(SHOTS,{recursive:true});await page.screenshot({path:path.join(SHOTS,`arrival-${width}.png`)});}
   await page.getByRole('heading',{name:'Connect your computer'}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Try a comment'}).count(),0,'old token is not a daemon');
   await page.getByRole('radio',{name:'Windows (WSL)'}).click();
   await page.getByText('your WSL terminal',{exact:false}).waitFor();
   assert.equal(await page.locator('.rp-terminal').count(),1,'installation replay uses Terminal');
   assert.ok(await page.locator('.rp-terminal').textContent().then(t=>t.includes('Background service started.')));
   if(SHOTS){fs.mkdirSync(SHOTS,{recursive:true});await page.screenshot({path:path.join(SHOTS,`install-${width}.png`),fullPage:true});}
   agents=[{device:'alex-mac',cli:'claude',status:'active',ready:true},{device:'alex-mac',cli:'codex',status:'active',ready:true}];
   await page.getByRole('heading',{name:'Choose your AI'}).waitFor({timeout:10000});
   await page.getByRole('combobox',{name:'Your connected AI'}).click();
   await page.getByRole('option',{name:'Codex on alex-mac'}).click();
   if(SHOTS) await page.screenshot({path:path.join(SHOTS,`ready-${width}.png`),fullPage:true});
   await page.getByRole('button',{name:'Try a comment'}).click();
   await page.getByRole('alert').waitFor();
   assert.deepEqual(sent,{device:'alex-mac',cli:'codex'});
   assert.match(await page.getByRole('alert').textContent(),/offline/);
   const dimensions=await page.evaluate(()=>({w:document.documentElement.scrollWidth,v:innerWidth}));
   assert.ok(dimensions.w<=dimensions.v+1,`page overflows at ${width}: ${JSON.stringify(dimensions)}`);
   assert.equal(await page.locator('.rp-practice').count(),1,'connected replay stays in tdoc');
   assert.ok(await page.locator('.rp-practice').textContent().then(t=>t.includes('Codex · Applied in v2')));
   if(SHOTS) await page.screenshot({path:path.join(SHOTS,`connected-${width}.png`),fullPage:true});
   failPractice=false;
   await page.getByRole('button',{name:'Try a comment'}).click();
   await page.waitForURL(/\/d\/practice\?step=comment/);
   assert.deepEqual(errors,[]);
   await context.close();passed++;console.log(`✓ install → verified AI choice → retry → private practice navigation at ${width}px`);
  }
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
 console.log(`${passed} browser journeys passed`);
})().catch(e=>{console.error(e);process.exit(1);});
