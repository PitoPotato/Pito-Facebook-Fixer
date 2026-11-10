import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Synthetic Facebook only. Guards the observer and scroll optimizations: each
// case here is something that a narrower or lazier capture could silently miss.
const root=path.resolve('test-results/adapter-browser'),profile=path.join(root,'profiles',crypto.randomUUID());await mkdir(profile,{recursive:true});
const extension=path.resolve(process.env.PFF_TEST_EXTENSION||'dist');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const row=(id,text)=>`<div role="article" style="height:60px"><div data-message-id="${id}" aria-label="At 01:00, An: ${text}"><span dir="auto" data-message-text>${text}</span></div></div>`;
const fixture=`<!doctype html><meta charset="utf-8"><body><div id="feed"><p id="feedText">feed</p></div><div id="chat" role="log" data-thread-id="20002" style="height:200px;overflow:auto">${Array.from({length:40},(_,i)=>row(`7600000000000000${String(i).padStart(3,'0')}`,`Tin ${i}`)).join('')}</div><div id="popups"></div><script>window.require=()=>({getID:()=> '10001'});</script></body>`;
const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.PFF_TEST_BROWSER||path.resolve('test-results/browser-current/chrome-win64/chrome.exe'),headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:900,height:700}});
context.setDefaultTimeout(12000);const errors=[];context.on('weberror',e=>errors.push(e.error().message));
await context.route(/^https?:\/\//,route=>{const url=route.request().url();if(url.startsWith('https://www.facebook.com/'))return route.fulfill({contentType:'text/html',body:fixture});return route.abort();});
await context.addCookies([{name:'c_user',value:'10001',domain:'.facebook.com',path:'/',secure:true,sameSite:'Lax'}]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,message,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await sleep(80);}throw Error(`Timed out: ${message}`);}
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),ui=await context.newPage();await ui.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);
  const rpc=m=>ui.evaluate(async m=>{const r=await chrome.runtime.sendMessage(m);if(!r?.ok)throw Error(r?.error);return r;},m);
  const findRow=async id=>{let cursor=null;do{const page=await rpc({type:'list',state:'all',before:cursor});const hit=page.rows.find(r=>r.id===id);if(hit)return hit;cursor=page.next;}while(cursor);return null;};
  const textOf=async id=>(await findRow(id))?.text;
  const page=await context.newPage();await page.goto('https://www.facebook.com/messages/t/20002/');
  await until(async()=>(await rpc({type:'status'})).stats.count===40,'initial rows');

  // A recall that changes the message ID is matched through the scroll epoch.
  await page.evaluate(async()=>{const chat=document.getElementById('chat');for(let i=0;i<12;i++){chat.scrollTop+=40;await new Promise(r=>setTimeout(r,16));}});
  await sleep(700);
  await page.evaluate(()=>{const old=document.querySelector('[data-message-id="7600000000000000007"]').closest('[role="article"]');const next=document.createElement('div');next.setAttribute('role','article');next.innerHTML='<div data-message-id="7610000000000000007" aria-label="At 01:00, An"><span dir="auto">You deleted a message</span></div>';old.replaceWith(next);});
  await until(async()=>await page.locator('[data-message-id="7610000000000000007"] [data-pff-restored]').count()===1,'recall with a new ID after scrolling');
  assert.equal(await page.locator('[data-message-id="7610000000000000007"] [data-pff-restored]').textContent(),'Tin 7');
  // Reusing a row element for a different message right after a scroll must not inherit content.
  await page.evaluate(async()=>{const chat=document.getElementById('chat');chat.scrollTop+=30;await new Promise(r=>setTimeout(r,20));const r=document.querySelector('[data-message-id="7600000000000000009"]');r.setAttribute('data-message-id','7620000000000000009');r.setAttribute('aria-label','At 09:00, Someone else');r.innerHTML='<span dir="auto">Someone else deleted a message</span>';});
  await sleep(700);assert.equal(await page.locator('[data-message-id="7620000000000000009"] [data-pff-restored]').count(),0,'a recycled row inherited another message');
  console.log('PASS scrolling keeps recall matching for unchanged rows and refuses recycled ones (synthetic)');

  // Text node edits, the noisy mutation type, are still seen inside chat scopes.
  await page.evaluate(()=>{document.querySelector('[data-message-id="7600000000000000002"] [data-message-text]').firstChild.data='Tin 2 đã sửa';});
  await until(async()=>(await textOf('msgr.7600000000000000002'))==='Tin 2 đã sửa','in-place text edit in a chat');
  // A popup that appears later gets its own scope, with no thread attribute.
  await page.evaluate(()=>{const log=document.createElement('div');log.setAttribute('role','log');log.innerHTML='<div role="article"><div data-message-id="mid.popup.a" aria-label="At 01:00, An: Popup"><span dir="auto" data-message-text>Popup</span></div></div>';document.getElementById('popups').append(log);});
  await until(async()=>(await textOf('mid.popup.a'))==='Popup','popup row captured');
  await sleep(300);
  await page.evaluate(()=>{document.querySelector('[data-message-id="mid.popup.a"] [data-message-text]').firstChild.data='Popup đã sửa';});
  await until(async()=>(await textOf('mid.popup.a'))==='Popup đã sửa','in-place edit inside a popup');
  // An image set after the row was first read must still be collected.
  await page.evaluate(src=>{const r=document.querySelector('[data-message-id="mid.popup.a"]');const img=document.createElement('img');img.alt='Open photo';img.width=10;r.append(img);setTimeout(()=>{img.src=src;},250);},`data:image/png;base64,${png.toString('base64')}`);
  await until(async()=>(await findRow('mid.popup.a'))?.assets?.length===1,'image appearing later');
  console.log('PASS text and image changes are seen in chats and in popups that open later (synthetic)');

  // A row that gains its identity later is picked up from the attribute alone.
  await page.evaluate(()=>{const r=document.createElement('div');r.id='late';r.setAttribute('role','row');r.innerHTML='<span dir="auto">Có mã sau</span>';document.getElementById('chat').append(r);});
  await sleep(500);
  await page.evaluate(()=>document.getElementById('late').setAttribute('data-message-id','mid.late'));
  await until(async()=>(await textOf('mid.late'))==='Có mã sau','row that receives its ID later');
  // More isolated containers than the scope limit fall back to watching everything.
  await page.evaluate(()=>{for(let i=0;i<80;i++){const wrap=document.createElement('section');wrap.innerHTML=`<div data-message-id="mid.many.${i}" aria-label="At 01:00, An: Many ${i}"><span dir="auto" data-message-text>Many ${i}</span></div>`;document.getElementById('feed').append(wrap);}});
  await until(async()=>{const n=(await rpc({type:'status'})).stats.count;return n>=40+1+1+80;},'many separate containers captured',20000);
  await sleep(400);
  await page.evaluate(()=>{document.querySelector('[data-message-id="mid.many.79"] [data-message-text]').firstChild.data='Many 79 đã sửa';});
  await until(async()=>{let cursor=null;do{const p=await rpc({type:'list',state:'all',before:cursor,query:'Many 79 đã sửa'});if(p.rows.length)return true;cursor=p.next;}while(cursor);return false;},'edit after falling back to the document-wide watcher');
  // A virtualized list can hand an unchanged node to another message, with the
  // identity only in React props. A scroll must read that row again.
  await page.evaluate(()=>{const r=document.createElement('div');r.setAttribute('role','row');r.id='virtual';r.setAttribute('aria-label','At 01:00, An: Giống hệt');r.innerHTML='<span dir="auto" data-message-text>Giống hệt</span>';r.__reactFiber$fixture={memoizedProps:{message:{messageId:'mid.virtual.a',threadKey:'20002',text:'Giống hệt'}},return:null};r.__reactProps$fixture={children:'a'};document.getElementById('chat').prepend(r);});
  await until(async()=>(await textOf('mid.virtual.a'))==='Giống hệt','first identity of a reused node');
  await page.evaluate(()=>{const v=document.getElementById('virtual');v.__reactFiber$fixture={memoizedProps:{message:{messageId:'mid.virtual.b',threadKey:'20002',text:'Giống hệt'}},return:null};v.__reactProps$fixture={children:'b'};document.getElementById('chat').dispatchEvent(new Event('scroll'));});
  await until(async()=>(await textOf('mid.virtual.b'))==='Giống hệt','second identity after the node was reused');
  console.log('PASS late identities, reused React nodes and the scope limit fallback do not lose changes (synthetic)');

  // A restored bubble keeps being repaired, and rows nobody restored are not watched.
  await page.evaluate(()=>{const b=document.querySelector('[data-message-id="7610000000000000007"] [data-pff-restored]');b.firstChild.data='You deleted a message';});
  await until(async()=>await page.locator('[data-message-id="7610000000000000007"] [data-pff-restored]').textContent()==='Tin 7','restored text repaired after a rewrite');
  assert.deepEqual(errors,[]);
  await writeFile(path.join(root,'report.json'),JSON.stringify({synthetic:true,primaryFacebookUsed:false,passed:true},null,2));
  console.log('PASS restored bubbles are repaired by the per-row observer (synthetic)');
}finally{await context.close();await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});}
