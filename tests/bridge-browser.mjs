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
  // Store procedures for chats that are not end-to-end encrypted: positional
  // arguments with the context last, fields named in the source as on Messenger.
  window.fb.storeCalls=[];
  window.fb.defineStore=()=>{
    const make=tag=>function e(){var e=arguments,t=e[e.length-1];window.fb.storeCalls.push({tag,self:this,argc:e.length,ctx:t});
      const row={threadKey:e[3],timestampMs:e[5],messageId:e[8],senderId:e[10],text:e[0],isUnsent:e[17],replyMessageText:e[28]};
      const i=rows.findIndex(r=>r.messageId===row.messageId);if(i>=0)rows.splice(i,1);rows.push(row);return 'store-'+tag;};
    for(const name of ['LSInsertMessage','LSUpsertMessage','LSDeleteThenInsertMessage']){const fn=make(name),record={exports:{},defaultExport:null,factoryFinished:false};modulesMap[name]=record;record.exports=fn;record.defaultExport=fn;record.factoryFinished=true;}
    // A procedure whose source cannot be read the expected way must be left alone.
    const odd=function(){return 'odd-result';};modulesMap.LSUpsertMessage.exports=odd;modulesMap.LSUpsertMessage.defaultExport=odd;
  };
  window.fb.store=(name,fields)=>{const args=Array(60).fill(null);args[0]=fields.text??null;args[3]=i64(30003);args[5]=i64(fields.ts);args[8]=fields.id;args[10]=i64(fields.sender);args[17]=!!fields.unsent;args[28]=fields.reply??null;
    const ctx={ctx:true};args.push(ctx);const self={caller:true};const out=modulesMap[name].exports.apply(self,args);const call=window.fb.storeCalls.at(-1);
    return {out,self:call?.self===self,ctx:call?.ctx===ctx,argc:call?.argc};};
  setTimeout(()=>{window.fb.defineStore();window.fb.define();
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

  // 6. Two recalls in one batch are paired through the send time, not by order.
  await page.evaluate(()=>{const m=(n,text,ts)=>({tag:'NewMsg',value:{msgId:'20002@msgr.76000000000000000'+n,chatJid:'20002@msgr',type_:'Text',content:fb.encode(text),sender:'20002',ts,sortOrderMs:ts*1000+7}});
    fb.dispatch([m(21,'PFF cặp A',1794401000),m(22,'PFF cặp B',1794401001)]);});
  await until(async()=>!!await record('msgr.7600000000000000022'),'pair base');
  await page.evaluate(()=>{const r=(n,ts)=>({tag:'NewMsg',value:{msgId:'20002@msgr.76000000000000001'+n,chatJid:'20002@msgr',type_:'Revoked',sender:'20002',ts,sortOrderMs:ts*1000+7}});
    fb.dispatch([{tag:'DeleteMessages',value:{threadJid:'20002@msgr',messages:[{msgId:'20002@msgr.7600000000000000021',ts:1794401100},{msgId:'20002@msgr.7600000000000000022',ts:1794401100}]}},r(22,1794401001),r(21,1794401000)]);

    fb.render('20002@msgr.7600000000000000121','<span dir="auto">Pito unsent a message</span>');fb.render('20002@msgr.7600000000000000122','<span dir="auto">Pito unsent a message</span>');});
  await until(async()=>(await page.locator('[data-message-id="20002@msgr.7600000000000000121"]').innerText()).includes('PFF cặp A')&&(await page.locator('[data-message-id="20002@msgr.7600000000000000122"]').innerText()).includes('PFF cặp B'),'Two recalls in one batch were not paired with their own tombstones');
  report.multiRecallPaired=true;

  // 7. A second wrapper around ours (another tool) delivers the same batch twice: counted once.
  const bridgeCount=async()=>(await ui.evaluate(async()=>{const [t]=await chrome.tabs.query({url:'https://www.facebook.com/*'});return chrome.tabs.sendMessage(t.id,{type:'tabStatus'});})).counters.bridgeMessages;
  await sleep(1500);const before=await bridgeCount();
  await page.evaluate(()=>{const ex=window.require('__debug').modulesMap.MAWBridgeUIEventHandler.exports,inner=ex.handleEvents;ex.handleEvents=function(r,e){return inner.call(this,r,e);};
    fb.dispatch([{tag:'NewMsg',value:{msgId:'20002@msgr.7600000000000000031',chatJid:'20002@msgr',type_:'Text',content:fb.encode('PFF bọc hai lần'),sender:'20002',ts:1794401200}}]);});
  await until(async()=>!!await record('msgr.7600000000000000031'),'rewrapped message');
  await until(async()=>await bridgeCount()>before,'counter did not advance');await sleep(1500);
  assert.equal(await bridgeCount()-before,1,'A batch that passes through two wrappers is observed once');
  report.rewrapCountedOnce=true;

  // 8. A photo row read from the page gains the sender and send time the data source saw.
  await page.evaluate(()=>{fb.dispatch([{tag:'NewMsg',value:{msgId:'20002@msgr.7600000000000000041',chatJid:'20002@msgr',type_:'Image',sender:'20002',ts:1794401300}}]);
    fb.render('20002@msgr.7600000000000000041','<span dir="auto">PFF chú thích ảnh</span>');});
  await until(async()=>{const r=await record('msgr.7600000000000000041');return r?.senderId==='20002'&&r.sentAt===1794401300000;},'A row from the page did not gain sender and send time');
  report.pageRowEnriched=true;

  // 9. A group (not end-to-end encrypted) message: saved from the store procedure
  // before any row exists; Messenger's call is untouched.
  const stored=await page.evaluate(()=>fb.store('LSInsertMessage',{id:'mid.$gAAAAAnhom0001',text:'PFF tin nhóm',ts:1794402000000,sender:20003,reply:'PFF câu được trả lời'}));
  assert.deepEqual(stored,{out:'store-LSInsertMessage',self:true,ctx:true,argc:61},'A store procedure must receive the same arguments, this and return value');
  await until(async()=>{const r=await record('mid.$gAAAAAnhom0001');return r?.text==='PFF tin nhóm'&&r.senderId==='20003'&&r.sentAt===1794402000000&&r.replyText==='PFF câu được trả lời';},'A group message was not saved from the store procedure');
  assert.equal(await page.locator('[data-message-id="mid.$gAAAAAnhom0001"]').count(),0);
  // Recall keeps the ID and sets isUnsent; the same row then shows the saved text.
  await page.evaluate(()=>{fb.store('LSDeleteThenInsertMessage',{id:'mid.$gAAAAAnhom0001',text:null,ts:1794402000000,sender:20003,unsent:true});fb.render('mid.$gAAAAAnhom0001','<span dir="auto">Pito unsent a message</span>');});
  await until(async()=>!!(await record('mid.$gAAAAAnhom0001'))?.removedAt,'A group recall was not recorded');
  await until(async()=>(await page.locator('[data-message-id="mid.$gAAAAAnhom0001"]').innerText()).includes('PFF tin nhóm'),'A recalled group message was not shown in its row');
  // A message only present in Messenger's store (loaded earlier) is rescued at recall.
  await page.evaluate(()=>{fb.rows.push({messageId:'mid.$gAAAAAnhom0002',text:'PFF nhóm lịch sử',senderId:fb.i64(20003),timestampMs:fb.i64(1794401900000),isUnsent:false});
    fb.store('LSDeleteThenInsertMessage',{id:'mid.$gAAAAAnhom0002',text:null,ts:1794401900000,sender:20003,unsent:true});});
  await until(async()=>{const r=await record('mid.$gAAAAAnhom0002');return r?.text==='PFF nhóm lịch sử'&&!!r.removedAt&&r.senderId==='20003';},'A group message known only to the store was not rescued');
  // An unreadable procedure and an ID of another kind are passed through untouched.
  assert.equal(await page.evaluate(()=>window.require('__debug').modulesMap.LSUpsertMessage.exports('x','y')),'odd-result');
  assert.equal((await page.evaluate(()=>fb.store('LSInsertMessage',{id:'not-a-message-id',text:'PFF sai ID',ts:1794402100000,sender:20003}))).out,'store-LSInsertMessage');
  await sleep(500);assert.equal((await records()).some(r=>r.text==='PFF sai ID'),false);
  report.groupCapturedBeforeRender=true;report.groupRecallSameRow=true;report.groupRescued=true;report.unreadableProcedureLeftAlone=true;

  await rpc({type:'save',settings:{...(await rpc({type:'status'})).settings,bridgeCapture:false}});
  await sleep(500);
  await page.evaluate(()=>fb.dispatch([{tag:'NewMsg',value:{msgId:'20002@msgr.7600000000000000007',chatJid:'20002@msgr',type_:'Text',content:fb.encode('PFF khi tắt'),sender:'20002',ts:1794400900}}]));
  await sleep(1000);
  assert.equal(await record('msgr.7600000000000000007'),undefined,'Switched off, the data source saves nothing');
  report.switchOff=true;
  const tab=await ui.evaluate(async()=>{const [t]=await chrome.tabs.query({url:'https://www.facebook.com/*'});return chrome.tabs.sendMessage(t.id,{type:'tabStatus'});});
  assert.equal(tab.counters.bridgeActive,1);assert.equal(tab.counters.storeActive,1);assert.ok(tab.counters.storeUnreadable>=1);assert.equal(tab.counters.bridgeErrors,0);assert.ok(tab.counters.bridgeMessages>=5);assert.equal(tab.counters.bridgeRescued,2);assert.ok(tab.counters.bridgeRecalls>=3);
  report.counters=tab.counters;
  assert.deepEqual(errors,[]);
  report.passed=true;await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));
  console.log('PASS data source: before render, unrendered chats, sender/time, recall→tombstone, multi-recall pairing, group chats (store procedures), rescue before delete, edit history, delete-for-me ignored, duplicates, switch, Facebook contract');
}finally{await context.close();await rm(path.join(root,'profiles'),{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});}
