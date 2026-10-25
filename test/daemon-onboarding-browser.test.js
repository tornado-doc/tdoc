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
   let agents=[];let computers=[];let failPractice=true;let sent;
   await page.route('**/api/onboarding?daemon=1',route=>route.fulfill({json:{paired:true,record:{agent_connected:'old'},local_agents:agents,local_computers:computers}}));
   await page.route('**/api/onboarding/event',route=>route.fulfill({json:{ok:true}}));
   await page.route('**/api/onboarding/practice',route=>{sent=route.request().postDataJSON();return failPractice?route.fulfill({status:409,json:{error:'computer_not_ready'}}):route.fulfill({json:{url:'/d/practice?step=comment'}});});
   await page.goto(base+'?setup=1');
   if (SHOTS) {fs.mkdirSync(SHOTS,{recursive:true});await page.screenshot({path:path.join(SHOTS,`arrival-${width}.png`)});}
   await page.getByRole('heading',{name:'Connect a computer'}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true,'old token cannot advance');
   await page.keyboard.press('Escape');
   await page.getByRole('dialog').waitFor({state:'hidden'});
   assert.ok(!new URL(page.url()).searchParams.has('setup'),'dismissal clears the setup URL');
   await page.goto(base+'?setup=1');
   await page.getByRole('heading',{name:'Connect a computer'}).waitFor();
   await page.getByRole('radio',{name:'Windows (WSL)'}).click();
   await page.getByText('your WSL terminal',{exact:false}).waitFor();
   assert.equal(await page.getByRole('dialog').count(),1,'setup uses the shared app dialog');
   const modalBounds=await page.getByRole('dialog').boundingBox();
   assert.ok(Math.abs(modalBounds.width-(width===1280?960:350))<=1,'reference modal width, constrained on phones');
   assert.ok(Math.abs(modalBounds.height-720)<=1,'reference modal height');
   assert.ok(Math.abs(modalBounds.x+(modalBounds.width/2)-(width/2))<=1,'modal centered horizontally');
   assert.ok(Math.abs(modalBounds.y+(modalBounds.height/2)-425)<=1,'modal centered vertically');
   await page.getByRole('button',{name:'Copy install command',exact:true}).waitFor();
   await page.getByRole('button',{name:'Copy setup command',exact:true}).waitFor();
   assert.match(await page.locator('.ui-setup-command').nth(0).textContent(),/bash -s -- --install-only/);
   assert.match(await page.locator('.ui-setup-command').nth(1).textContent(),/~\/.local\/bin\/tdoc setup/);
   await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('denied'))}}));
   for (const [index,name] of [[0,'Copy install command'],[1,'Copy setup command']]) {
    await page.getByRole('button',{name,exact:true}).click();
    await page.getByText('Copy the selected line.',{exact:true}).waitFor();
    const selected=await page.evaluate(()=>window.getSelection().toString());
    assert.equal(selected,await page.locator('.ui-setup-command code').nth(index).textContent(),'clipboard refusal selects the clicked command');
   }
   assert.equal(await page.locator('.sg-pane-art').count(),0,'no split-screen animation');
   const nextBounds=await page.getByRole('button',{name:'Next',exact:true}).boundingBox();
   assert.ok(nextBounds && nextBounds.y+nextBounds.height<=850,'Next stays within the viewport');
   if(SHOTS){fs.mkdirSync(SHOTS,{recursive:true});await page.screenshot({path:path.join(SHOTS,`install-${width}.png`),fullPage:true});}
   const connectedMachine={device:'alex-mac',status:'active',connected_at:'2026-10-25T01:00:00Z',runtimes:[{cli:'claude',state:'not_installed'},{cli:'codex',state:'not_installed'}]};
   const olderMachine={device:'old-mac',status:'active',connected_at:'2026-01-01T00:00:00Z',runtimes:[{cli:'claude',state:'ready'}]};
   computers=[olderMachine,connectedMachine];
   agents=[{device:'old-mac',cli:'claude',ready:true,status:'active'}];
   await page.getByText('Connected · alex-mac',{exact:true}).waitFor();
   assert.equal(await page.getByRole('heading',{name:'Choose your AI'}).count(),0,'runtime detection stays in the connection step');
   assert.equal(await page.getByRole('combobox').count(),0,'no computer switcher');
   assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true,'connection alone cannot execute');
   await page.getByText('No AI is ready on this computer yet',{exact:true}).waitFor();
   await page.locator('details.ui-setup-runtime').filter({hasText:'Codex'}).locator('summary').click();
   await page.getByRole('link',{name:'Codex',exact:true}).waitFor();
   if(SHOTS) await page.screenshot({path:path.join(SHOTS,`missing-${width}.png`)});
   connectedMachine.runtimes[1]={cli:'codex',state:'needs_check',version:'1.2.3'};
   await page.getByText('Needs a check',{exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true,'installation does not prove execution');
   connectedMachine.runtimes[1]={cli:'codex',state:'ready',version:'1.2.3'};
   agents=[{device:'alex-mac',cli:'codex',status:'active',ready:true}];
   await page.getByText('Codex on alex-mac detected · 1.2.3',{exact:true}).waitFor();
   assert.equal(await page.locator('details.ui-setup-runtime').count(),0,'installation panel disappears when an AI is ready');
   olderMachine.last_seen='2099-01-01T00:00:00Z';
   connectedMachine.status='inactive';agents[0].status='inactive';
   await page.getByText('This computer is offline. Wake it up to check its AI.',{exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Next',exact:true}).isDisabled(),true);
   connectedMachine.status='active';agents[0].status='active';
   await page.getByText('Codex on alex-mac detected · 1.2.3',{exact:true}).waitFor();
   if(SHOTS) await page.screenshot({path:path.join(SHOTS,`ready-${width}.png`),fullPage:true});
   await page.getByRole('button',{name:'Next',exact:true}).click();
   await page.getByRole('alert').waitFor();
   assert.deepEqual(sent,{device:'alex-mac',cli:'codex'});
   assert.match(await page.getByRole('alert').textContent(),/offline/);
   const dimensions=await page.evaluate(()=>({w:document.documentElement.scrollWidth,v:innerWidth}));
   assert.ok(dimensions.w<=dimensions.v+1,`page overflows at ${width}: ${JSON.stringify(dimensions)}`);
   assert.equal(await page.getByRole('dialog').count(),1,'practice remains in the same dialog');
   if(SHOTS) await page.screenshot({path:path.join(SHOTS,`connected-${width}.png`),fullPage:true});
   failPractice=false;
   await page.getByRole('button',{name:'Next',exact:true}).click();
   await page.waitForURL(/\/d\/practice\?step=comment/);
   // A fresh account can take the manual route without inventing a ready AI.
   agents=[];computers=[];
   await page.goto(base+'?setup=1');
   await page.getByRole('button',{name:'Use without a background helper →'}).click();
   await page.getByRole('heading',{name:'Use your AI',exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Try a comment'}).isEnabled(),true);
   assert.equal(await page.locator('.ui-setup-command').count(),0,'manual route never asks to install or start a service');
   if(SHOTS) await page.screenshot({path:path.join(SHOTS,`manual-${width}.png`)});
   await page.getByRole('button',{name:'Try a comment'}).click();
   await page.waitForURL(/\/d\/practice\?step=comment/);
   assert.deepEqual(sent,{mode:'manual'});
   await page.goto(base+'?preview=1&screen=Connected');
   await page.getByRole('heading',{name:'Connect a computer'}).waitFor();
   const scroll=await page.evaluate(()=>({page:document.documentElement.scrollHeight,viewport:innerHeight,body:document.querySelector('.ui-setup-modal .ui-dialog-body').scrollHeight,bodyViewport:document.querySelector('.ui-setup-modal .ui-dialog-body').clientHeight}));
   assert.ok(scroll.page<=scroll.viewport+1,`preview does not add a page of scroll: ${JSON.stringify(scroll)}`);
   assert.ok(scroll.body<=scroll.bodyViewport+1,`connection progress fits without scrolling: ${JSON.stringify(scroll)}`);
   if(SHOTS) await page.screenshot({path:path.join(SHOTS,`preview-${width}.png`)});
   if(width===1280){
    await page.setViewportSize({width,height:650});
    const short=await page.evaluate(()=>({page:document.documentElement.scrollHeight,viewport:innerHeight,body:document.querySelector('.ui-setup-modal .ui-dialog-body').scrollHeight,bodyViewport:document.querySelector('.ui-setup-modal .ui-dialog-body').clientHeight}));
    assert.ok(short.page<=short.viewport+1 && short.body<=short.bodyViewport+1,`short desktop fits connection progress: ${JSON.stringify(short)}`);
   }
   assert.deepEqual(errors,[]);
   await context.close();passed++;console.log(`✓ automatic runtime detection → retry → private practice; optional manual route at ${width}px`);
  }
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
 console.log(`${passed} browser journeys passed`);
})().catch(e=>{console.error(e);process.exit(1);});
