// Live QA controller: only opens profiles created inside this project's QA root.
// No discovery of, attachment to, or cookie import from personal browsers.
import {chromium} from 'playwright';
import {createServer} from 'node:http';
import {mkdir,writeFile,cp,readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {existsSync} from 'node:fs';

const root=path.resolve('test-results/facebook-live-qa');
const profile=path.resolve(process.argv[2]||'');
if(!profile.startsWith(root+path.sep)||path.basename(profile)!=='profile'||!existsSync(profile))throw Error('Only the separately created QA profile is permitted');
const executable=path.resolve('test-results/browser-current/chrome-win64/chrome.exe');
// A unique copy of the build gets a fresh extension origin/worker cache while
// keeping the original, user-confirmed QA device's E2EE state intact. No cache
// deletion, auth-cookie export/import or personal profile access is necessary.
const reuse=process.env.PFF_QA_EXTENSION_BUILD;
const extension=reuse?path.resolve(reuse):path.join(root,'builds',crypto.randomUUID());
if(reuse){
  if(!extension.startsWith(path.join(root,'builds')+path.sep))throw Error('Only an existing QA extension build is permitted');
  for(const name of await readdir('dist'))if(!(await readFile(path.join('dist',name))).equals(await readFile(path.join(extension,name))))throw Error('QA build differs from dist');
}else{await mkdir(extension,{recursive:true});await cp(path.resolve('dist'),extension,{recursive:true});}
const context=await chromium.launchPersistentContext(profile,{executablePath:executable,headless:false,viewport:null,
  ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--window-size=1300,900',
    '--mute-audio','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',`--use-file-for-fake-audio-capture=${path.resolve('test-results/media-fixtures/pff-qa-voice.wav')}`]});
