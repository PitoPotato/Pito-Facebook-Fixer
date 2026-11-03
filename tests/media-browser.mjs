import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {deflateSync} from 'node:zlib';

const root=path.resolve('test-results/media-profiles'),profile=path.join(root,crypto.randomUUID());await mkdir(profile,{recursive:true});
function crc(bytes){let c=0xffffffff;for(const b of bytes){c^=b;for(let n=0;n<8;n++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function chunk(type,data){const t=Buffer.from(type),out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);t.copy(out,4);data.copy(out,8);out.writeUInt32BE(crc(Buffer.concat([t,data])),out.length-4);return out;}
const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(160);ihdr.writeUInt32BE(96,4);ihdr[8]=8;ihdr[9]=2;
const pixels=Buffer.concat(Array.from({length:96},(_,y)=>Buffer.concat([Buffer.from([0]),Buffer.from(Array.from({length:160*3},(_,x)=>(x+y)%255))])));
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
const wav=Buffer.alloc(44+48000*2*4);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(wav.length-44,40);for(let i=0;i<48000*4;i++)wav.writeInt16LE(Math.round(3000*Math.sin(2*Math.PI*440*i/48000)),44+i*2);
const imageURL='https://pff-test.invalid.fbcdn.net/photo.png',emojiURL='https://pff-test.invalid.fbcdn.net/images/emoji.php/1f600.png';
const emojis=['😀','👨‍👩‍👧‍👦','🇻🇳','1️⃣','👍🏽'];let removed=false,assetsExpired=false,remoteRequests=0;
const oldBase=7810000000000000000n,newBase=7820000000000000000n;
const row=(i,body,label='')=>`<div role="article"><div data-message-id="${(removed?newBase:oldBase)+BigInt(i)}" aria-label="At 01:00, You${removed?'':label}">${removed?'<span dir="auto">You deleted a message</span>':body}</div></div>`;
const fixture=()=>`<!doctype html><html><meta charset="utf-8"><style>body{font:15px system-ui}#log{max-width:500px}[role=article]{margin:5px;border:1px solid #aaa;padding:6px;min-height:30px}</style><body><div role="log" id="log">${emojis.map((emoji,i)=>row(i,`<div dir="auto"><img src="${emojiURL}" width="32" height="32" alt="${emoji}"></div><span dir="auto">Sent</span>`,`: ${emoji}`)).join('')}${row(5,`<img width="160" height="96" src="${imageURL}" alt="Open photo"><span dir="auto">Sent</span>`)}${row(6,`<span dir="auto" data-message-text>Ảnh QA</span><img width="160" height="96" src="${imageURL}" alt="Open photo">`,': Ảnh QA')}${row(7,'<button aria-label="Play" id="play">Play</button><div role="slider" aria-label="Audio scrubber"></div><div role="timer">0:04</div><span dir="auto">Sent</span>')}</div><div role="log" id="ignored"><div data-message-id="mid.video"><video></video><img width="100" height="80" alt="Video thumbnail" src="${emojiURL}"><span dir="auto">Sent</span></div><div data-message-id="mid.file"><a href="#">archive.zip</a><img width="100" height="80" alt="File icon" src="${emojiURL}"></div><div data-message-id="mid.sticker"><img width="100" height="100" alt="Sticker" src="${emojiURL}"></div></div><script>window.require=()=>({getID:()=> '10001'});document.getElementById('play')?.addEventListener('click',()=>{const bytes=Uint8Array.from(atob('${wav.toString('base64')}'),c=>c.charCodeAt(0));window.fixtureVoice=new Audio(URL.createObjectURL(new Blob([bytes],{type:'audio/wav'})));window.fixtureVoice.play().catch(error=>{if(error.name!=='AbortError')throw error;});});</script></body></html>`;
const extension=path.resolve('dist');const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.PFF_TEST_BROWSER||path.resolve('test-results/browser/chrome-win/chrome.exe'),headless:true,
  ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--mute-audio'],viewport:{width:1100,height:1600}});
context.setDefaultTimeout(10000);const errors=[];context.on('weberror',e=>errors.push(e.error().message));
await context.route(/^https?:\/\//,route=>{
  const url=route.request().url();
  if(url.startsWith('https://www.facebook.com/'))return route.fulfill({contentType:'text/html',body:fixture()});
  if(url===imageURL||url===emojiURL){if(url===imageURL)remoteRequests++;return assetsExpired?route.abort():route.fulfill({contentType:'image/png',body:png});}
  return route.abort();
});
await context.addCookies([{name:'c_user',value:'10001',domain:'.facebook.com',path:'/',secure:true,sameSite:'Lax'}]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));async function until(check,message){for(let n=0;n<180;n++){if(await check())return;await sleep(100);}throw Error(message);}
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),ui=await context.newPage();await ui.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);
  // Playwright's context routes don't intercept extension worker fetches.
  // Stub only this synthetic URL at the worker's fetch boundary; the actual
  // streaming/type validation, archive and JSON/chunk transport remain real.
  await worker.evaluate(({url,data})=>{
    const original=globalThis.fetch;
    globalThis.__pffFixtureFetches=0;
    globalThis.fetch=(input,init)=>{
      if(String(input)!==url)return original(input,init);
      globalThis.__pffFixtureFetches++;
      return globalThis.__pffFixtureAssetsExpired?Promise.reject(Error('Synthetic asset URL expired')):Promise.resolve(new Response(Uint8Array.from(data),{headers:{'content-type':'image/png'}}));
    };
  },{url:imageURL,data:[...png]});
  const rpc=m=>ui.evaluate(async m=>{const r=await chrome.runtime.sendMessage(m);if(!r.ok)throw Error(r.error);return r;},m);
  await rpc({type:'save',settings:{...(await rpc({type:'status'})).settings,autoVoice:false}});
  const page=await context.newPage();await page.goto('https://www.facebook.com/messages/t/20002/');
  try{await until(async()=>(await rpc({type:'status'})).stats.count===7,'Emoji/images were not captured or unsupported rows were captured');}
  catch(error){
    const tabs=await ui.evaluate(()=>chrome.tabs.query({url:'https://www.facebook.com/*'}));
    console.log('CAPTURE DIAGNOSTICS',JSON.stringify({archive:await rpc({type:'status'}),tab:await ui.evaluate(id=>chrome.tabs.sendMessage(id,{type:'tabStatus'}),tabs[0].id)}));throw error;
  }
  await page.getByRole('button',{name:'Play',exact:true}).click();
  await until(async()=>(await rpc({type:'status'})).stats.count===8,'Off-DOM voice was not captured after play');
  assert.ok((await rpc({type:'status'})).stats.bytes>=2*png.length+wav.length);
  await page.evaluate(()=>{fixtureVoice.pause();URL.revokeObjectURL(fixtureVoice.src);});
  await page.evaluate(data=>{
    const bytes=Uint8Array.from(data);bytes[50]^=127;
    window.nextAutomaticVoice=new Audio(URL.createObjectURL(new Blob([bytes],{type:'audio/wav'})));
    nextAutomaticVoice.play();
  },[...wav]);
  await sleep(400);
  await page.evaluate(()=>{nextAutomaticVoice.pause();URL.revokeObjectURL(nextAutomaticVoice.src);});
  console.log('PASS native emoji img alt, photos/caption and real off-DOM Audio Blob capture; video/file/sticker/status are excluded');
  await page.evaluate(base=>{
    const log=document.getElementById('log');
    for(const [i,old] of [...log.children].entries()){
      const next=old.nextSibling,article=document.createElement('div');article.setAttribute('role','article');
      article.innerHTML=`<div data-message-id="${BigInt(base)+BigInt(i)}" aria-label="At 01:00, You"><span dir="auto">You deleted a message</span></div>`;
      old.remove();log.insertBefore(article,next);
    }
  },String(newBase));
  await until(async()=>await page.locator('#log [data-pff-restored]').count()===8,'Media removals did not restore');
  const checkMedia=async()=>{
    await until(async()=>await page.locator('[data-pff-media] img').evaluateAll(nodes=>nodes.length===2&&nodes.every(n=>n.complete&&n.naturalWidth===160)),'Restored photos did not decode');
    await until(async()=>await page.locator('[data-pff-media] audio').evaluateAll(nodes=>nodes.length===1&&nodes[0].readyState>=1&&nodes[0].duration>3),'Restored voice did not decode');
    const digest=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
    const hashes=await page.locator('[data-pff-media] img,[data-pff-media] audio').evaluateAll(async nodes=>Promise.all(nodes.map(async n=>{
      const bytes=await(await fetch(n.src)).arrayBuffer();return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
    })));
    assert.deepEqual(hashes,[await digest(png),await digest(png),await digest(wav)]);
    for(const emoji of emojis)assert.ok((await page.locator('#log').innerText()).includes(emoji));
  };
  await checkMedia();
  await page.locator('[data-pff-media] audio').evaluate(n=>{window.playingArchiveNode=n;return n.play();});
  await page.evaluate(()=>document.getElementById('log').dispatchEvent(new Event('scroll')));await sleep(500);await checkMedia();
  assert.ok(await page.locator('[data-pff-media] audio').evaluate(n=>n===window.playingArchiveNode&&!n.paused&&n.currentTime>0));
  await rpc({type:'save',settings:{language:'vi'}});
  await until(async()=>page.locator('[data-pff-media] audio').getAttribute('aria-label').then(value=>value.includes('Tin nhắn thoại')),'Media labels did not switch to Vietnamese');
  assert.ok(await page.locator('[data-pff-media] audio').evaluate(n=>n===window.playingArchiveNode&&!n.paused),'Changing language interrupted archived voice playback');
  await rpc({type:'save',settings:{language:'en'}});
  await until(async()=>page.locator('[data-pff-media] audio').getAttribute('aria-label').then(value=>value.includes('Recalled voice')),'Media labels did not switch to English');
  assert.ok(await page.locator('[data-pff-media] audio').evaluate(n=>n===window.playingArchiveNode&&!n.paused));
  await page.locator('[data-pff-media] audio').evaluate(n=>n.pause());
  console.log('PASS image/voice byte integrity and decoding, including alias rebind after a scroll rescan');
  removed=true;assetsExpired=true;const requestsBefore=remoteRequests;
  const workerFetches=await worker.evaluate(()=>{globalThis.__pffFixtureAssetsExpired=true;return globalThis.__pffFixtureFetches;});
  await page.reload();
  await until(async()=>await page.locator('#log [data-pff-restored]').count()===8,'Media aliases did not survive reload');await checkMedia();
  assert.equal(remoteRequests,requestsBefore);
  assert.equal(await worker.evaluate(()=>globalThis.__pffFixtureFetches),workerFetches);
  console.log('PASS local images/voice survive reload with all original media URLs expired');
  await page.screenshot({path:'test-results/media-fixture-proof.png',fullPage:true});
  const urls=await page.locator('[data-pff-media] img,[data-pff-media] audio').evaluateAll(nodes=>nodes.map(n=>n.src));
  const config=(await rpc({type:'status'})).settings;await rpc({type:'save',settings:{...config,archive:false}});
  await until(async()=>await page.locator('[data-pff-restored]').count()===0,'Disable did not remove media');
  assert.ok(await page.evaluate(async urls=>(await Promise.all(urls.map(async url=>{try{await fetch(url);return false;}catch{return true;}}))).every(Boolean),urls));
  await rpc({type:'save',settings:{...config,archive:true}});await until(async()=>await page.locator('[data-pff-restored]').count()===8,'Re-enable did not restore media');
  await rpc({type:'clear'});await until(async()=>await page.locator('[data-pff-restored]').count()===0,'Clear did not remove media');
  assert.equal((await rpc({type:'status'})).stats.count,0);assert.deepEqual(errors,[]);
  await writeFile('test-results/media-browser-report.json',JSON.stringify({synthetic:true,primaryFacebookUsed:false,emojiVariants:5,images:2,voice:1,byteIntegrity:true,offDomVoiceCapture:true,automaticNextVoiceNotMisattributed:true,aliasRebind:true,playbackPreservedOnRebind:true,expiredURLsAfterReload:true,objectURLsRevokedOnDisable:true,clearPassed:true,passed:true},null,2));
  console.log('PASS bounded binary storage, object URL cleanup, disable/re-enable/clear and no uncaught browser errors');
}finally{await context.close();if(path.resolve(profile).startsWith(root+path.sep))await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
