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
 const html='<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/h.css"></head><body><div id="root"></div><script type="module" src="/h.js"></script></body></html>';
 const server=http.createServer((q,r)=>{
  const p=new URL(q.url,'http://fixture').pathname;
  let file;
  if(/^\/h(?:\d+)?\.(?:js|css|png|svg)$/.test(p)) file=path.join(out,p.slice(1));
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
   let agents=[];let computers=[];let failPractice=true;let sent;let setupReady=false; let setupExpired=false; let defaultTarget=null;
   await page.route('**/api/onboarding',route=>route.fulfill({json:{paired:false,record:{}}}));
   await page.route('**/api/onboarding/connect',route=>route.fulfill({json:{code:'a'.repeat(32),expires:'2099-01-01T00:00:00Z',ready:false}}));
   await page.route('**/api/onboarding/connect?code=*',route=>route.fulfill({status:setupExpired?410:200,json:setupExpired?{error:'setup_expired'}:{ready:setupReady}}));
   await page.route('**/api/me/computers',route=>{defaultTarget=route.request().postDataJSON(); return route.fulfill({json:{ok:true}});});
   await page.route('**/api/onboarding?daemon=1',route=>route.fulfill({json:{paired:true,record:{agent_connected:'old'},local_agents:agents,local_computers:computers}}));
   await page.route('**/api/onboarding/event',route=>route.fulfill({json:{ok:true}}));
   await page.route('**/api/onboarding/practice',route=>{sent=route.request().postDataJSON();return failPractice?route.fulfill({status:409,json:{error:'computer_not_ready'}}):route.fulfill({json:{url:'/d/practice?step=comment'}});});
   let deliveryFails=true; let deliveryTests=0;
   const receiver={provider:'webhook',server_id:'webhook',agent_sub:'wh_1234',agent_name:'My Grok Bot'};
   await page.route('**/api/me/connectors',route=>route.fulfill({json:{targets:[receiver]}}));
   await page.route('**/api/me/connectors/test',route=>{deliveryTests++;return route.fulfill({json:{delivery:{status:deliveryFails?'failed':'delivered'}}});});
   const shot=async name=>{if(SHOTS){fs.mkdirSync(SHOTS,{recursive:true});await page.screenshot({path:path.join(SHOTS,`${name}-${width}.png`)});}};
   // An ordinary account (no dev mode) never sees the AI onboarding, even with ?setup=1.
   await page.goto(base+'?setup=1&classic=1');
   await page.waitForTimeout(500);
   assert.equal(await page.getByRole('heading',{name:'Which AI do you use?',exact:true}).count(),0,'AI onboarding stays behind dev mode');
   assert.equal(await page.locator('#computers').count(),0,'no Computers & AI settings without dev mode');
   await page.goto(base+'?setup=1');
   await page.getByRole('heading',{name:'Which AI do you use?',exact:true}).waitFor();
   assert.equal(await page.locator('.ui-ai-option').count(),8);
   assert.equal(await page.getByText('Gemini CLI',{exact:true}).count(),0);
   assert.ok(await page.getByRole('heading',{name:'Which AI do you use?',exact:true}).evaluate(el=>el===document.activeElement));
   assert.ok(await page.locator('.ui-ai-label span').first().evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16),'no small-print product labels');
   await page.waitForFunction(() => [...document.querySelectorAll('.ui-ai-option img')].every(img => img.complete && img.naturalWidth > 0));
   await shot('products');
   for(const [product,title] of [['ChatGPT Work','Connect ChatGPT Work'],['Claude Cowork','Connect Claude Cowork'],['Claude Code','Connect Claude Code'],['Codex','Connect Codex'],['Grok Bot','Connect Grok Bot'],['Raft','Connect Raft'],['Cursor','Connect Cursor'],['Other AI / Agent','Connect Other AI / Agent']]){
     await page.getByRole('button',{name:new RegExp('^'+product.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).click();
     await page.getByRole('heading',{name:title,exact:true}).waitFor();
     await page.getByRole('button',{name:'Back',exact:true}).click();
   }
   await page.keyboard.press('Escape');
   await page.getByRole('dialog').waitFor({state:'hidden'});
   assert.ok(!new URL(page.url()).searchParams.has('setup'));

   // Cloud setup requires this attempt's tools, and never checks local runtimes.
   await page.goto(base+'?setup=1');
   await page.getByRole('button',{name:/^ChatGPT Work/}).click();
   await page.getByRole('button',{name:'Copy instruction',exact:true}).waitFor();
   await shot('cloud-connect');
   assert.ok(await page.locator('.ui-setup-instruction').evaluate(el=>getComputedStyle(el).color.match(/\d+/g).slice(0,3).every(v=>Number(v)>200)),'the instruction is light text on the dark block');
   await page.evaluate(()=>{window.__copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:t=>{window.__copied.push(t);return Promise.resolve();}}});});
   await page.getByRole('button',{name:'Copy instruction',exact:true}).click();
   const shown=await page.locator('.ui-setup-instruction').innerText();
   const copiedText=await page.evaluate(()=>window.__copied.at(-1));
   assert.equal(copiedText.trim(),shown.trim(),'Copy puts exactly the shown prompt on the clipboard');
   assert.match(copiedText,/tdoc connect a{32}$/,'the copied prompt carries this attempt\'s connection code');
   await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:()=>Promise.reject(new Error('denied'))}}));
   await page.getByRole('button',{name:'Copy instruction',exact:true}).click();
   await page.getByText('Copy the selected line.',{exact:true}).waitFor();
   assert.match(await page.evaluate(()=>window.getSelection().toString()),/tdoc connect a{32}/);
   assert.equal(await page.getByText('You’re connected',{exact:true}).count(),0);
   setupReady=true;
   await page.getByRole('heading',{name:'You’re connected',exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:'Go to my docs'}).count(),0);
   assert.equal(await page.getByRole('button',{name:'Skip',exact:true}).count(),1);
   await shot('cloud-ready');
   failPractice=false;
   await page.getByRole('button',{name:'Continue',exact:true}).click();
   await page.waitForURL('**/d/practice?step=comment');
   assert.equal(sent.mode,'manual'); assert.equal(sent.product,'chatgpt');

   // A platform never receives a local-runtime picker. A failed real delivery
   // receipt cannot advance, even though account setup already succeeded.
   setupReady=false;
   await page.goto(base+'?setup=1');
   await page.getByRole('button',{name:/^Grok Bot/}).click();
   await page.locator('.ui-setup-instruction').filter({hasText:'tdoc connect'}).waitFor();
   const instruction=await page.locator('.ui-setup-instruction').innerText();
   assert.match(instruction,/Do not install a daemon/);
   assert.match(instruction,/tdoc-connect-webhook/);
   assert.equal(await page.getByRole('combobox',{name:'AI for automatic updates'}).count(),0);
   setupReady=true;
   await page.getByRole('button',{name:'Check connection',exact:true}).waitFor();
   await page.getByRole('button',{name:'Check connection',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'did not receive the test'}).waitFor();
   assert.equal(await page.getByRole('heading',{name:'You’re connected',exact:true}).count(),0);
   deliveryFails=false;
   await page.getByRole('button',{name:'Check connection',exact:true}).click();
   await page.getByRole('heading',{name:'You’re connected',exact:true}).waitFor();
   assert.equal(deliveryTests,2);
   await page.getByRole('button',{name:'Continue',exact:true}).click();
   await page.waitForURL('**/d/practice?step=comment');
   assert.equal(sent.mode,'platform'); assert.equal(sent.recipient.agent_sub,receiver.agent_sub);

   // An old pairing and a live computer without a verified runtime are not ready.
   await page.goto(base+'?setup=1');
   await page.getByRole('button',{name:/^Codex Your computer/}).click();
   const computer={device:'alex-mac',status:'active',connected_at:'2026-10-25T01:00:00Z',runtimes:[{cli:'codex',state:'needs_check'}]};
   computers=[computer];
   await page.getByRole('heading',{name:'Finish your AI’s sign-in',exact:true}).waitFor();
   assert.ok(await page.getByRole('button',{name:'Continue',exact:true}).isDisabled());
   computer.runtimes[0].state='ready';agents=[{device:'alex-mac',cli:'codex',ready:true,status:'active'}];
   await page.getByText('Codex on alex-mac is ready.',{exact:true}).waitFor();
   await shot('computer-ready');
   computer.status='inactive';agents[0].status='inactive';
   await page.getByText('Wake your computer to continue.',{exact:true}).waitFor();
   assert.ok(await page.getByRole('button',{name:'Continue',exact:true}).isDisabled());
   computer.status='active';agents[0].status='active';
   await page.getByRole('button',{name:'Continue',exact:true}).waitFor();
   await page.getByRole('button',{name:'Continue',exact:true}).click();
   await page.getByRole('heading',{name:'You’re connected',exact:true}).waitFor();
   assert.equal(defaultTarget.cli,'codex');
   await page.getByRole('button',{name:'Continue',exact:true}).click();
   await page.waitForURL('**/d/practice?step=comment');
   assert.equal(sent.cli,'codex');assert.equal(sent.product,'codex');
   await page.goto(base+'?preview=1&screen=Tutorial%20comment');
   await page.getByRole('heading',{name:'Leave a comment',exact:true}).waitFor();
   await shot('tutorial-comment');
   await page.getByRole('button',{name:'Try it',exact:true}).click();
   await page.getByRole('dialog').waitFor({state:'hidden'});
   await page.goto(base+'?preview=1&screen=Tutorial%20handoff');
   await page.getByRole('button',{name:'Send all comments',exact:true}).waitFor();
   await page.getByRole('button',{name:'Send one comment',exact:true}).click();
   await page.getByRole('heading',{name:'Send one comment',exact:true}).waitFor();
   await page.getByText('Reply on your comment, then choose @AI.',{exact:true}).waitFor();
   await shot('tutorial-single');
   await page.getByRole('button',{name:'Show comment',exact:true}).click();
   await page.goto(base+'?preview=1&screen=Tutorial%20manual');
   await page.getByRole('heading',{name:'Send it to ChatGPT Work',exact:true}).waitFor();
   await shot('tutorial-chat');
   await page.getByRole('button',{name:'Copy instruction',exact:true}).click();
   await page.getByRole('dialog').waitFor({state:'hidden'});
   await page.goto(base+'?preview=1&screen=Computers%20%26%20AI');
   await page.getByRole('heading',{name:'Computers & AI',exact:true}).waitFor();
   const office=page.getByRole('region',{name:'office-mac',exact:true});
   await office.getByRole('button',{name:'Resume updates',exact:true}).click();
   await office.getByRole('button',{name:'Pause updates',exact:true}).waitFor();
   await page.getByRole('combobox',{name:'AI for new docs',exact:true}).click();
   await page.getByRole('option',{name:'Claude Code · office-mac',exact:true}).click();
   await page.getByRole('status').filter({hasText:'Saved. This AI'}).waitFor();
   await office.getByRole('button',{name:'Pause updates',exact:true}).click();
   await office.getByRole('button',{name:'Resume updates',exact:true}).waitFor();
   assert.match(await page.getByRole('combobox',{name:'AI for new docs',exact:true}).textContent(),/Claude Code · office-mac/,'pausing the default never silently switches AI');
   await page.getByRole('status').filter({hasText:'Automatic updates paused.'}).waitFor();
   await page.getByRole('button',{name:'Check setup',exact:true}).first().click();
   await page.getByRole('dialog',{name:'Check alex-mac',exact:true}).waitFor();
   await page.getByRole('button',{name:'Done',exact:true}).click();
   assert.ok(await page.getByRole('button',{name:'Connect a computer',exact:true}).isVisible());
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'settings has no horizontal overflow');
   if(SHOTS) await page.screenshot({path:path.join(SHOTS,`settings-${width}.png`),fullPage:true});
   assert.deepEqual(errors,[]);
   await context.close();passed++;console.log(`✓ automatic setup → optional tutorial; interactive account setup; persistent computer settings at ${width}px`);
  }
 } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
 console.log(`${passed} browser journeys passed`);
})().catch(e=>{console.error(e);process.exit(1);});
