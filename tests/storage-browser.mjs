import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Synthetic Facebook only. No personal browser/profile or live recipients.
const profile=path.resolve('test-results/storage-profiles',crypto.randomUUID());await mkdir(profile,{recursive:true});
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const images=[image,Buffer.concat([image,Buffer.from('QA-second-photo')])];
const voice=Buffer.alloc(44+48000*2*2);voice.write('RIFF');voice.writeUInt32LE(voice.length-8,4);voice.write('WAVEfmt ',8);voice.writeUInt32LE(16,16);voice.writeUInt16LE(1,20);voice.writeUInt16LE(1,22);voice.writeUInt32LE(48000,24);voice.writeUInt32LE(96000,28);voice.writeUInt16LE(2,32);voice.writeUInt16LE(16,34);voice.write('data',36);voice.writeUInt32LE(voice.length-44,40);
let removed=false;
const fixture=()=>`<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui}#log{width:480px}[data-message-id]{margin:10px;padding:8px;border:1px solid #aaa}</style><div id="log" role="log" data-thread-id="20002">${[
  ['mid.album','<span data-message-text>Album QA</span>'+images.map(b=>`<img alt="Open photo" width="80" src="data:image/png;base64,${b.toString('base64')}">`).join('')],
  ['mid.voice','<button aria-label="Play" id="play">Play</button><div role="slider" aria-label="Audio scrubber"></div><div role="timer">0:04</div>'],
  ['mid.text','<span data-message-text>Văn bản QA</span>'],
].map(([id,body])=>`<div data-message-id="${id}" aria-label="At 01:00, You">${removed?'<span dir="auto">You deleted a message</span>':body}</div>`).join('')}</div><script>window.require=()=>({getID:()=> '10001'});window.qaClicks=0;document.getElementById('play')?.addEventListener('click',()=>{qaClicks++;const b=Uint8Array.from(atob('${voice.toString('base64')}'),c=>c.charCodeAt(0));window.qaAudio=new Audio(URL.createObjectURL(new Blob([b],{type:'audio/wav'})));qaAudio.play();});</script>`;
const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.PFF_TEST_BROWSER||path.resolve('test-results/browser/chrome-win/chrome.exe'),headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${path.resolve('dist')}`,`--load-extension=${path.resolve('dist')}`,'--mute-audio'],viewport:{width:1100,height:1000}});
await context.route(/^https?:\/\//,route=>route.request().url().startsWith('https://www.facebook.com/')?route.fulfill({contentType:'text/html',body:fixture()}):route.abort());
await context.addCookies([{name:'c_user',value:'10001',domain:'.facebook.com',path:'/',secure:true,sameSite:'Lax'}]);
const errors=[];context.on('weberror',e=>errors.push(e.error().message));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,message){for(let n=0;n<100;n++){if(await check())return;await sleep(100);}throw Error(message);}
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),ui=await context.newPage();await ui.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html#storage`);
  const rpc=m=>ui.evaluate(async m=>{const r=await chrome.runtime.sendMessage(m);if(!r?.ok)throw Error(r?.error);return r;},m);
  await rpc({type:'save',settings:{language:'vi'}});
  await ui.locator('[name="budgetMiB"]').fill('256');await ui.locator('[name="retentionDays"]').fill('0');await ui.locator('[name="cleanupRemoved"]').uncheck();await ui.locator('#save').click();
  await until(async()=>(await rpc({type:'status'})).settings.maxBytes===256*1024*1024,'Custom MiB budget did not persist');
  assert.equal((await rpc({type:'status'})).settings.retentionDays,0);
  const page=await context.newPage();await page.goto('https://www.facebook.com/messages/t/20002/');
  await until(async()=>(await rpc({type:'status'})).stats.count===3,'Automatic unplayed voice or album not committed');
  assert.equal(await page.evaluate(()=>qaClicks),1);assert.equal(await page.evaluate(()=>qaAudio.paused),true);assert.equal(await page.evaluate(()=>qaAudio.currentTime),0);
  await page.evaluate(()=>qaAudio.play());assert.equal(await page.evaluate(()=>qaAudio.paused),true,'Repeated automatic play must remain silent');
  await page.reload();await page.waitForSelector('#play');await sleep(1800);
  assert.equal(await page.evaluate(()=>qaClicks),0,'Already archived voice must not be downloaded again after reload');
  await page.evaluate(()=>{for(const row of document.querySelectorAll('[data-message-id]'))row.innerHTML='<span dir="auto">You deleted a message</span>';});
  await until(async()=>await page.locator('[data-pff-restored]').count()===3,'All native bubbles must be restored');
  // Both photos of the album show in the bubble; the viewer switches between them.
  const album=page.locator('[data-message-id="mid.album"]'),img=album.locator('[data-pff-media] img');
  assert.equal(await img.count(),2);await until(async()=>img.evaluateAll(nodes=>nodes.every(n=>n.complete&&n.naturalWidth>0)),'Album photos did not load');
  const hash=locator=>locator.evaluate(async n=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await(await fetch(n.src)).arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join(''));
  const digest=b=>crypto.subtle.digest('SHA-256',b).then(b=>Buffer.from(b).toString('hex'));
  assert.equal(await hash(img.nth(0)),await digest(images[0]));assert.equal(await hash(img.nth(1)),await digest(images[1]));
  await album.getByRole('button',{name:'Xem ảnh 1 trên 2',exact:true}).click();
  const photo=page.locator('[data-pff-viewer-photo]'),loaded=()=>photo.evaluate(n=>!!n.getAttribute('src')&&n.complete&&n.naturalWidth>0);
  await until(loaded,'Viewer did not show the first photo');assert.equal(await hash(photo),await digest(images[0]));
  await page.getByRole('button',{name:'Ảnh sau',exact:true}).click();
  await until(async()=>(await page.locator('[data-pff-viewer] .counter').innerText())==='2 / 2'&&await loaded(),'Next photo did not load in the viewer');assert.equal(await hash(photo),await digest(images[1]));
  await page.locator('[data-pff-viewer]').evaluate(host=>{const r=host.shadowRoot;for(let i=0;i<30;i++){r.querySelector('[data-pff-viewer-action="previous"]').click();r.querySelector('[data-pff-viewer-action="next"]').click();}});
  await until(loaded,'Rapid gallery switching stalled');assert.equal(await hash(photo),await digest(images[1]));
  await page.keyboard.press('Escape');await until(async()=>await page.locator('[data-pff-viewer]').count()===0,'Viewer did not close');
  const audio=page.locator('[data-pff-media] audio');await until(async()=>audio.evaluate(n=>n.readyState>=1),'Unplayed archived voice did not decode');
  await audio.evaluate(n=>n.play());await until(async()=>audio.evaluate(n=>n.currentTime>0),'Unplayed voice archive cannot play');await audio.evaluate(n=>n.pause());
  removed=true;await page.reload();await until(async()=>page.locator('[data-pff-restored]').count().then(n=>n===3),'Reload lost archived album/voice');
  await until(async()=>page.locator('[data-pff-media] img').evaluateAll(nodes=>nodes.length===2&&nodes.every(n=>n.complete&&n.naturalWidth>0)),'Reloaded gallery not decoded');
  await ui.reload();await ui.locator('#requestImages').click();await ui.locator('#confirmPurge').click();
  await until(async()=>ui.locator('#purgeFeedback').innerText().then(t=>t.includes('Đã dọn 0 tệp')),'Default manual purge touched protected media');
  await ui.locator('#purgeRemoved').check();await ui.locator('#confirmPurge').click();
  await until(async()=>ui.locator('#purgeFeedback').innerText().then(t=>t.includes('Đã dọn 2 tệp')),'Image-only purge did not remove two photos');
  await until(async()=>page.locator('[data-pff-media] img').count().then(n=>n===0),'Purged photos remained displayed');
  await until(async()=>page.locator('[data-pff-media] audio').count().then(n=>n===1),'Image-only purge removed voice');assert.match(await page.locator('#log').innerText(),/Album QA/);
  await ui.locator('#cancelPurge').click();await ui.locator('#requestVoice').click();await ui.locator('#purgeRemoved').check();await ui.locator('#confirmPurge').click();
  await until(async()=>ui.locator('#purgeFeedback').innerText().then(t=>t.includes('Đã dọn 1 tệp')),'Voice-only purge failed');
  await until(async()=>page.locator('[data-pff-media] audio').count().then(n=>n===0),'Purged voice remained displayed');
  await until(async()=>page.locator('#log').innerText().then(t=>t.includes('Văn bản QA')),'Selective cleanup lost text restoration');
  assert.match(await page.locator('#log').innerText(),/Văn bản QA/);assert.equal((await rpc({type:'status'})).stats.count,3);assert.deepEqual(errors,[]);
  const report={synthetic:true,primaryFacebookUsed:false,automaticVoiceWithoutPlayback:true,alreadyArchivedVoiceNotDownloadedAgain:true,customSettingsPersisted:true,albumGrid:true,viewerSwitching:true,rapidSwitching:true,reload:true,separateCleanup:true,protectedMediaSkippedByDefault:true,passed:true};
  await writeFile('test-results/storage-browser-report.json',JSON.stringify(report,null,2));console.log('PASS storage controls, protected media, selective cleanup, rapid gallery switching and automatic voice without playback (synthetic)');
}finally{await context.close();}
