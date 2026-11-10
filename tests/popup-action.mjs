import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Actual Chrome toolbar bubbles in a new isolated profile. No Facebook login,
// personal tabs or browser sessions are used. Never set the popup viewport.
const output=path.resolve('test-results/popup-action'),profile=path.join(output,'profiles',crypto.randomUUID());await mkdir(profile,{recursive:true});
const extension=path.resolve('dist'),scale=process.env.PFF_TEST_SCALE||'1.5';
const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.PFF_TEST_BROWSER||path.resolve('test-results/browser-current/chrome-win64/chrome.exe'),headless:false,viewport:null,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--window-size=1100,850',`--force-device-scale-factor=${scale}`]});
await context.route(/^https?:\/\//,route=>route.abort());
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,message){for(let i=0;i<80;i++){if(await check())return;await sleep(100);}throw Error(message);}
try{
 // Pick this extension's own worker; Chrome can list other internal workers first.
 const isOwn=w=>/^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(w.url());
 const firstWorker=context.serviceWorkers().find(isOwn)||await context.waitForEvent('serviceworker',{predicate:isOwn}),extensionId=new URL(firstWorker.url()).hostname;
 // An MV3 worker can be stopped and restarted by Chrome at any time; always use the live one.
 const worker={async evaluate(fn,arg){let last;for(let attempt=0;attempt<10;attempt++){const live=context.serviceWorkers().filter(isOwn).at(-1)||await context.waitForEvent('serviceworker',{predicate:isOwn,timeout:5000}).catch(()=>null);try{if(live)return await live.evaluate(fn,arg);}catch(error){last=error;}await sleep(200);}throw last||Error('Extension worker unavailable');}};
 const host=context.pages()[0];await host.goto('about:blank');await host.bringToFront();
 const browserSession=await context.browser().newBrowserCDPSession(),results=[],version=await worker.evaluate(()=>chrome.runtime.getManifest().version);
 for(const language of ['en','vi'])for(const theme of ['system','light','dark']){
  await worker.evaluate(async ({theme,language})=>{const {settings}=await chrome.storage.local.get('settings');await chrome.storage.local.set({settings:{...settings,theme,language}});},{theme,language});
  await worker.evaluate(()=>chrome.action.openPopup());
  let target;await until(async()=>{target=(await browserSession.send('Target.getTargets')).targetInfos.find(t=>t.url===`chrome-extension://${extensionId}/popup.html`);return !!target;},'The native toolbar popup did not open');
  const {sessionId}=await browserSession.send('Target.attachToTarget',{targetId:target.targetId,flatten:false});
  let serial=0;const pending=new Map();
  const received=event=>{if(event.sessionId!==sessionId)return;const message=JSON.parse(event.message),waiter=pending.get(message.id);if(waiter){pending.delete(message.id);message.error?waiter.reject(Error(message.error.message)):waiter.resolve(message.result);}};
  browserSession.on('Target.receivedMessageFromTarget',received);
  const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});browserSession.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(reject);setTimeout(()=>{if(pending.delete(id))reject(Error(`Popup CDP timeout: ${method}`));},8000).unref();});
  const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text);return result.result.value;};
  await send('Runtime.enable');
  await until(()=>evaluate('document.getElementById("settingsFields")?.disabled===false'),'Popup settings were not loaded');await sleep(250);
  const metrics=await evaluate(`({language:document.documentElement.lang,logoLoaded:document.querySelector(".brand-symbol img").complete&&document.querySelector(".brand-symbol img").naturalWidth>0,logoWidth:document.querySelector('.brand-symbol img').getBoundingClientRect().width,controlsGap:document.getElementById('themeButton').getBoundingClientRect().left-document.getElementById('languageButton').getBoundingClientRect().right,controlsAdjacent:document.getElementById("languageButton").nextElementSibling.id==="themeButton",width:innerWidth,height:innerHeight,dpr:devicePixelRatio,clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,scrollHeight:document.documentElement.scrollHeight,bodyWidth:document.body.getBoundingClientRect().width,copyWidths:[...document.querySelectorAll('.setting-copy')].map(n=>n.getBoundingClientRect().width),buttonWidth:document.getElementById('openOptions').getBoundingClientRect().width,loaded:!document.getElementById('settingsFields').disabled})`);
  // Write diagnostics before assertions so regressions preserve actual sizes.
  results.push({theme,...metrics});
  const report={realToolbarPopup:true,primaryFacebookUsed:false,browserVersion:context.browser().version(),scale,results};
  const major=report.browserVersion.split('.')[0],reportName=`report-${version}-${major}-${scale}.json`;
  await writeFile(path.join(output,reportName),JSON.stringify(report,null,2));
  assert.equal(metrics.language,language);assert.ok(metrics.logoLoaded);assert.ok(metrics.controlsAdjacent);
  assert.ok(metrics.logoWidth>=32);assert.ok(metrics.controlsGap>=0&&metrics.controlsGap<=8,'Language and theme controls are not visually adjacent');
  assert.equal(metrics.width,400,`Toolbar popup collapsed to ${metrics.width}px`);
  assert.ok(metrics.copyWidths.every(width=>width>=200),'Popup descriptions are squeezed');
  assert.ok(metrics.scrollWidth<=metrics.width,'Popup overflows horizontally');
  assert.ok(metrics.scrollHeight<=metrics.height,'Normal popup requires vertical scrolling');
  assert.ok(metrics.buttonWidth>=350,'Settings button is squeezed');
  const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(path.join(output,`native-${version}-${major}-${scale}-${language}-${theme}.png`),Buffer.from(shot.data,'base64'));
  const previous=await evaluate('document.querySelector("[name=focusGuard]").checked');
  await evaluate('document.querySelector("[name=focusGuard]").click()');
  await evaluate('setTimeout(()=>window.close(),0); true');
  await until(async()=>worker.evaluate(async expected=>(await chrome.storage.local.get('settings')).settings.focusGuard===expected,!previous),'A setting change was lost when the toolbar popup closed');
  await until(async()=>!(await browserSession.send('Target.getTargets')).targetInfos.some(t=>t.targetId===target.targetId),'The real toolbar popup did not close');
  await host.bringToFront();
  browserSession.off('Target.receivedMessageFromTarget',received);
  if(theme==='dark'&&language==='vi'){report.passed=true;report.autoSaveAfterNativeClose=true;await writeFile(path.join(output,reportName),JSON.stringify(report,null,2));}
 }
 console.log(JSON.stringify({passed:true,browser:context.browser().version(),scale,themes:results.map(r=>({theme:r.theme,language:r.language,width:r.width,height:r.height,textWidth:r.copyWidths[0]})),nativeAutoSave:true}));
}finally{await context.close();}
