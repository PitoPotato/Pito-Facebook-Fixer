import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

const profile=path.resolve('test-results/settings-profiles',crypto.randomUUID()),output=path.resolve('test-results/ui-0.1.8');await mkdir(profile,{recursive:true});await mkdir(output,{recursive:true});
const extension=path.resolve('dist'),errors=[],requests=[];
const fixture='<!doctype html><body><textarea id="first" aria-label="Message"></textarea><textarea id="second" aria-label="Message"></textarea><script>first.focus();first.value="Synthetic QA";first.dispatchEvent(new InputEvent("input",{bubbles:true}));second.focus();window.bootFocus=document.activeElement.id;</script></body>';
async function launch(){
 const browser=await chromium.launchPersistentContext(profile,{executablePath:process.env.PFF_TEST_BROWSER||path.resolve('test-results/browser-current/chrome-win64/chrome.exe'),headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:1440,height:1000}});
 await browser.route(/^https?:\/\//,route=>{requests.push(route.request().url());return route.request().url().startsWith('https://www.facebook.com/')?route.fulfill({contentType:'text/html',body:fixture}):route.abort();});
 browser.on('weberror',event=>errors.push(event.error().message));return browser;
}
let context=await launch();const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,message){for(let i=0;i<120;i++){if(await check())return;await sleep(100);}throw Error(message);}
const ready=page=>page.waitForFunction(()=>document.querySelector('#settingsFields')?.disabled===false);
const rpc=(page,message)=>page.evaluate(async message=>{const result=await chrome.runtime.sendMessage(message);if(!result?.ok)throw Error(result?.error);return result;},message);
try{
 let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const id=new URL(worker.url()).hostname,base=`chrome-extension://${id}/`;
 const popup=await context.newPage();await popup.goto(base+'popup.html');await ready(popup);
 assert.equal(await popup.locator('[name="focusGuard"]').isChecked(),true);
 await popup.locator('[name="focusGuard"]').uncheck();await popup.close();
 let ui=await context.newPage();await ui.goto(base+'options.html');await ready(ui);
 assert.equal((await rpc(ui,{type:'config'})).settings.focusGuard,false,'Switch change was lost when popup closed without Save');
 console.log('PASS switch is durable after immediate popup closure without a Save click');
 const second=await context.newPage();await second.goto(base+'popup.html');await ready(second);
 await Promise.all([ui.locator('[name="antiReload"]').uncheck(),second.locator('[name="archive"]').uncheck()]);
 await until(async()=>{const c=(await rpc(ui,{type:'config'})).settings;return !c.antiReload&&!c.archive&&!c.focusGuard;},'Concurrent views overwrote each other');
 await until(async()=>!(await ui.locator('[name="archive"]').isChecked())&&!(await second.locator('[name="antiReload"]').isChecked()),'Views did not synchronize');await second.close();
 await ui.getByRole('link',{name:'Storage',exact:true}).click();
 await ui.locator('[name="budgetMiB"]').fill('64');await ui.locator('[name="retentionDays"]').fill('13');await ui.locator('.advanced summary').click();await ui.locator('[name="imageRetentionDays"]').fill('2');await ui.locator('[name="voiceRetentionDays"]').fill('3');
 await ui.locator('[name="autoVoice"]').uncheck();await ui.locator('[name="cleanupRemoved"]').uncheck();
 await ui.locator('#save').click();
 await until(async()=>{const c=(await rpc(ui,{type:'config'})).settings;return c.maxBytes===64*1024*1024&&c.retentionDays===13&&!c.cleanupRemoved&&!c.autoVoice;},'Custom numeric limits or switches did not persist');
 const saved=(await rpc(ui,{type:'config'})).settings;
 await worker.evaluate(()=>{const original=chrome.storage.local.get.bind(chrome.storage.local);chrome.storage.local.get=async keys=>{await new Promise(r=>setTimeout(r,900));return original(keys);};});
 const facebook=await context.newPage();await facebook.goto('https://www.facebook.com/messages/t/20002/');
 assert.equal(await facebook.evaluate(()=>bootFocus),'second','Default focus guard activated before persisted settings arrived');
 const tabs=await ui.evaluate(()=>chrome.tabs.query({url:'https://www.facebook.com/*'}));
 for(let i=0;i<5;i++){
  if(i)await facebook.reload();
  await until(async()=>{const s=await ui.evaluate(tab=>chrome.tabs.sendMessage(tab,{type:'tabStatus'}),tabs[0].id);return s.configured&&s.appliedSettingsRevision===s.settingsRevision&&s.settings?.focusGuard===false&&s.settings?.archive===false&&s.settings?.antiReload===false&&s.settings?.retentionDays===13;},`Reload ${i+1} fell back to defaults`);
 }
 console.log('PASS concurrent views, numeric settings and 5 Facebook reloads with delayed preference reads; no pre-hydration default guard');
 await facebook.close();await context.close();context=await launch();worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 ui=await context.newPage();await ui.goto(base+'options.html');await ready(ui);
 assert.deepEqual((await rpc(ui,{type:'config'})).settings,saved,'Preferences changed after browser/service worker restart');
 assert.equal(await ui.locator('[name="focusGuard"]').isChecked(),false);assert.equal(await ui.locator('[name="archive"]').isChecked(),false);
 // A stale page configuration must not supersede a newer worker revision.
 const fb=await context.newPage();await fb.goto('https://www.facebook.com/messages/t/20002/');
 const [tab]=await ui.evaluate(()=>chrome.tabs.query({url:'https://www.facebook.com/*'}));
 await until(async()=>ui.evaluate(async tab=>(await chrome.tabs.sendMessage(tab,{type:'tabStatus'})).configured,tab.id),'Restarted tab did not hydrate');
 const old=await rpc(ui,{type:'config'}),latest=await rpc(ui,{type:'save',settings:{focusGuard:true}});
 await until(async()=>ui.evaluate(async ({tab,revision})=>(await chrome.tabs.sendMessage(tab,{type:'tabStatus'})).appliedSettingsRevision===revision,{tab:tab.id,revision:latest.settingsRevision}),'MAIN did not acknowledge the latest revision');
 await fb.evaluate(({settings,settingsRevision})=>window.postMessage({channel:'pito-facebook-fixer:v1',direction:'extension',type:'configure',settings,settingsRevision},location.origin),old);
 await until(async()=>ui.evaluate(async tab=>(await chrome.tabs.sendMessage(tab,{type:'tabStatus'})).settings.focusGuard===true,tab.id),'New configuration did not reach content bridge');
 assert.equal(await fb.evaluate(()=>{first.focus();first.dispatchEvent(new InputEvent('input',{bubbles:true}));second.focus();return document.activeElement.id;}),'first','Stale configuration disabled the active MAIN guard');
 await rpc(ui,{type:'save',settings:{focusGuard:false}});
 assert.equal((await rpc(ui,{type:'config'})).settings.blockStory,false);
 console.log('PASS preferences survive full browser/worker restart; stale configuration cannot roll back the current revision');
 // Seed only synthetic local records for visual review; no real messages.
 await rpc(ui,{type:'save',settings:{archive:true}});
 const items=['Hẹn bạn lúc 19:30 nhé.','Mình gửi lại tài liệu sau buổi họp.','Đã nhận được rồi, cảm ơn bạn 😀'].map((text,index)=>({account:'10001',thread:'20002',id:`mid.ui.${index}`,text,token:`pff-${index+1}`}));
 await rpc(ui,{type:'observe',items});await rpc(ui,{type:'observe',items:items.map(item=>({...item,removed:true}))});
 await rpc(ui,{type:'save',settings:{theme:'light'}});await ui.reload();await ready(ui);
 await ui.emulateMedia({reducedMotion:'reduce'});
 for(const theme of ['light','dark']){
  await rpc(ui,{type:'save',settings:{theme}});await until(async()=>ui.evaluate(t=>document.documentElement.dataset.theme===t,theme),'Theme did not synchronize');
  await ui.setViewportSize({width:1440,height:1000});
  for(const page of ['overview','storage','archive','diagnostics']){
   await ui.evaluate(key=>location.hash=key,page);if(page==='archive')await ui.locator('.archive-row').first().waitFor();
   assert.equal(await ui.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   await ui.screenshot({path:path.join(output,`${page}-${theme}.png`),fullPage:true});
  }
  const p=await context.newPage();await p.goto(base+'popup.html');await ready(p);await p.setViewportSize({width:400,height:620});
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await p.screenshot({path:path.join(output,`popup-${theme}.png`),fullPage:true});await p.close();
 }
 for(const width of [375,768]){
  await ui.setViewportSize({width,height:900});
  for(const key of ['overview','storage','archive','diagnostics']){await ui.evaluate(key=>location.hash=key,key);assert.equal(await ui.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${key} overflows at ${width}px`);}
 }
 await ui.setViewportSize({width:375,height:900});await ui.evaluate(()=>location.hash='overview');await ui.screenshot({path:path.join(output,'mobile-dark.png'),fullPage:true});
 // Keyboard-native switch and dialogs retain focus and expose development state.
 await ui.setViewportSize({width:1440,height:1000});await ui.locator('[name="focusGuard"]').focus();await ui.keyboard.press('Space');
 await until(async()=>(await rpc(ui,{type:'config'})).settings.focusGuard===true,'Space did not persist the switch');
 assert.equal(await ui.getByRole('switch',{name:'Hide story views — in development'}).isDisabled(),true);
 await ui.evaluate(()=>location.hash='storage');await ui.locator('#requestImages').click();await ui.keyboard.press('Escape');
 assert.equal(await ui.locator('#purgePanel').evaluate(n=>n.open),false);assert.equal(await ui.locator('#requestImages').evaluate(n=>n===document.activeElement),true);
 assert.equal(requests.some(url=>!url.startsWith('https://www.facebook.com/')),false,'Extension UI requested a remote resource');assert.deepEqual(errors,[]);
 const report={synthetic:true,primaryFacebookUsed:false,popupClosePersistence:true,concurrentPatchMerge:true,synchronizedViews:true,delayedConfiguration:true,facebookReloads:5,browserRestartPersistence:true,staleConfigurationIgnored:true,storySuspended:true,lightDark:true,responsiveWidths:[375,768,1440],keyboardAndDialog:true,remoteUIResources:false,passed:true};
 await writeFile('test-results/settings-browser-report.json',JSON.stringify(report,null,2));console.log('PASS complete redesigned UI in light/dark, popup and three widths; keyboard, modal focus and local-only resources');
}finally{await context.close();}
