import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Synthetic Facebook only. The fixture reproduces what was measured on a test
// account (TODO 2.1): the bridge module is defined late, its exports object is
// replaced and then given handleEvents, text is "vaulted", Messenger's handler
// deletes the in-memory row as soon as it runs, and the DOM row comes later.
const root=path.resolve('test-results/bridge-browser'),profile=path.join(root,'profiles',crypto.randomUUID());await mkdir(profile,{recursive:true});
const fixture=`<!doctype html><meta charset="utf-8"><style>body{font:15px system-ui}[data-message-id]{margin:6px;padding:6px 10px;border:1px solid #ccd;border-radius:16px;display:inline-block}</style>
<div role="log" id="log" data-thread-id="20002"></div>
<script>
(()=>{
  const encode=text=>'V##'+btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  const decode=value=>new TextDecoder().decode(Uint8Array.from(atob(value.slice(3)),c=>c.charCodeAt(0)));
  const modulesMap={},rows=[],calls=[];
  const modules={
    __debug:{modulesMap},
    CurrentUser:{getID:()=>'10001'},
    MAWVault:{isVaulted:v=>typeof v==='string'&&v.startsWith('V##'),unvaultOrThrow:v=>{if(v.includes('BROKEN'))throw Error('vault');return decode(v);}},
    I64:{to_string:v=>String(v[0]*4294967296+v[1])},
    LSDatabaseSingleton:{LSDatabaseSingleton:Promise.resolve({tables:{messages:rows}})},
    ReQL:{fromTableAscending:t=>({filter:f=>({rows:t.filter(f)})}),firstAsync:q=>{const hit=q.rows[0];return new Promise(r=>setTimeout(()=>r(hit),5));}},
  };
  window.require=name=>{if(!(name in modules)&&!(name in modulesMap))throw Error('Requiring unknown module "'+name+'"');return modules[name]||modulesMap[name].exports;};
  window.__d=function(){};
  const i64=n=>[Math.floor(n/4294967296),n%4294967296];
  window.fb={rows,calls,encode,i64,
    define(){
      const record={exports:{},factoryFinished:false};modulesMap.MAWBridgeUIEventHandler=record;
      // Like Messenger's module system: a fresh exports object, then the factory fills it.
      record.exports={};
      record.exports.handleEvents=function(ready,events){
        calls.push({self:this===record.exports,events,count:events.length});
        for(const e of events)if(e.tag==='DeleteMessages')for(const m of e.value.messages){const i=rows.findIndex(r=>r.messageId===m.msgId);if(i>=0)rows.splice(i,1);}
        return 'fb-result';
      };
      record.factoryFinished=true;
    },
    dispatch(events){return modulesMap.MAWBridgeUIEventHandler.exports.handleEvents(Promise.resolve(),events);},
    render(id,html,label='At 01:00, Pito'){const row=document.createElement('div');row.setAttribute('data-message-id',id);row.setAttribute('aria-label',label);row.innerHTML=html;document.getElementById('log').append(row);return row;},
    replace(oldId,newId,html){const old=document.querySelector('[data-message-id="'+oldId+'"]');const row=document.createElement('div');row.setAttribute('data-message-id',newId);row.setAttribute('aria-label','At 01:00, Pito');row.innerHTML=html;if(old)old.replaceWith(row);else document.getElementById('log').append(row);},
  };
  setTimeout(()=>{window.fb.define();
    // A message delivered the moment the module exists, before the page may have settings.
    window.fb.dispatch([{tag:'NewMsg',value:{msgId:'20002@msgr.7600000000000000001',chatJid:'20002@msgr',type_:'Text',content:encode('PFF early message'),sender:'20002',ts:1794400000,isAuthorMe:false}}]);
  },150);
})();
</script>`;
const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.PFF_TEST_BROWSER||path.resolve('test-results/browser/chrome-win/chrome.exe'),headless:true,
  ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${path.resolve('dist')}`,`--load-extension=${path.resolve('dist')}`]});
context.setDefaultTimeout(10000);
const errors=[];context.on('weberror',e=>errors.push(e.error().message));
await context.route(/^https?:\/\//,route=>route.request().url().startsWith('https://www.facebook.com/')?route.fulfill({contentType:'text/html',body:fixture}):route.abort());
await context.addCookies([{name:'c_user',value:'10001',domain:'.facebook.com',path:'/',secure:true,sameSite:'Lax'}]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,message,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await sleep(100);}throw Error(message);}
const report={synthetic:true,primaryFacebookUsed:false};
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),ui=await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);
  const rpc=m=>ui.evaluate(async m=>{const r=await chrome.runtime.sendMessage(m);if(!r?.ok)throw Error(r?.error);return r;},m);
  const records=async()=>(await rpc({type:'list',state:'all'})).rows;
  const record=async id=>(await records()).find(r=>r.id===id);
  assert.equal((await rpc({type:'status'})).settings.bridgeCapture,true,'The data source is on by default');
  const page=await context.newPage();await page.goto('https://www.facebook.com/messages/e2ee/t/20002/');
  await until(async()=>!!await record('msgr.7600000000000000001'),'A message delivered as the module appeared was not saved');
  report.earlyMessageKept=true;

  // 1. Captured before render, with sender and send time; the row never appears.
  const result=await page.evaluate(()=>{const events=[{tag:'VerifyThreadExists',value:{jid:'20002@msgr'}},{tag:'NewMsg',value:{msgId:'20002@msgr.7600000000000000002',chatJid:'20002@msgr',type_:'Text',content:fb.encode('PFF tin chưa hiển thị 😀'),sender:'20002',ts:1794400100,isAuthorMe:false}}];
    const out=fb.dispatch(events);return {out,same:fb.calls.at(-1).events===events,self:fb.calls.at(-1).self,count:fb.calls.at(-1).count};});
  assert.deepEqual(result,{out:'fb-result',same:true,self:true,count:2},'Facebook must receive the same arguments, this and return value');
  await until(async()=>(await record('msgr.7600000000000000002'))?.text==='PFF tin chưa hiển thị 😀','A message that was never rendered was not saved');
  const saved=await record('msgr.7600000000000000002');
  assert.equal(saved.senderId,'20002');assert.equal(saved.sentAt,1794400100000);assert.equal(saved.thread,'by-message-id');
  assert.equal(await page.locator('[data-message-id]').count(),0,'Saved before any row existed');
  report.capturedBeforeRender=true;report.senderAndTime=true;

  // 2. Recall: original ID deleted, a Revoked message with a new ID in the same batch;
  // the tombstone row appears afterwards and shows the saved text.
  await page.evaluate(()=>fb.dispatch([{tag:'DeleteMessages',value:{threadJid:'20002@msgr',messages:[{msgId:'20002@msgr.7600000000000000002',ts:1794400200}]}},
    {tag:'NewMsg',value:{msgId:'20002@msgr.7600000000000000102',chatJid:'20002@msgr',type_:'Revoked',sender:'20002',ts:1794400100,isAuthorMe:false}}]));
  await until(async()=>!!(await record('msgr.7600000000000000002'))?.removedAt,'Recall from the data source was not recorded');
  await page.evaluate(()=>fb.render('20002@msgr.7600000000000000102','<span dir="auto">Pito unsent a message</span>'));
  await until(async()=>(await page.locator('[data-message-id="20002@msgr.7600000000000000102"]').innerText()).includes('PFF tin chưa hiển thị'),'Tombstone with the new ID did not show the saved text');
  report.recallMappedToTombstone=true;

  // 3. A tombstone already on screen before the recall is committed is read again.
  await page.evaluate(()=>{fb.dispatch([{tag:'NewMsg',value:{msgId:'20002@msgr.7600000000000000003',chatJid:'20002@msgr',type_:'Text',content:fb.encode('PFF tin thứ ba'),sender:'20002',ts:1794400300}}]);});
  await until(async()=>!!await record('msgr.7600000000000000003'),'third message');
  await page.evaluate(()=>{fb.render('20002@msgr.7600000000000000103','<span dir="auto">Pito unsent a message</span>');});
  await sleep(600);
  await page.evaluate(()=>fb.dispatch([{tag:'DeleteMessages',value:{threadJid:'20002@msgr',messages:[{msgId:'20002@msgr.7600000000000000003',ts:1794400400}]}},
    {tag:'NewMsg',value:{msgId:'20002@msgr.7600000000000000103',chatJid:'20002@msgr',type_:'Revoked',sender:'20002',ts:1794400300}}]));
  await until(async()=>(await page.locator('[data-message-id="20002@msgr.7600000000000000103"]').innerText()).includes('PFF tin thứ ba'),'A tombstone rendered first was not restored once the recall committed');
  report.earlyTombstoneRechecked=true;

  // 4. Rescue: a message loaded from history (never a NewMsg) is read from
  // Messenger's in-memory store just before its handler deletes it.
  await page.evaluate(()=>{fb.rows.push({messageId:'20002@msgr.7600000000000000004',text:fb.encode('PFF tin lịch sử'),senderId:fb.i64(20002),timestampMs:fb.i64(1794399000000),isUnsent:false});
    fb.dispatch([{tag:'DeleteMessages',value:{threadJid:'20002@msgr',messages:[{msgId:'20002@msgr.7600000000000000004',ts:1794400500}]}},{tag:'NewMsg',value:{msgId:'20002@msgr.7600000000000000104',chatJid:'20002@msgr',type_:'Revoked',sender:'20002',ts:1794399000}}]);});
  assert.equal(await page.evaluate(()=>fb.rows.length),0,'Facebook deleted its row in its own handler');
  await until(async()=>{const r=await record('msgr.7600000000000000004');return r?.text==='PFF tin lịch sử'&&!!r.removedAt&&r.senderId==='20002'&&r.sentAt===1794399000000;},'History message was not rescued and recalled');
  report.rescuedBeforeDelete=true;

  // 5. Edit, delete-for-me, duplicates, a broken vault value, and the switch.
  await page.evaluate(()=>{const v={msgId:'20002@msgr.7600000000000000005',chatJid:'20002@msgr',type_:'Text',content:fb.encode('PFF bản đầu'),sender:'20002',ts:1794400600};
    fb.dispatch([{tag:'NewMsg',value:v},{tag:'NewMsg',value:v}]);});
  await until(async()=>!!await record('msgr.7600000000000000005'),'edit base');
  await page.evaluate(()=>fb.dispatch([{tag:'MsgUpdated',value:{msgId:'20002@msgr.7600000000000000005',chatJid:'20002@msgr',type_:'Text',content:'PFF bản sửa',sender:'20002',ts:1794400600,editCount:1}}]));
  await until(async()=>{const r=await record('msgr.7600000000000000005');return r?.text==='PFF bản sửa'&&r.history.some(h=>h.text==='PFF bản đầu');},'Edit was not saved with history');
  await page.evaluate(()=>fb.dispatch([{tag:'DeleteMessages',value:{threadJid:'20002@msgr',messages:[{msgId:'20002@msgr.7600000000000000005',ts:1794400700}]}}]));
  const broken=await page.evaluate(()=>fb.dispatch([{tag:'NewMsg',value:{msgId:'20002@msgr.7600000000000000006',chatJid:'20002@msgr',type_:'Text',content:'V##BROKEN',sender:'20002',ts:1794400800}}]));
  assert.equal(broken,'fb-result','A value that cannot be read must not affect Facebook');
  await sleep(800);
  assert.ok(!(await record('msgr.7600000000000000005')).removedAt,'Delete for me (no Revoked message) is not a recall');
  assert.equal((await records()).filter(r=>r.id==='msgr.7600000000000000005').length,1,'Duplicate events make one record');
  assert.equal(await record('msgr.7600000000000000006'),undefined);
  report.editHistory=true;report.deleteForMeIgnored=true;report.duplicatesIdempotent=true;report.unreadableValueIgnored=true;

  await rpc({type:'save',settings:{...(await rpc({type:'status'})).settings,bridgeCapture:false}});
  await sleep(500);
  await page.evaluate(()=>fb.dispatch([{tag:'NewMsg',value:{msgId:'20002@msgr.7600000000000000007',chatJid:'20002@msgr',type_:'Text',content:fb.encode('PFF khi tắt'),sender:'20002',ts:1794400900}}]));
  await sleep(1000);
  assert.equal(await record('msgr.7600000000000000007'),undefined,'Switched off, the data source saves nothing');
  report.switchOff=true;
  const tab=await ui.evaluate(async()=>{const [t]=await chrome.tabs.query({url:'https://www.facebook.com/*'});return chrome.tabs.sendMessage(t.id,{type:'tabStatus'});});
  assert.equal(tab.counters.bridgeActive,1);assert.ok(tab.counters.bridgeMessages>=5);assert.equal(tab.counters.bridgeRescued,1);assert.ok(tab.counters.bridgeRecalls>=3);
  report.counters=tab.counters;
  assert.deepEqual(errors,[]);
  report.passed=true;await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));
  console.log('PASS data source: before render, unrendered chats, sender/time, recall→tombstone, rescue before delete, edit history, delete-for-me ignored, duplicates, switch, Facebook contract');
}finally{await context.close();await rm(path.join(root,'profiles'),{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});}