context.setDefaultTimeout(5000);
let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
const extensionId=new URL(worker.url()).hostname;
const ui=await context.newPage();await ui.goto(`chrome-extension://${extensionId}/options.html`);
const fb=await context.newPage();
const qaViewer=(await context.cookies('https://www.facebook.com/')).find(c=>c.name==='c_user')?.value;
if(!/^\d+$/.test(qaViewer||''))throw Error('Only the already confirmed test-account session can be used');
let startupError=null;
try {
await fb.goto('https://www.facebook.com/messages/',{waitUntil:'domcontentloaded'});
await fb.waitForFunction(()=>{try{return !!window.require('CurrentUserInitialData').NAME;}catch{return false;}},null,{timeout:15000});
const qaName=await fb.evaluate(()=>window.require('CurrentUserInitialData').NAME);
const selfLink=fb.getByRole('link').filter({hasText:qaName});
await selfLink.waitFor({state:'visible',timeout:5000}).catch(()=>{});
if(await selfLink.count()===1)await selfLink.click();
else {
  if(await selfLink.count()>1)throw Error('Self chat is ambiguous');
  await fb.goto(`https://www.facebook.com/messages/t/${qaViewer}/`,{waitUntil:'domcontentloaded'});
  const continueButton=fb.getByRole('button',{name:'Continue',exact:true});
  await continueButton.waitFor({state:'visible',timeout:15000});await continueButton.click();
}
await fb.locator('[contenteditable="true"][role="textbox"]').waitFor({state:'visible',timeout:15000});
} catch(error) { startupError=error.message; }
const rpc=async message=>{const result=await ui.evaluate(async m=>chrome.runtime.sendMessage(m),message);if(!result?.ok)throw Error(result?.error||'RPC failed');return result;};
const source=(await rpc({type:'status'})).sourceBuild;
if(source!=='0.3.0-archive-v1')throw Error('QA extension worker does not match the current source build');
let current=null, mobileMessages=[];
const persistedMobileEvents=[];
await fb.exposeBinding('__pffRecordMobileAudit',(_source,events)=>{
  for(const event of events)if(persistedMobileEvents.length<6000)persistedMobileEvents.push(event);
});
const report={primaryFacebookUsed:false,profileIsolated:true,browserVersion:context.browser().version(),cycles:[]};
const reportDir=path.resolve('test-results/live-qa-0.3.0');await mkdir(reportDir,{recursive:true});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(check,message){for(let n=0;n<60;n++){if(await check())return;await delay(200);}throw Error(message);}
async function account(){const cookies=await context.cookies('https://www.facebook.com/');const id=cookies.find(c=>c.name==='c_user')?.value;if(!/^\d+$/.test(id||''))throw Error('Test account is not signed in');return id;}
async function sendQaText(text){
  if(!/^PFF-QA-/.test(text))throw Error('Only synthetic QA text is permitted');
  const editor=fb.locator('[contenteditable="true"][role="textbox"]');
  await editor.fill(text);
  for(let attempt=0;attempt<3;attempt++){
    if(attempt&&await fb.locator('[data-message-id]').filter({hasText:text}).count())return;
    if((await editor.innerText()).trim()!==text)throw Error('QA draft changed unexpectedly');
    await editor.click();await editor.press('Enter');
    try{await fb.locator('[data-message-id]').filter({hasText:text}).waitFor({state:'visible',timeout:5000});return;}
    catch(error){if(attempt===2)throw error;}
  }
}
async function identityCheck(){const id=await account();return fb.evaluate(id=>{try{const d=window.require('CurrentUserInitialData');return String(d.USER_ID)===id&&document.body.innerText.includes(d.NAME);}catch{return false;}},id);}
async function tabStatus(){const tabs=await ui.evaluate(async()=>chrome.tabs.query({url:'https://www.facebook.com/*'}));const tab=tabs.find(t=>t.url?.startsWith(fb.url()));if(!tab)throw Error('QA Facebook tab missing');return ui.evaluate(async id=>chrome.tabs.sendMessage(id,{type:'tabStatus'}),tab.id);}
async function inspect(){return {startupError,path:new URL(fb.url()).pathname.replace(/\d+/g,'<id>'),body:(await fb.locator('body').innerText()).slice(-3000),stats:(await rpc({type:'status'})).stats,status:await tabStatus()};}
async function adopt(text){
  if(typeof text!=='string'||!/^PFF-QA-/.test(text))throw Error('Only disposable PFF-QA messages are permitted');
  const link=fb.getByRole('link').filter({hasText:text});
  if(await link.count()===1)await link.click();
  await fb.locator('[contenteditable="true"][role="textbox"]').waitFor({state:'visible',timeout:15000});
  if(!await identityCheck())throw Error('Self-chat identity not confirmed');
  const target=fb.locator('[data-message-id]').filter({hasText:text});
  await target.waitFor({state:'visible',timeout:15000});
  if(await target.count()!==1)throw Error('QA message is ambiguous or absent');
  current={text,id:await target.getAttribute('data-message-id'),cycle:report.cycles.length+1};
  await waitFor(async()=>!!await target.getAttribute('data-pff-key'),'Message was not captured by adapter');
  current.archiveId=JSON.parse(await target.getAttribute('data-pff-key'))[2];
  await waitFor(async()=>ui.evaluate(async key=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('pito-message-archive-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const found=await new Promise((resolve,reject)=>{const r=db.transaction('messages').objectStore('messages').index('accountMessage').getKey(key);r.onsuccess=()=>resolve(!!r.result);r.onerror=()=>reject(r.error);});db.close();return found;
  },[qaViewer,current.archiveId]),'Message did not commit to IndexedDB');
  await target.evaluate(target=>{
    window.__pffQaIdentity={row:target,article:target.closest('[role="article"]'),events:[]};
    window.__pffQaObserver?.disconnect();
    window.__pffQaObserver=new MutationObserver(mutations=>{
      const state=window.__pffQaIdentity;
      for(const m of mutations){
        if(state.events.length>=20)break;
        if(m.type==='attributes'&&m.attributeName==='data-message-id'&&(m.target===state.row||state.article.contains(m.target)))state.events.push({type:'id',before:m.oldValue,after:m.target.getAttribute('data-message-id')});
        if(m.type==='childList'&&(m.target===state.article||state.article.contains(m.target)))state.events.push({type:'children',rowStillConnected:state.row.isConnected,articleStillConnected:state.article.isConnected});
      }
    });
    window.__pffQaObserver.observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeOldValue:true,attributeFilter:['data-message-id']});
  });
  return {selected:true,stats:(await rpc({type:'status'})).stats};
}
async function findCurrentById(){
  if(!current)throw Error('No QA message selected');
  const nativeId=await fb.evaluate(()=>{const state=window.__pffQaIdentity;return state?.row?.isConnected?state.row.getAttribute('data-message-id'):null;});
  if(nativeId)current.id=nativeId;
  const key=JSON.stringify([qaViewer,'by-message-id',current.archiveId]);
  const canonical=fb.locator(`[data-pff-key=${JSON.stringify(key)}]`);
  if(await canonical.count()===1)return canonical;
  const aliases=await ui.evaluate(async key=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('pito-message-archive-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    const record=await new Promise((resolve,reject)=>{const r=db.transaction('messages').objectStore('messages').index('accountMessage').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();return record?.aliases||[];
  },[qaViewer,current.archiveId]);
  const matches=await fb.locator('[data-message-id]').evaluateAll((nodes,ids)=>nodes.filter(n=>{
    const id=n.getAttribute('data-message-id'),sequence=id.match(/^(?:\d+@msgr\.)?(\d{16,})$/)?.[1];
    return ids.includes(sequence?`msgr.${sequence}`:id);
  }).map(n=>({id:n.getAttribute('data-message-id'),key:n.getAttribute('data-pff-key')})),[current.archiveId,...aliases]);
  if(matches.length===1){current.id=matches[0].id;if(matches[0].key)return fb.locator(`[data-pff-key=${JSON.stringify(matches[0].key)}]`);}
  return fb.locator(`[data-message-id=${JSON.stringify(current.id)}]`);
}
const SAFE_STEP_FIELDS=new Set(['op','name']);
async function execute(command){
  const started=new Date().toISOString();
  try{const result=await executeStep(command);await recordStep(command,started,{ok:true,result});return result;}
  catch(error){await recordStep(command,started,{ok:false,error:error.message});throw error;}
}
async function recordStep(command,started,outcome){
  if(!['send','edit','details','unsend','choose','confirm','verify','vault','bubble','reload','probe'].includes(command.op))return;
  report.steps=report.steps||[];
  const step=Object.fromEntries(Object.entries(command).filter(([key])=>SAFE_STEP_FIELDS.has(key)));
  const result=outcome.result&&typeof outcome.result==='object'?JSON.parse(JSON.stringify(outcome.result,(key,value)=>key==='dialogs'?undefined:value)):outcome.result;
  report.steps.push({...step,started,ok:outcome.ok,...(outcome.ok?{result}:{error:outcome.error}),qaMessage:current?.text?.slice(0,60)||null});
  await writeFile(path.join(reportDir,'report.json'),JSON.stringify({...report,vaultPassword:undefined},null,2));
}
async function executeStep(command){
  switch(command.op){
    case 'preferences-check':{
      if(!await identityCheck())throw Error('Only the confirmed self-chat test tab may be refreshed');
      const networkNative=await fb.evaluate(()=>/\[native code\]/.test(fetch.toString())&&/\[native code\]/.test(XMLHttpRequest.prototype.send.toString()));
      if(!networkNative)throw Error('Story runtime is not fully suspended on this QA build');
      const original=(await rpc({type:'config'})).settings;
      await ui.goto(`chrome-extension://${extensionId}/options.html#storage`);
      await ui.waitForFunction(()=>document.getElementById('settingsFields')?.disabled===false);
      await ui.locator('[name="budgetMiB"]').fill('48');await ui.locator('[name="retentionDays"]').fill('21');await ui.locator('#save').click();
      await waitFor(async()=>(await rpc({type:'config'})).settings.maxBytes===48*1024*1024,'Numeric preference did not commit');
      const popup=await context.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`);
      await popup.waitForFunction(()=>document.getElementById('settingsFields')?.disabled===false);
      await popup.locator('[name="focusGuard"]').setChecked(!original.focusGuard);await popup.close();
      await waitFor(async()=>(await rpc({type:'config'})).settings.focusGuard===!original.focusGuard,'Popup setting lost on closure');
      const expected=(await rpc({type:'config'})).settings,checks=[];
      for(let index=0;index<3;index++){
        await execute({op:'reload'});
        await waitFor(async()=>{const s=await tabStatus();return s.configured&&s.appliedSettingsRevision===s.settingsRevision&&JSON.stringify(s.settings)===JSON.stringify(expected);},'Facebook reload reset stored or applied settings');
        checks.push({reload:index+1,persisted:true,mainApplied:true});
      }
      const result={primaryFacebookUsed:false,storyNetworkNative:networkNative,popupClosedWithoutSave:true,checks,expected,original,extension};
      await writeFile(path.join(reportDir,'preferences-live.json'),JSON.stringify(result,null,2));return {checks,extension,passed:true};
    }
    case 'preferences-verify':{
      const previous=JSON.parse(await readFile(path.join(reportDir,'preferences-live.json'),'utf8'));
      const current=(await rpc({type:'config'})).settings;
      if(JSON.stringify(current)!==JSON.stringify(previous.expected))throw Error('Preferences did not survive restarting the QA browser');
      await waitFor(async()=>{const s=await tabStatus();return s.configured&&s.appliedSettingsRevision===s.settingsRevision&&JSON.stringify(s.settings)===JSON.stringify(current);},'Restarted Facebook did not apply stored preferences');
      previous.restartPersistence=true;previous.passed=true;await writeFile(path.join(reportDir,'preferences-live.json'),JSON.stringify(previous,null,2));
      await rpc({type:'save',settings:previous.original});return {restartPersistence:true,originalQaSettingsRestored:true,passed:true};
    }
    case 'status':return inspect();
    case 'media-verify':{
      const state=await execute({op:'media-capture-status'}),results=[];
      for(const record of state.records.filter(r=>r.removed)){
        const aliases=await ui.evaluate(async key=>{
          const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('pito-message-archive-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          const row=await new Promise((resolve,reject)=>{const r=db.transaction('messages').objectStore('messages').index('accountMessage').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();return row?.aliases||[];
        },[qaViewer,record.id]);
        const ids=[record.id,...aliases];
        const findNative=()=>fb.locator('[data-message-id]').evaluateAll((nodes,ids)=>nodes.filter(n=>{
          const value=n.getAttribute('data-message-id'),sequence=value.match(/^(?:\d+@msgr\.)?(\d{16,})$/)?.[1];return ids.includes(sequence?`msgr.${sequence}`:value);
        }).map(n=>n.getAttribute('data-message-id')),ids);
        let native;
        await waitFor(async()=>{native=await findNative();return native.length===1;},'Expected one native row for archived QA media');
        const row=fb.locator(`[data-message-id=${JSON.stringify(native[0])}]`);await row.scrollIntoViewIfNeeded();
        await row.locator('[data-pff-restored]').waitFor({state:'attached'});
        if(record.kind==='emoji'){
          if(!(await row.textContent()).includes(record.text))throw Error('Emoji body missing');
        }else{
          const element=row.locator(record.kind==='image'?'[data-pff-media] img':'[data-pff-media] audio');
          await waitFor(async()=>element.evaluate(n=>n instanceof HTMLImageElement?n.complete&&n.naturalWidth>0:n.readyState>=1&&Number.isFinite(n.duration)&&n.duration>0),'Restored media did not decode');
          if(record.kind==='image'&&await element.count()!==1)throw Error('A restored album must show exactly one photo');
          for(let index=0;index<record.assets.length;index++){
          if(index){await row.getByRole('button',{name:/^(?:Ảnh sau|Next photo)$/,exact:true}).click();await waitFor(async()=>element.getAttribute('src').then(Boolean),'Next album photo failed to load');}
          const hash=await element.evaluate(async n=>{
            const bytes=await(await fetch(n.src)).arrayBuffer();return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
          });
          if(hash!==record.assets[index].digest)throw Error('Restored media differs from stored bytes');
          }
          if(record.kind==='voice'){
            await element.evaluate(n=>{n.currentTime=0;return n.play();});
            await waitFor(async()=>element.evaluate(n=>n.currentTime>0),'Archived voice did not play');
            await element.evaluate(n=>n.pause());
          }
        }
        results.push({kind:record.kind,files:record.assets.length,decoded:true,byteIntegrity:record.kind==='emoji'?undefined:true,playback:record.kind==='voice'?true:undefined});
      }
      if(!['emoji','image','voice'].every(kind=>results.some(r=>r.kind===kind)))throw Error('All three QA media types must be restored');
      await writeFile(path.join(reportDir,'media-result.json'),JSON.stringify({primaryFacebookUsed:false,results,passed:true},null,2));return results;
    }
    case 'voice-play':{
      if(!await identityCheck())throw Error('Self-chat identity not confirmed');
      const play=fb.locator('[data-message-id]').filter({has:fb.locator('[aria-label="Audio scrubber"]')}).getByRole('button',{name:'Play',exact:true}).last();
      await play.click();await delay(1800);return execute({op:'media-capture-status'});
    }
    case 'media-capture-status':{
      const rows=await ui.evaluate(async()=>{
        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('pito-message-archive-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        const rows=await new Promise((resolve,reject)=>{const r=db.transaction('messages').objectStore('messages').getAll(undefined,100);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();
        return rows.filter(r=>r.kind==='emoji'||r.assets?.length).map(r=>({id:r.id,kind:r.kind||r.assets[0].kind,removed:!!r.removedAt,text:r.codec==='utf8'?new TextDecoder().decode(r.data):'',assets:(r.assets||[]).map(a=>({kind:a.kind,mime:a.mime,size:a.blob.size,digest:a.digest}))}));
      });return {records:rows,stats:(await rpc({type:'status'})).stats,status:await tabStatus()};
    }
    case 'media-unsend':{
      if(!['image','voice','emoji'].includes(command.kind))throw Error('Only synthetic QA media types are allowed');
      if(!await identityCheck())throw Error('Self-chat identity not confirmed');
      const state=await execute({op:'media-capture-status'}),record=state.records.filter(r=>r.kind===command.kind&&!r.removed).at(-1);
      if(!record)throw Error('No committed QA media record of this type');
      current={id:record.id,archiveId:record.id,text:record.text,expectedMedia:command.kind,assets:record.assets};
      await execute({op:'unsend'});
      const dialog=fb.getByRole('dialog');await dialog.getByText('Unsend for everyone',{exact:true}).click();
      await dialog.getByRole('button').filter({hasText:/^Remove$/}).click();await delay(1800);
      return execute({op:'media-capture-status'});
    }
    case 'image-select':case 'image-album':{
      if(!await identityCheck())throw Error('Self-chat identity not confirmed');
      const remove=fb.getByRole('button',{name:'Remove attachment',exact:true});
      while(await remove.count())await remove.first().click();
      await fb.locator('input[type="file"]').setInputFiles(command.op==='image-album'?['pff-qa-image.png','pff-qa-image-2.png'].map(name=>path.resolve('test-results/media-fixtures',name)):path.resolve('test-results/media-fixtures/pff-qa-image.png'));
      await fb.getByRole('button',{name:'Press Enter to send',exact:true}).click();
      await delay(1800);return {sent:true,album:command.op==='image-album'};
    }
    case 'voice-start':{
      if(!await identityCheck())throw Error('Self-chat identity not confirmed');
      await fb.getByRole('button',{name:'Send a voice clip',exact:true}).click();await delay(2200);
      await fb.getByRole('button',{name:'Stop Recording',exact:true}).click();
      await fb.getByRole('button',{name:'Press Enter to send',exact:true}).click();await delay(1800);
      return {labels:await fb.locator('[role="button"][aria-label],button[aria-label]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')).slice(-20)),body:(await fb.locator('body').innerText()).slice(-700)};
    }
    case 'voice-stop':{
      if(!await identityCheck())throw Error('Self-chat identity not confirmed');
      const stop=fb.getByRole('button',{name:'Stop recording',exact:true});
      return {count:await stop.count(),labels:await fb.locator('[role="button"][aria-label]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')).slice(-15))};
    }
    case 'image-send':{
      if(!await identityCheck())throw Error('Self-chat identity not confirmed');
      const send=fb.locator('[aria-label="Send"],[aria-label="Press Enter to send"]');
      return {sendCandidates:await send.count(),labels:await fb.locator('[role="button"][aria-label]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')).slice(-20))};
    }
    case 'media-inspect':{
      const rows=await fb.locator('[data-message-id]').evaluateAll(nodes=>nodes.slice(-20).map(row=>({
        id:row.getAttribute('data-message-id'),label:row.getAttribute('aria-label'),text:row.innerText,keys:Object.getOwnPropertyNames(row).filter(k=>k.startsWith('__')),
        ext:{type:typeof row.__ext,keys:row.__ext&&Object.keys(row.__ext),virtualType:Object.prototype.toString.call(row.__ext?.virtualPropertyValues),virtualKeys:row.__ext?.virtualPropertyValues&&Object.keys(row.__ext.virtualPropertyValues),virtualEntries:row.__ext?.virtualPropertyValues instanceof Map?[...row.__ext.virtualPropertyValues.keys()].map(String):[]},
        voiceHtml:row.querySelector('[aria-label="Play"],[aria-label="Pause"]')?row.outerHTML.slice(0,18000):undefined,
        images:[...row.querySelectorAll('img')].map(n=>({alt:n.alt,src:n.currentSrc||n.src,width:n.width,height:n.height,role:n.getAttribute('role')})),
        audio:[...row.querySelectorAll('audio,video,source')].map(n=>({tag:n.tagName,src:n.currentSrc||n.src,type:n.type})),
        buttons:[...row.querySelectorAll('[role="button"],button')].map(n=>({label:n.getAttribute('aria-label'),text:n.innerText})),
      })));
      await writeFile(path.join(reportDir,'media-dom.json'),JSON.stringify(rows,null,2));
      return {rows:rows.map(row=>({...row,images:row.images.map(img=>({...img,src:img.src.slice(0,180)}))})),inputs:await fb.locator('input[type="file"]').evaluateAll(nodes=>nodes.map(n=>({accept:n.accept,multiple:n.multiple}))),buttons:await fb.locator('[role="button"][aria-label],button[aria-label]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('aria-label')).slice(-40))};
    }
    case 'emoji-seed':{
      if(!await identityCheck())throw Error('Self-chat identity not confirmed');
      const ids=await fb.locator('[data-message-id]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-message-id')));
      const editor=fb.locator('[contenteditable="true"][role="textbox"]');await editor.fill('😀');await editor.press('Enter');
      await delay(1500);return {sent:true,newRows:await fb.locator('[data-message-id]').evaluateAll((nodes,ids)=>nodes.filter(n=>!ids.includes(n.getAttribute('data-message-id'))).map(n=>({id:n.getAttribute('data-message-id'),label:n.getAttribute('aria-label'),html:n.outerHTML.slice(0,12000)})),ids)};
    }
    case 'mobile-seed':{
      if(!await identityCheck())throw Error('Self-chat identity not confirmed');
      if(mobileMessages.length)throw Error('The mobile QA group is already prepared');
      const installAudit=()=>{
        const nodeIds=new WeakMap();let serial=0;
        const nodeId=n=>{if(!n)return null;if(!nodeIds.has(n))nodeIds.set(n,++serial);return nodeIds.get(n);};
        const describe=row=>{
          const models=[];let fiber=row[Object.keys(row).find(k=>k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$'))];
          for(let hop=0;fiber&&hop<12;hop++,fiber=fiber.return){
            const p=fiber.memoizedProps;if(!p||typeof p!=='object')continue;
            const value={hop,key:typeof fiber.key==='string'?fiber.key.slice(0,200):null};
            for(const [kind,c] of [['message',p.message],['messageData',p.messageData],['props',p]]){
              if(!c||typeof c!=='object')continue;
              const id=c.messageId??c.message_id??c.messageID;
              if(typeof id==='string'&&id.length<=200)value[kind]={id,unsent:c.isUnsent===true||c.is_unsent===true};
            }
            if(value.key||Object.keys(value).length>2)models.push(value);
          }
          return {node:nodeId(row),parent:nodeId(row.parentElement),nativeId:row.getAttribute('data-message-id'),
            key:row.getAttribute('data-pff-key'),label:row.getAttribute('aria-label'),
            tombstone:/deleted a message|unsent a message|đã (?:thu hồi|xóa|xoá)/i.test(row.textContent),
            restored:!!row.querySelector('[data-pff-restored]'),qa:row.textContent.includes('PFF-QA-MOBILE'),models};
        };
        window.__pffMobileAudit={events:[],describe};
        window.__pffMobileObserver?.disconnect();
        window.__pffMobileObserver=new MutationObserver(mutations=>{
          const audit=window.__pffMobileAudit;
          const rows=n=>n instanceof Element?[...(n.matches('[data-message-id]')?[n]:[]),...n.querySelectorAll('[data-message-id]')]:[];
          const fresh=[];
          for(const mutation of mutations){
            if(audit.events.length>=1500)break;
            const row=(mutation.target instanceof Element?mutation.target:mutation.target.parentElement)?.closest('[data-message-id]');
            const removed=[...mutation.removedNodes].flatMap(rows),added=[...mutation.addedNodes].flatMap(rows);
            if(!row&&!removed.length&&!added.length)continue;
            const event={at:Date.now(),type:mutation.type,attribute:mutation.attributeName,oldValue:mutation.type==='attributes'?mutation.oldValue:undefined,
              parent:nodeId(mutation.target),previous:nodeId(mutation.previousSibling),next:nodeId(mutation.nextSibling),
              row:row?describe(row):null,removed:removed.slice(0,32).map(describe),added:added.slice(0,32).map(describe)};
            audit.events.push(event);fresh.push(event);
          }
          if(fresh.length)window.__pffRecordMobileAudit(fresh).catch(()=>{});
        });
        window.__pffMobileObserver.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeOldValue:true,attributeFilter:['data-message-id','data-pff-key','data-is-unsent']});
        document.addEventListener('scroll',()=>window.__pffRecordMobileAudit([{at:Date.now(),type:'scroll'}]).catch(()=>{}),{capture:true,passive:true});
      };
      await fb.addInitScript(installAudit);await fb.evaluate(installAudit);
      const run=crypto.randomUUID().slice(0,8);
      const mobileCount=12;
      for(let i=1;i<=mobileCount;i++){
        const text=`PFF-QA-MOBILE-${run}-${i}/${mobileCount}`;
        await sendQaText(text);
        await adopt(text);mobileMessages.push({...current});
        await delay(800);
      }
      await fb.evaluate(()=>{window.__pffMobileAudit.events=[];});persistedMobileEvents.length=0;
      await writeFile(path.join(reportDir,'mobile-seed.json'),JSON.stringify({messages:mobileMessages},null,2));
      return {ready:true,prefix:`PFF-QA-MOBILE-${run}`,messages:mobileMessages.length,allCommitted:true};
    }
    case 'mobile-status':{
      if(!mobileMessages.length)throw Error('No mobile QA group');
      const records=await ui.evaluate(async keys=>{
        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('pito-message-archive-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        const rows=[];
        for(const key of keys){
          const row=await new Promise((resolve,reject)=>{const r=db.transaction('messages').objectStore('messages').index('accountMessage').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
          rows.push(row?{id:row.id,aliases:row.aliases||[],removed:!!row.removedAt}:null);
        }db.close();return rows;
      },mobileMessages.map(m=>[qaViewer,m.archiveId]));
      const rendered=await fb.locator('[data-pff-restored]').evaluateAll(nodes=>nodes.map(node=>{
        const nativeId=node.closest('[data-message-id]')?.getAttribute('data-message-id');
        const sequence=nativeId?.match(/^(?:\d+@msgr\.)?(\d{16,})$/)?.[1];
        return {text:node.textContent,id:sequence?`msgr.${sequence}`:nativeId};
      }));
      const renderingCorrect=(message,index)=>rendered.some(row=>row.text===message.text&&
        (records[index]?.id===row.id||records[index]?.aliases.includes(row.id)));
      const audit=await fb.evaluate(()=>({rows:[...document.querySelectorAll('[data-message-id]')].slice(-80).map(window.__pffMobileAudit.describe)}));
      audit.events=persistedMobileEvents;
      const summary={total:mobileMessages.length,committed:records.filter(Boolean).length,detectedRemoved:records.filter(r=>r?.removed).length,
        rendered:mobileMessages.filter(renderingCorrect).length,
        each:mobileMessages.map((m,i)=>({index:i+1,removed:records[i]?.removed||false,rendered:renderingCorrect(m,i)})),status:await tabStatus()};
      await writeFile(path.join(reportDir,'mobile-audit.json'),JSON.stringify({summary,messages:mobileMessages,records,audit},null,2));
      return summary;
    }
    case 'diagnose':{
      const records=await ui.evaluate(async()=>{
        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('pito-message-archive-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        const rows=await new Promise((resolve,reject)=>{const r=db.transaction('messages').objectStore('messages').getAll(undefined,20);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();
        return rows.map(r=>({account:r.account,thread:r.thread,id:r.id,removedAt:r.removedAt}));
      });
      const rows=await fb.locator('[data-pff-key]').evaluateAll(nodes=>nodes.map(n=>({key:JSON.parse(n.getAttribute('data-pff-key')),id:n.getAttribute('data-message-id'),unsent:/deleted|unsent|thu hồi|đã xóa/.test(n.innerText)})));
      const identity=await fb.evaluate(()=>{const s=window.__pffQaIdentity;return s?{rowSurvived:s.row.isConnected,articleSurvived:s.article.isConnected,rowId:s.row.getAttribute('data-message-id'),articleIds:[...s.article.querySelectorAll('[data-message-id]')].map(n=>n.getAttribute('data-message-id')),events:s.events}:null;});
      return {recordCount:records.length,identity,rows:rows.map(row=>({unsent:row.unsent,keyMatches:records.map(r=>({account:r.account===row.key[0],thread:r.thread===row.key[1],id:r.id===row.key[2],storedThread:r.thread,observedThread:row.key[1],storedId:r.id,observedId:row.key[2],removed:!!r.removedAt}))}))};
    }
    case 'adopt':return adopt(command.text);
    // Edits only the current disposable QA message, in the self chat.
    case 'edit':{
      const target=await findCurrentById();
      if(!(await target.innerText()).includes(current.text))throw Error('Selected row is no longer the synthetic QA message');
      await target.hover();
      const more=target.locator('xpath=ancestor::*[@role="article"][1]').locator('[aria-label="More actions"],[aria-label="More"]');
      await more.waitFor({state:'visible',timeout:5000});await more.click();
      const edit=fb.locator('[role="menuitem"]').filter({hasText:/^Edit$/});
      await edit.waitFor({state:'visible',timeout:5000});await edit.click();
      const edited=`${current.text} (đã sửa)`,editor=fb.locator('[contenteditable="true"][role="textbox"]').filter({hasText:current.text});
      await editor.waitFor({state:'visible',timeout:5000});
      await editor.fill(edited);await editor.press('Enter');
      await fb.locator('[data-message-id]').filter({hasText:edited}).waitFor({state:'visible',timeout:15000});
      const original=current.text;current.text=edited;
      await waitFor(async()=>{const rows=(await rpc({type:'list',state:'all',query:edited})).rows;return rows.some(row=>row.text===edited&&row.history.some(entry=>entry.text===original));},'Edit history was not archived');
      return {edited:true,historyArchived:true};
    }
    // Reports only fields of the current QA message, never other messages.
    case 'details':{
      if(!current)throw Error('No QA message');
      const row=(await rpc({type:'list',state:'all',query:current.text})).rows.find(entry=>entry.text===current.text);
      if(!row)throw Error('QA message not in archive');
      return {senderNamePresent:!!row.senderName,senderIdPresent:!!row.senderId,sentAt:row.sentAt||null,historyEntries:row.history.length,removed:!!row.removedAt,labelPresent:!!row.label};
    }
    case 'vault':{
      if(!['enable','lock','unlock','disable','status'].includes(command.name))throw Error('Unknown vault action');
      const password=report.vaultPassword||(report.vaultPassword=`qa-${crypto.randomUUID()}`);
      if(command.name==='status')return rpc({type:'vaultStatus'});
      if(command.name==='lock')return rpc({type:'vaultLock'});
      if(command.name==='unlock')return rpc({type:'vaultUnlock',password});
      const status=await rpc({type:command.name==='enable'?'vaultEnable':'vaultDisable',password});
      let after=null,slice;do{slice=await rpc({type:'vaultMigrate',after});after=slice.next;}while(after);
      return slice.vault;
    }
    // Names and types of time/sender props around the current QA row only. No values.
    case 'probe':{
      const target=await findCurrentById();
      if(!(await target.innerText()).includes(current.text))throw Error('Selected row is no longer the synthetic QA message');
      return target.evaluate(row=>{
        const key=Object.keys(row).find(k=>k.startsWith('__reactFiber$'));let fiber=row[key];const times=new Set(),senders=new Set(),ids=new Set();
        const shape=v=>typeof v==='number'?(v>1e12&&v<4e12?'number:epoch-ms':v>1e9&&v<4e9?'number:epoch-s':'number'):typeof v==='string'?(/^\d{12,13}$/.test(v)?'string:epoch-ms':/^\d{9,10}$/.test(v)?'string:epoch-s':'string'):Array.isArray(v)?'array':typeof v;
        for(let hops=0;fiber&&hops<30;hops++,fiber=fiber.return){
          const props=fiber.memoizedProps;if(!props||typeof props!=='object')continue;
          const visit=(prefix,object,depth)=>{
            for(const [name,value] of Object.entries(object)){
              const label=`${hops}:${prefix}${name}`;
              if(/time|stamp|date|sentat/i.test(name))times.add(`${label}=${shape(value)}`);
              if(/sender|author|actor/i.test(name))senders.add(`${label}=${shape(value)}`);
              if(/^(?:message_?id|messageID)$/i.test(name))ids.add(label);
              if(depth<2&&value&&typeof value==='object'&&!Array.isArray(value)&&!(value instanceof Node)&&Object.getPrototypeOf(value)===Object.prototype)visit(`${prefix}${name}.`,value,depth+1);
            }
          };
          visit('',props,0);
        }
        return {times:[...times].slice(0,60),senders:[...senders].slice(0,40),messageIdPaths:[...ids].slice(0,20)};
      });
    }
    case 'bubble':{
      if(!current)throw Error('No QA message');
      const restored=await fb.locator('[data-pff-restored]').filter({hasText:current.text}).count();
      const status=await tabStatus();
      return {restoredForCurrent:restored,visible:status.visible};
    }
    case 'send':{
      if(!await identityCheck())throw Error('Self-chat identity not confirmed');
      const text=`PFF-QA-${report.cycles.length+1}-${crypto.randomUUID()} — kiểm thử lưu và thu hồi`;
      const editor=fb.locator('[contenteditable="true"][role="textbox"]');
      await editor.fill(text);await editor.press('Enter');
      await fb.locator('[data-message-id]').filter({hasText:text}).waitFor({state:'visible',timeout:15000});
      return adopt(text);
    }
    case 'more':case 'unsend':{
      const target=await findCurrentById();
      if(!current.expectedMedia&&!(await target.innerText()).includes(current.text))throw Error('Selected row is no longer the synthetic QA message');
      await target.hover();
      const article=target.locator('xpath=ancestor::*[@role="article"][1]');
      const more=article.locator('[aria-label="More actions"],[aria-label="More"]');
      await more.waitFor({state:'visible',timeout:5000});
      await more.click();
      if(command.op==='unsend'){
        const unsend=fb.locator('[role="menuitem"]').filter({hasText:'Unsend'});
        await unsend.waitFor({state:'visible',timeout:5000});await unsend.click();
        const dialog=fb.getByRole('dialog');await dialog.waitFor({state:'visible',timeout:5000});
        return {dialogs:await dialog.allTextContents()};
      }
      return {menu:await fb.getByRole('menuitem').allTextContents()};
    }
    case 'menu':{
      if(!current||!['Delete','Remove','Unsend'].includes(command.name))throw Error('Only the test-message removal menu is allowed');
      await fb.getByRole('menuitem').filter({hasText:new RegExp(`^${command.name}$`)}).click();
      return {dialogs:await fb.getByRole('dialog').allTextContents()};
    }
    case 'choose':{
      if(!current||!['Delete for everyone','Unsend for everyone','Remove for everyone'].includes(command.name))throw Error('Only QA unsend mode is allowed');
      const dialog=fb.getByRole('dialog');
      const radio=dialog.getByRole('radio',{name:command.name,exact:true});
      if(await radio.count())await radio.check();else await dialog.getByText(command.name,{exact:true}).click();
      return {dialogs:await dialog.allTextContents()};
    }
    case 'confirm':{
      if(!current||!['Delete','Remove','Unsend'].includes(command.name))throw Error('Only QA removal confirmation is allowed');
      await fb.getByRole('dialog').getByRole('button').filter({hasText:new RegExp(`^${command.name}$`)}).click();
      return {confirmed:true};
    }
    case 'verify':{
      if(!current)throw Error('No QA message');
      await waitFor(async()=> (await rpc({type:'list'})).rows.some(r=>r.id===current.archiveId&&r.text===current.text),'Unsent message was not found in archive');
      // Facebook can re-key the row after restoration; select the unique QA
      // payload, then verify its native identity against the persisted aliases.
      const bubble=fb.locator('[data-pff-restored]').filter({hasText:current.text});
      await bubble.waitFor({state:'attached',timeout:15000});
      const nativeId=await bubble.evaluate(node=>node.closest('[data-message-id]').getAttribute('data-message-id'));
      const sequence=nativeId.match(/^(?:\d+@msgr\.)?(\d{16,})$/)?.[1];
      const canonical=sequence?`msgr.${sequence}`:nativeId;
      const validNative=await ui.evaluate(async ({key,nativeId})=>{
        const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('pito-message-archive-v1');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
        const record=await new Promise((resolve,reject)=>{const r=db.transaction('messages').objectStore('messages').index('accountMessage').get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});db.close();
        return record?.id===nativeId||record?.aliases?.includes(nativeId);
      },{key:[qaViewer,current.archiveId],nativeId:canonical});
      if(!validNative)throw Error('Rendered native bubble is not associated with this archived message');
      const cdp=await context.newCDPSession(fb);const ax=await cdp.send('Accessibility.getFullAXTree');await cdp.detach();
      if(!ax.nodes.some(n=>n.name?.value.includes(current.text)))throw Error('Saved text missing from accessible rendered output');
      if(!((await bubble.getAttribute('title'))||'').match(/(?:Bản lưu từ|Saved by) PitoFacebookFixer/))throw Error('Extension provenance tooltip missing');
      if(await fb.locator('[data-pff-host]').count())throw Error('An extra restoration card was inserted');
      if(await bubble.textContent()!==current.text)throw Error('Native bubble text does not match archive');
      const result={cycle:current.cycle,captureCommitted:true,unsendLookupPassed:true,nativeBubbleRenderingPassed:true,tooltipProvenancePassed:true,stats:(await rpc({type:'status'})).stats};
      const existing=report.cycles.findIndex(row=>row.cycle===current.cycle);
      if(existing===-1)report.cycles.push(result);else report.reloadVerification=result;
      await writeFile(path.join(reportDir,'report.json'),JSON.stringify({...report,vaultPassword:undefined},null,2));return result;
    }
    case 'cycle':{
      await execute({op:'send'});
      await execute({op:'unsend'});
      const dialog=fb.getByRole('dialog');
      await dialog.getByText('Unsend for everyone',{exact:true}).click();
      await dialog.getByRole('button').filter({hasText:/^Remove$/}).click();
      return execute({op:'verify'});
    }
    case 'reload':{
      await fb.reload({waitUntil:'domcontentloaded'});
      await fb.locator('[contenteditable="true"][role="textbox"]').waitFor({state:'visible',timeout:20000});
      return {reloaded:true};
    }
    case 'proof':{
      const stats=(await rpc({type:'status'})).stats;
      await ui.goto(`chrome-extension://${extensionId}/options.html#overview`);await ui.waitForFunction(()=>document.getElementById('messageCount')?.textContent!=='—');
      const screenshot=path.join(reportDir,'storage-proof.png');await ui.screenshot({path:screenshot,fullPage:true,mask:[ui.locator('#archiveRows')]});
      const fbScreenshot=path.join(reportDir,'restored-message-proof.png');await fb.screenshot({path:fbScreenshot});
      return {screenshot,fbScreenshot,stats};
    }
    case 'close':await context.close();return {closed:true};
    default:throw Error('Unknown QA command');
  }
}
const key=crypto.randomUUID();let chain=Promise.resolve();
const server=createServer(async(req,res)=>{
  if(req.method!=='POST'||req.headers['x-pff-qa-key']!==key){res.writeHead(403);return res.end();}
  let body='';for await(const chunk of req){body+=chunk;if(body.length>16384){res.writeHead(413);return res.end();}}
  let command;try{command=JSON.parse(body);}catch{res.writeHead(400);return res.end();}
  const operation=chain.then(()=>execute(command));chain=operation.catch(()=>{});
  try{const result=await operation;res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,result}));}
  catch(error){res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:false,error:error.message}));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
await writeFile(path.join(reportDir,'control.json'),JSON.stringify({port:server.address().port,key}));
console.log('Isolated live QA controller ready; personal browser is never attached.');
context.on('close',()=>server.close());
