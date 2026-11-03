import assert from "node:assert/strict";
import {chromium} from "playwright";
import {mkdir, rm, writeFile} from "node:fs/promises";
import path from "node:path";

const root=path.resolve('test-results/bulk-profiles'), profile=path.join(root,crypto.randomUUID());
await mkdir(profile,{recursive:true});
const extension=path.resolve(process.env.PFF_TEST_EXTENSION||'dist');
const context=await chromium.launchPersistentContext(profile,{
  executablePath:process.env.PFF_TEST_BROWSER||path.resolve('test-results/browser/chrome-win/chrome.exe'),headless:true,
  ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
});
const count=Number(process.env.PFF_BULK_COUNT||384), selected=count/2, base=7524000000000000000n, control=7525000000000000000n;
const payload=i=>i%4===0?'Nội dung trùng nhau':`Tin hàng loạt ${i} — có dấu`;
let removed=false;
const markup=()=>`<!doctype html><html><meta charset="utf-8"><body><div role="log">${Array.from({length:count},(_,i)=>{
  const deleted=removed&&i%2===0;
  return `<div role="article"><div data-message-id="10001@msgr.${(deleted?control:base)+BigInt(i)}" aria-label="At 01:12, You${deleted?'':': '+payload(i)}"><h4 dir="auto">You sent</h4><span dir="auto">${deleted?'You deleted a message':payload(i)}</span><span dir="auto">Sent</span></div></div>`;
}).join('')}</div></body></html>`;
await context.route(/^https?:\/\//,route=>route.fulfill({contentType:'text/html',body:markup()}));
await context.addCookies([{name:'c_user',value:'10001',domain:'.facebook.com',path:'/',secure:true,sameSite:'Lax'}]);
async function until(check,message){for(let n=0;n<Number(process.env.PFF_TEST_TIMEOUT_MS||24000)/100;n++){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw Error(message);}
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const ui=await context.newPage();await ui.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);
  const rpc=message=>ui.evaluate(async message=>{const r=await chrome.runtime.sendMessage(message);if(!r.ok)throw Error(r.error);return r;},message);
  // Deliberately slow the commit response to exercise bridge backpressure.
  await worker.evaluate(()=>{
    const original=chrome.runtime.sendMessage;
    chrome.runtime.sendMessage=async function(...args){
      if(args[0]?.type==='archiveStats')await new Promise(r=>setTimeout(r,150));
      return Reflect.apply(original,this,args);
    };
  });
  const page=await context.newPage();await page.goto('https://www.facebook.com/bulk-fixture');
  await until(async()=>(await rpc({type:'status'})).stats.count===count,'Burst capture dropped messages');
  console.log(`PASS all ${count} initial messages committed with slow background responses`);

  await page.evaluate(({control})=>{
    const articles=[...document.querySelectorAll('[role="article"]')];
    for(let i=0;i<articles.length;i+=2){
      const next=document.createElement('div');next.setAttribute('role','article');
      next.innerHTML=`<div data-message-id="10001@msgr.${BigInt(control)+BigInt(i)}" aria-label="At 01:12, You"><h4 dir="auto">You sent</h4><span dir="auto">You deleted a message</span><span dir="auto">Sent</span></div>`;
      articles[i].replaceWith(next);
    }
  },{control:String(control)});
  await until(async()=>await page.locator('[data-pff-restored]').count()===selected,'Atomic batch replacements did not all restore');
  const expected=Array.from({length:count},(_,i)=>payload(i));
  assert.deepEqual(await page.locator('[role="article"]').evaluateAll(nodes=>nodes.map(n=>n.querySelector('[data-message-id] > span').textContent)),expected);
  assert.equal((await rpc({type:'status'})).stats.count,count);
  assert.equal((await rpc({type:'status'})).stats.removed,selected);
  console.log(`PASS ${selected} selected rows restored in one DOM commit, including duplicate text and timestamps; unselected rows unchanged`);

  await page.locator('[data-pff-restored]').evaluateAll(nodes=>nodes.forEach(node=>node.textContent='You deleted a message'));
  await until(async()=>await page.locator('[data-pff-restored]').evaluateAll(nodes=>nodes.every(n=>n.textContent!=='You deleted a message')),'Redraw overflow left tombstones unrepaired');
  console.log('PASS all restored bubbles repaired after simultaneous Facebook text rewrites');

  const delayId=`10001@msgr.${base+1n}`;
  await page.evaluate(id=>document.querySelector(`[data-message-id="${id}"]`).setAttribute('data-is-unsent','true'),delayId);
  await until(async()=>(await rpc({type:'status'})).stats.removed===selected+1,'Delayed tombstone was not acknowledged by archive');
  await page.evaluate(id=>{
    const row=document.querySelector(`[data-message-id="${id}"]`);
    row.querySelector('[dir="auto"]:not(h4)').textContent='You deleted a message';
  },delayId);
  await until(async()=>await page.locator(`[data-message-id="${delayId}"] [data-pff-restored]`).count()===1,'Archive response before tombstone mount was lost');
  assert.equal(await page.locator(`[data-message-id="${delayId}"] [data-pff-restored]`).textContent(),payload(1));
  console.log('PASS archive result arriving before tombstone text is retained and applied when ready');

  removed=true;await page.reload();
  await until(async()=>await page.locator('[data-pff-restored]').count()===selected,'Bulk aliases did not restore after reload');
  assert.deepEqual(await page.locator('[role="article"]').evaluateAll(nodes=>nodes.map(n=>n.querySelector('[data-message-id] > span').textContent)),expected);
  const tab=await ui.evaluate(async()=>{const tabs=await chrome.tabs.query({url:'https://www.facebook.com/*'});return tabs[0].id;});
  const status=await ui.evaluate(id=>chrome.tabs.sendMessage(id,{type:'tabStatus'}),tab);
  assert.equal(status.counters.queueDropped,0);assert.equal(status.dropped,0);
  console.log('PASS all bulk aliases survive reload; no bridge queue drops');

  await page.evaluate(()=>{
    const group=document.createElement('div');group.id='ambiguous-bulk';
    group.innerHTML=['7610000000000000001','7610000000000000002'].map((id,i)=>`<div role="article"><div data-message-id="${id}" aria-label="At 03:00, You: Separate payload ${i}"><span dir="auto">Separate payload ${i}</span></div></div>`).join('');
    document.querySelector('[role="log"]').append(group);
  });
  await until(async()=>(await rpc({type:'status'})).stats.count===count+2,'Ambiguous-group seed did not commit');
  await page.evaluate(()=>{
    const group=document.getElementById('ambiguous-bulk');
    const next=['7620000000000000001','7620000000000000002'].map(id=>{
      const article=document.createElement('div');article.setAttribute('role','article');
      article.innerHTML=`<div data-message-id="${id}" aria-label="At 03:00, You"><span dir="auto">You deleted a message</span></div>`;return article;
    });
    group.replaceChildren(...next);
  });
  await new Promise(r=>setTimeout(r,1000));
  assert.equal(await page.locator('#ambiguous-bulk [data-pff-restored]').count(),0);
  assert.equal((await rpc({type:'status'})).stats.removed,selected+1);
  console.log('PASS ambiguous whole-group replacement does not guess aliases from duplicate timestamps or position');

  // Model notifications arriving from another device. There is no local
  // click/selection/unsend event: only several staggered server-driven DOM
  // updates, with the removal state arriving before the final bubble text.
  const remoteCount=16, remoteSelected=remoteCount/2;
  await page.evaluate(()=>{
    window.remoteFixtureClicks=0;document.addEventListener('click',()=>window.remoteFixtureClicks++);
    const group=document.createElement('div');group.id='remote-bulk';
    group.innerHTML=Array.from({length:16},(_,i)=>`<div role="article"><div data-message-id="${7730000000000000000n+BigInt(i)}" aria-label="At 04:00, You: Tin từ thiết bị khác ${i}"><span dir="auto">Tin từ thiết bị khác ${i}</span></div></div>`).join('');
    document.querySelector('[role="log"]').append(group);
  });
  await until(async()=>(await rpc({type:'status'})).stats.count===count+2+remoteCount,'Remote-notification seed did not commit');
  for(let wave=0;wave<2;wave++){
    await page.evaluate(wave=>{
      const articles=[...document.querySelectorAll('#remote-bulk [role="article"]')];
      for(let i=wave*8;i<(wave+1)*8;i+=2){
        const next=document.createElement('div');next.setAttribute('role','article');
        next.innerHTML=`<div data-message-id="${7740000000000000000n+BigInt(i)}" aria-label="At 04:00, You" data-is-unsent="true"><span dir="auto"></span></div>`;
        articles[i].replaceWith(next);
      }
    },wave);
    await new Promise(r=>setTimeout(r,220));
  }
  await until(async()=>(await rpc({type:'status'})).stats.removed===selected+1+remoteSelected,'Staggered remote removals were lost');
  const pendingStatus=await ui.evaluate(id=>chrome.tabs.sendMessage(id,{type:'tabStatus'}),tab);
  assert.equal(pendingStatus.visible.waitingForDom,remoteSelected);
  assert.ok(pendingStatus.visible.unmatched>=2);
  for(let wave=0;wave<4;wave++){
    await page.evaluate(wave=>{
      const rows=[...document.querySelectorAll('#remote-bulk [data-is-unsent]')];
      for(const row of rows.slice(wave*2,wave*2+2))row.querySelector('[dir="auto"]').textContent='You deleted a message';
    },wave);
    await new Promise(r=>setTimeout(r,80));
  }
  await until(async()=>await page.locator('#remote-bulk [data-pff-restored]').count()===remoteSelected,'Remote removal updates did not all render');
  assert.deepEqual(await page.locator('#remote-bulk [role="article"]').evaluateAll(nodes=>nodes.map(n=>n.querySelector('span').textContent)),Array.from({length:remoteCount},(_,i)=>`Tin từ thiết bị khác ${i}`));
  assert.equal(await page.evaluate(()=>window.remoteFixtureClicks),0);
  assert.equal((await rpc({type:'status'})).stats.count,count+2+remoteCount);
  const completedStatus=await ui.evaluate(id=>chrome.tabs.sendMessage(id,{type:'tabStatus'}),tab);
  assert.equal(completedStatus.visible.waitingForDom,0);
  console.log('PASS 8 remote removals arrive in staggered waves before bubble text, with zero local clicks; all 16 selected/unselected texts remain correct');

  // Real mobile QA: React emits separate removeChild/insertBefore records,
  // rather than one replaceChild record. Coalesce several such pairs in one
  // observer delivery; unchanged sibling nodes identify each replacement slot.
  await page.evaluate(()=>{
    const group=document.createElement('div');group.id='split-record-bulk';
    group.innerHTML=Array.from({length:12},(_,i)=>`<div role="article"><div data-message-id="${7750000000000000000n+BigInt(i)}" aria-label="At 05:00, You: Split record ${i}"><span dir="auto">Split record ${i}</span></div></div>`).join('');
    document.querySelector('[role="log"]').append(group);
  });
  await until(async()=>(await rpc({type:'status'})).stats.count===count+2+remoteCount+12,'Split-record seed did not commit');
  await page.evaluate(()=>{
    const group=document.getElementById('split-record-bulk'), articles=[...group.children], slots=[];
    for(let i=0;i<articles.length;i+=2){
      slots.push({index:i,next:articles[i].nextSibling});articles[i].remove();
    }
    for(const {index,next} of slots){
      const article=document.createElement('div');article.setAttribute('role','article');
      article.innerHTML=`<div data-message-id="${7760000000000000000n+BigInt(index)}" aria-label="At 05:00, You"><span dir="auto">You deleted a message</span></div>`;
      group.insertBefore(article,next);
    }
  });
  await until(async()=>await page.locator('#split-record-bulk [data-pff-restored]').count()===6,'Separate remove/insert records lost bulk message identities');
  assert.deepEqual(await page.locator('#split-record-bulk [role="article"]').evaluateAll(nodes=>nodes.map(n=>n.querySelector('span').textContent)),Array.from({length:12},(_,i)=>`Split record ${i}`));
  console.log('PASS 6 remote removals represented by separate remove/insert records in one observer delivery');
  await writeFile('test-results/bulk-report.json',JSON.stringify({synthetic:true,primaryFacebookUsed:false,
    captured:count,removedTogether:selected,slowBackground:true,duplicatePayloads:true,duplicateTimestamps:true,
    allCorrectBeforeReload:true,allCorrectAfterReload:true,delayedTombstonePassed:true,redrawOverflowPassed:true,ambiguousGroupSkipped:true,
    staggeredRemoteRemovals:remoteSelected,remoteLocalClicks:0,remoteUpdatesPassed:true,splitMutationRecordsPassed:true,diagnosticStatesPassed:true,queueDropped:0,passed:true},null,2));
}finally{
  await context.close();
  if(path.resolve(profile).startsWith(root+path.sep))await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
