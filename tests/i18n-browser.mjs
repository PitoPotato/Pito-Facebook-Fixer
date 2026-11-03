import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';

const output=path.resolve('test-results/i18n-brand'),profile=path.join(output,'profiles',crypto.randomUUID());await mkdir(profile,{recursive:true});
const catalog=JSON.parse(await readFile('src/locales/static.json','utf8'));
const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.PFF_TEST_BROWSER||path.resolve('test-results/browser-current/chrome-win64/chrome.exe'),headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${path.resolve('dist')}`,`--load-extension=${path.resolve('dist')}`],viewport:{width:1440,height:1000}});
const errors=[],remote=[];context.on('weberror',e=>errors.push(e.error().message));await context.route(/^https?:\/\//,r=>{remote.push(r.request().url());return r.abort();});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function until(check,message){for(let i=0;i<100;i++){if(await check())return;await sleep(100);}throw Error(message);}
const ready=p=>p.waitForFunction(()=>document.getElementById('settingsFields')?.disabled===false);
async function verifyStatic(page,language){
 const mismatches=await page.evaluate(({catalog,language})=>{
  const dynamic=new Set(['currentPage','feedback','connectionText','storageLimit','limitsState','purgeDescription','tabSummary']);
  const mismatches=[];
  for(const node of document.querySelectorAll('[data-i18n]'))if(node.tagName!=='TITLE'&&!dynamic.has(node.id)&&node.textContent!==catalog[node.dataset.i18n]?.[language])mismatches.push(node.dataset.i18n);
  for(const attr of ['aria-label','placeholder','title'])for(const node of document.querySelectorAll(`[data-i18n-${attr}]`))if(node.id!=='themeButton'&&node.getAttribute(attr)!==catalog[node.getAttribute(`data-i18n-${attr}`)]?.[language])mismatches.push(attr+':'+node.id);
  return mismatches;
 },{catalog,language});assert.deepEqual(mismatches,[]);
}
try{
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),base=`chrome-extension://${new URL(worker.url()).hostname}/`;
 const ui=await context.newPage();await ui.goto(base+'options.html');await ready(ui);await ui.emulateMedia({reducedMotion:'reduce'});
 const rpc=m=>ui.evaluate(async m=>{const r=await chrome.runtime.sendMessage(m);if(!r.ok)throw Error(r.error);return r;},m);
 assert.equal((await rpc({type:'config'})).settings.language,'en');assert.equal(await ui.locator('html').getAttribute('lang'),'en');
 assert.equal(await ui.locator('#languageCode').textContent(),'EN');assert.equal(await ui.locator('#languageButton').evaluate(n=>n.nextElementSibling.id),'themeButton');
 await verifyStatic(ui,'en');
 assert.equal(await ui.locator('.brand-symbol img').evaluate(n=>n.complete&&n.naturalWidth>0),true);
 const config=(await rpc({type:'config'})).settings;await rpc({type:'save',settings:{maxBytes:48*1024*1024,retentionDays:19,autoVoice:false,cleanupRemoved:false}});
 const originals=['Tổng quan','Open settings','<img src=x onerror=alert(1)>'];
 const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
 const items=originals.map((text,i)=>({account:'10001',thread:'20002',id:`mid.i18n.${i}`,token:`pff-${i+1}`,text,...(!i?{media:[{kind:'image',url:`data:image/png;base64,${png}`,position:0}]}:{})}));
 await rpc({type:'observe',items});await rpc({type:'observe',items:items.map(item=>({...item,removed:true}))});
 await ui.getByRole('link',{name:'Storage',exact:true}).click();await ui.locator('[name="budgetMiB"]').fill('96');
 const popup=await context.newPage();await popup.goto(base+'popup.html');await ready(popup);
 await ui.getByRole('button',{name:'Switch to Vietnamese',exact:true}).click();
 await until(async()=>await popup.locator('html').getAttribute('lang')==='vi','Language did not sync to popup');await verifyStatic(ui,'vi');await verifyStatic(popup,'vi');
 assert.equal(await ui.locator('[name="budgetMiB"]').inputValue(),'96','Changing language erased an unapplied numeric draft');
 assert.equal((await rpc({type:'config'})).settings.maxBytes,48*1024*1024);assert.equal((await rpc({type:'config'})).settings.retentionDays,19);
 await popup.reload();await ready(popup);assert.equal(await popup.locator('html').getAttribute('lang'),'vi');
 await popup.locator('#languageButton').click();await until(async()=>await ui.locator('html').getAttribute('lang')==='en','Popup language change did not sync to options');
 await popup.close();await ui.reload();await ready(ui);assert.equal(await ui.locator('html').getAttribute('lang'),'en');
 for(const language of ['en','vi']){
  await rpc({type:'save',settings:{language}});await until(async()=>await ui.locator('html').getAttribute('lang')===language,'Language not applied');
  for(const theme of ['light','dark']){
   await rpc({type:'save',settings:{theme}});await until(async()=>ui.evaluate(t=>document.documentElement.dataset.theme===t,theme),'Theme not applied');
   for(const route of ['overview','storage','archive','diagnostics']){
    await ui.evaluate(route=>location.hash=route,route);if(route==='archive')await ui.locator('.archive-row').first().waitFor();
    await verifyStatic(ui,language);assert.equal(await ui.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    if(theme==='light'||route==='overview')await ui.screenshot({path:path.join(output,`${route}-${language}-${theme}.png`),fullPage:true});
   }
  }
  await ui.evaluate(()=>location.hash='archive');
  const contents=await ui.locator('.archive-row .message-body').allTextContents();assert.deepEqual([...contents].sort(),[...originals].sort());
  assert.equal(await ui.locator('.message-body img').count(),0,'Message text was interpreted as HTML');
  await until(async()=>ui.locator('.archive-row img').evaluate(n=>n.complete&&n.naturalWidth>0),'Saved photo did not decode');
  await ui.locator('.archive-row img').evaluate(n=>{window.originalSavedImage=n;});
  await ui.locator('#languageButton').click();await until(async()=>await ui.locator('html').getAttribute('lang')!==language,'Archive language did not switch');
  assert.equal(await ui.locator('.archive-row img').evaluate(n=>n===window.originalSavedImage),true,'Language switch replaced a saved media element');
  await rpc({type:'save',settings:{language}});await until(async()=>await ui.locator('html').getAttribute('lang')===language,'Language did not restore');
  await ui.evaluate(()=>location.hash='storage');await ui.locator('#requestImages').click();
  assert.match(await ui.locator('#purgeDescription').textContent(),language==='en'?/photos/:/ảnh/);await verifyStatic(ui,language);
  await ui.locator('#purgeDays').fill('-1');await ui.locator('#confirmPurge').click();assert.match(await ui.locator('#purgeFeedback').innerText(),language==='en'?/whole number/:/Nhập số/);
  await ui.keyboard.press('Escape');
  for(const width of [375,768]){await ui.setViewportSize({width,height:900});for(const route of ['overview','storage','archive','diagnostics']){await ui.evaluate(route=>location.hash=route,route);assert.equal(await ui.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${language}/${route} overflow ${width}`);}}
  await ui.setViewportSize({width:1440,height:1000});
 }
 assert.equal((await rpc({type:'config'})).settings.autoVoice,false);assert.equal((await rpc({type:'config'})).settings.cleanupRemoved,false);assert.equal(remote.length,0);assert.deepEqual(errors,[]);
 const manifest=await ui.evaluate(()=>chrome.runtime.getManifest());assert.deepEqual(Object.keys(manifest.icons).sort(),['128','16','32','48']);
 const report={passed:true,synthetic:true,primaryFacebookUsed:false,englishDefault:true,staticStrings:Object.keys(catalog).length,bilingualAllPages:true,crossViewSync:true,reloadPersistence:true,draftsAndOtherSettingsPreserved:true,messageBodiesNotTranslated:true,mediaNodePreserved:true,bilingualDialogsAndErrors:true,responsive:true,logoLoaded:true,toolbarIcons:true,remoteResources:false};
 await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log('PASS bilingual UI, English default, persisted language, cross-view sync, untranslated message bodies, media preservation, branding and responsive layout');
}finally{await context.close();}
