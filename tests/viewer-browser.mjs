import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Synthetic Facebook only: a new profile, every HTTP request blocked or answered
// by the fixture, no account and no personal browser data.
const root=path.resolve('test-results/viewer-browser'),profile=path.join(root,'profiles',crypto.randomUUID());await mkdir(profile,{recursive:true});
const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.PFF_TEST_BROWSER||path.resolve('test-results/browser/chrome-win/chrome.exe'),headless:true,
  ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${path.resolve('dist')}`,`--load-extension=${path.resolve('dist')}`],viewport:{width:1280,height:900}});
context.setDefaultTimeout(15000);
const errors=[];context.on('weberror',e=>errors.push(e.error().message));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,message,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await sleep(100);}throw Error(message);}
const hex=async bytes=>Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex');
const report={synthetic:true,primaryFacebookUsed:false};

let removed=false,photos=[],portrait=null;
const tombstone='<span dir="auto">Pito unsent a message</span>';
const row=(id,body)=>`<div role="article"><div data-message-id="${id}" aria-label="At 01:00, Pito">${removed?tombstone:body}</div></div>`;
const fixture=()=>`<!doctype html><meta charset="utf-8"><style>body{font:15px system-ui;margin:0;background:#fff}#log{width:520px;padding:12px}[data-message-id]{display:inline-block;max-width:420px;margin:6px 0;padding:8px 12px;border:1px solid #ccd;border-radius:18px;font-style:italic;color:#555}</style>
<div role="log" id="log" data-thread-id="20002">${[
  row('mid.album',photos.map(b=>`<img alt="Open photo" width="80" src="data:image/jpeg;base64,${b.toString('base64')}">`).join('')),
  row('mid.single',`<img alt="Open photo" width="80" src="data:image/jpeg;base64,${portrait.toString('base64')}">`),
  row('mid.text','<span dir="auto" data-message-text>Tin văn bản QA</span>'),
].join('<br>')}</div><script>window.require=()=>({getID:()=> '10001'});window.rowClicks=0;document.addEventListener('click',e=>{if(e.target.closest?.('[data-message-id]'))rowClicks++;});</script>`;
await context.route(/^https?:\/\//,route=>route.request().url().startsWith('https://www.facebook.com/')?route.fulfill({contentType:'text/html',body:fixture()}):route.abort());
await context.addCookies([{name:'c_user',value:'10001',domain:'.facebook.com',path:'/',secure:true,sameSite:'Lax'}]);

try{
  // Distinct, photo-sized JPEGs with a big number on each, so screenshots show
  // which photo is on screen and every file spans several 192 KiB pieces.
  const painter=await context.newPage();
  const draw=(width,height,label,hue)=>painter.evaluate(async ({width,height,label,hue})=>{
    const canvas=new OffscreenCanvas(width,height),c=canvas.getContext('2d'),g=c.createLinearGradient(0,0,width,height);
    g.addColorStop(0,`hsl(${hue} 70% 55%)`);g.addColorStop(1,`hsl(${(hue+60)%360} 70% 30%)`);c.fillStyle=g;c.fillRect(0,0,width,height);
    for(let i=0;i<9000;i++){c.fillStyle=`hsla(${(hue+i)%360} 60% ${30+i%50}% / .35)`;c.fillRect((i*7919)%width,(i*104729)%height,6,6);}
    c.fillStyle='#fff';c.font=`bold ${Math.round(height*.45)}px system-ui`;c.textAlign='center';c.textBaseline='middle';c.fillText(label,width/2,height/2);
    const bytes=new Uint8Array(await (await canvas.convertToBlob({type:'image/jpeg',quality:.95})).arrayBuffer());
    let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);
  },{width,height,label,hue}).then(b64=>Buffer.from(b64,'base64'));
  for(let i=0;i<7;i++)photos.push(await draw(1600,1200,String(i+1),i*47));
  portrait=await draw(900,1400,'P',200);await painter.close();
  const chunks=[...photos,portrait].reduce((sum,b)=>sum+Math.ceil(b.length/(192*1024)),0);
  report.photoBytes=photos.map(b=>b.length);report.piecesInAllPhotos=chunks;

  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),ui=await context.newPage();
  await ui.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);
  const rpc=m=>ui.evaluate(async m=>{const r=await chrome.runtime.sendMessage(m);if(!r?.ok)throw Error(r?.error);return r;},m);
  const page=await context.newPage();await page.goto('https://www.facebook.com/messages/t/20002/');
  await until(async()=>(await rpc({type:'status'})).stats.count===3,'Album, single photo and text were not captured',30000);
  const listed=(await rpc({type:'list',state:'all'})).rows;
  assert.equal(listed.find(r=>r.id==='mid.album').assets.length,7);assert.equal(listed.find(r=>r.id==='mid.single').assets.length,1);

  // The worker answers the first two reads with "busy" and counts every read.
  await worker.evaluate(()=>{
    globalThis.__assetReads=0;let failures=2;
    chrome.runtime.onMessage.addListener((message,sender,respond)=>{
      if(message?.type!=='asset')return;globalThis.__assetReads++;
      if(failures>0){failures--;respond({ok:false,error:'errBusy'});return true;}
    });
  });
  removed=true;
  await page.evaluate(html=>{for(const node of document.querySelectorAll('[data-message-id]'))node.innerHTML=html;},tombstone);
  // Facebook redraws the recall notice while the photos are loading.
  await page.evaluate(()=>{let n=0;const timer=setInterval(()=>{
    for(const node of document.querySelectorAll('[data-message-id] span[dir=auto]')){const fresh=document.createElement('span');fresh.dir='auto';fresh.textContent='Pito unsent a message';node.replaceWith(fresh);}
    if(++n===10)clearInterval(timer);},200);});
  await sleep(2300);
  const album=page.locator('[data-message-id="mid.album"]'),tiles=album.locator('[data-pff-image-tile]');
  await until(async()=>await page.locator('#log [data-pff-restored]').count()===3,'Recalled bubbles were not restored after redraws');
  await until(async()=>(await tiles.evaluateAll(nodes=>nodes.map(n=>n.dataset.state==='ready'&&n.querySelector('img').complete&&n.querySelector('img').naturalWidth===1600))).every(Boolean)&&await tiles.count()===6,'Album tiles did not all load despite a busy worker and redraws');
  assert.equal(await album.locator('.more').innerText(),'+1','The sixth tile names the photo that is not shown');
  const single=page.locator('[data-message-id="mid.single"] [data-pff-image-tile]');
  await until(async()=>single.evaluate(n=>n.dataset.state==='ready'&&n.querySelector('img').naturalHeight===1400),'Single photo did not load');
  const box=await single.boundingBox();assert.ok(box.height>box.width*1.4&&box.height<=322,'A single photo keeps its own proportions');
  assert.equal(await page.locator('#log').evaluate(n=>n.innerText.includes('Recalled photo')),false,'No placeholder text is shown in place of a photo');
  const reads=await worker.evaluate(()=>globalThis.__assetReads);
  report.assetReads=reads;assert.ok(reads<=chunks+2+8,`Redraws restarted loads from the beginning (${reads} reads for ${chunks} pieces)`);
  report.retriesAfterBusyWorker=true;report.redrawsReuseLoads=true;
  await page.locator('#log').screenshot({path:path.join(root,'bubble.png')});
  console.log(`PASS photos appear in the recalled bubble: 6 tiles + "+1", single photo in proportion; busy worker retried; ${reads} reads for ${chunks} pieces through 10 redraws`);

  // Opening the viewer: the click never reaches the message row.
  const clicksBefore=await page.evaluate(()=>rowClicks);
  await tiles.nth(1).click();
  const dialog=page.locator('[data-pff-viewer] dialog'),photo=page.locator('[data-pff-viewer-photo]'),counter=page.locator('[data-pff-viewer] .counter');
  await until(async()=>dialog.evaluate(n=>n.open),'Viewer did not open');
  assert.equal(await page.evaluate(()=>rowClicks),clicksBefore,'A click on a photo reached the message row');
  const shown=async()=>{await until(async()=>photo.evaluate(n=>n.complete&&n.naturalWidth>0&&!!n.getAttribute('src')),'Viewer photo did not load');return hex(await photo.evaluate(async n=>[...new Uint8Array(await (await fetch(n.src)).arrayBuffer())]).then(a=>Uint8Array.from(a)));};
  const expect=async index=>{await until(async()=>(await counter.innerText())===`${index+1} / 7`,`Counter is not ${index+1} / 7`);assert.equal(await shown(),await hex(photos[index]),`Photo ${index+1} bytes differ`);};
  await expect(1);await sleep(300);await page.screenshot({path:path.join(root,'viewer.png')});
  await page.locator('[data-pff-viewer-action="next"]').click();await expect(2);
  await page.keyboard.press('ArrowRight');await expect(3);
  await page.keyboard.press('ArrowLeft');await expect(2);
  await page.keyboard.press('End');await expect(6);assert.equal(await page.locator('[data-pff-viewer-action="next"]').isDisabled(),true);
  await page.keyboard.press('Home');await expect(0);assert.equal(await page.locator('[data-pff-viewer-action="previous"]').isDisabled(),true);
  await page.locator('[data-pff-viewer-thumb="4"]').click();await expect(4);
  assert.equal(await page.locator('[data-pff-viewer-thumb="4"]').getAttribute('aria-current'),'true');
  for(let i=0;i<30;i++){await page.keyboard.press('ArrowRight');await page.keyboard.press('ArrowLeft');}
  await expect(4);
  // Swipe: dragging an unzoomed photo sideways moves to the next one.
  let rect=await photo.boundingBox();
  await page.mouse.move(rect.x+rect.width*.7,rect.y+rect.height/2);await page.mouse.down();await page.mouse.move(rect.x+rect.width*.7-200,rect.y+rect.height/2,{steps:8});await page.mouse.up();
  await expect(5);await page.keyboard.press('ArrowLeft');await expect(4);
  report.navigation=true;console.log('PASS viewer switches photos by buttons, arrow keys, Home/End, thumbnails, swipe and 60 rapid key presses, byte for byte');

  // Zoom by button, wheel, click and keyboard; drag pans; 0 fits again.
  const scale=()=>photo.evaluate(n=>{const m=n.style.transform.match(/scale\(([\d.]+)\)/);return m?Number(m[1]):1;});
  const offset=()=>photo.evaluate(n=>{const m=n.style.transform.match(/translate\((-?[\d.]+)px, ?(-?[\d.]+)px\)/);return m?[Number(m[1]),Number(m[2])]:[0,0];});
  await page.locator('[data-pff-viewer-action="zoom-in"]').click();assert.equal(await scale(),1.25);assert.equal(await page.locator('[data-pff-viewer-action="reset"]').innerText(),'125%');
  rect=await photo.boundingBox();await page.mouse.move(rect.x+rect.width*.3,rect.y+rect.height*.3);await page.mouse.wheel(0,-400);
  await until(async()=>(await scale())>1.6,'Wheel did not zoom');
  const before=await offset();await page.mouse.down();await page.mouse.move(rect.x+rect.width*.3+120,rect.y+rect.height*.3+60,{steps:6});await page.mouse.up();
  const after=await offset();assert.ok(Math.abs(after[0]-before[0])>50||Math.abs(after[1]-before[1])>20,'Dragging did not pan the zoomed photo');
  await expect(4);// a drag of a zoomed photo never switches photos
  await page.screenshot({path:path.join(root,'viewer-zoomed.png')});
  await page.keyboard.press('0');await until(async()=>(await scale())===1&&(await offset())[0]===0,'0 did not fit the photo again');
  rect=await photo.boundingBox();await page.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2);await until(async()=>(await scale())===2.5,'Click did not zoom in');
  await page.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2);await until(async()=>(await scale())===1,'Second click did not zoom out');
  await page.keyboard.press('+');await until(async()=>(await scale())===1.25,'+ did not zoom');await page.keyboard.press('-');await until(async()=>(await scale())===1,'- did not zoom out');
  await page.keyboard.press('ArrowRight');await expect(5);assert.equal(await scale(),1,'Switching photos resets zoom');
  report.zoom=true;console.log('PASS zoom by button, wheel at the pointer, click and keys; drag pans; switching resets zoom');

  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('[data-pff-viewer-action="download"]').click()]);
  const saved=path.join(root,download.suggestedFilename());await download.saveAs(saved);
  assert.match(download.suggestedFilename(),/^pitofacebookfixer-photo-6\.jpg$/);assert.equal(await hex(await readFile(saved)),await hex(photos[5]));
  report.download=true;

  await rpc({type:'save',settings:{...(await rpc({type:'status'})).settings,language:'vi'}});
  await until(async()=>(await page.locator('[data-pff-viewer-action="close"]').getAttribute('aria-label'))==='Đóng (Esc)','Viewer labels did not switch to Vietnamese');
  assert.equal(await page.locator('[data-pff-viewer] .hint').innerText(),'Nhấn hoặc cuộn để phóng to · Kéo để di chuyển · ← → để chuyển ảnh');
  await until(async()=>(await tiles.nth(0).getAttribute('aria-label'))==='Xem ảnh 1 trên 7','Tile labels did not switch to Vietnamese');
  report.bilingual=true;

  await page.keyboard.press('Escape');
  await until(async()=>await page.locator('[data-pff-viewer]').count()===0,'Escape did not close the viewer');
  assert.equal(await page.evaluate(()=>document.activeElement?.shadowRoot?.activeElement?.dataset?.pffImageTile),'1','Focus did not return to the photo that opened the viewer');

  await single.click();await until(async()=>dialog.evaluate(n=>n.open).catch(()=>false),'Single photo viewer did not open');
  assert.equal(await page.locator('[data-pff-viewer-action="next"]').count(),0);assert.equal(await page.locator('[data-pff-viewer-thumb]').count(),0);
  assert.equal(await shown(),await hex(portrait));
  await page.mouse.click(30,450);await until(async()=>await page.locator('[data-pff-viewer]').count()===0,'A click beside the photo did not close the viewer');
  report.singlePhoto=true;

  // The extension's own archive page uses the same grid and viewer.
  await ui.evaluate(()=>{location.hash='archive';});await ui.locator('#archiveRows').waitFor();
  const archiveTiles=ui.locator('#archiveRows [data-pff-image-tile]');
  await until(async()=>await archiveTiles.count()===7&&(await archiveTiles.evaluateAll(nodes=>nodes.every(n=>n.dataset.state==='ready'))),'Archive page did not show the album grid and single photo');
  await archiveTiles.first().click();
  const archivePhoto=ui.locator('[data-pff-viewer-photo]');
  await until(async()=>archivePhoto.evaluate(n=>n.complete&&n.naturalWidth>0&&!!n.getAttribute('src')).catch(()=>false),'Viewer did not open on the archive page');
  await ui.screenshot({path:path.join(root,'archive-viewer.png')});
  await ui.keyboard.press('Escape');await until(async()=>await ui.locator('[data-pff-viewer]').count()===0,'Archive page viewer did not close');
  report.archivePage=true;

  // Turning the archive off while the viewer is open closes it and frees every file.
  await tiles.nth(0).click();await until(async()=>dialog.evaluate(n=>n.open).catch(()=>false),'Viewer did not reopen');await shown();
  const urls=await page.locator('[data-pff-media] img,[data-pff-viewer] img').evaluateAll(nodes=>nodes.map(n=>n.src).filter(Boolean));
  assert.ok(urls.length>=6);
  const config=(await rpc({type:'status'})).settings;await rpc({type:'save',settings:{...config,archive:false}});
  await until(async()=>await page.locator('[data-pff-viewer]').count()===0&&await page.locator('[data-pff-restored]').count()===0,'Disabling the archive left the viewer or photos on screen');
  assert.ok(await page.evaluate(async urls=>(await Promise.all(urls.map(async url=>{try{await fetch(url);return false;}catch{return true;}}))).every(Boolean),urls),'Object URLs were not revoked');
  await rpc({type:'save',settings:{...config,archive:true}});
  await until(async()=>await page.locator('#log [data-pff-restored]').count()===3,'Re-enabling did not restore');
  await until(async()=>(await tiles.evaluateAll(nodes=>nodes.every(n=>n.dataset.state==='ready'))),'Photos did not load again after re-enabling');
  report.cleanup=true;

  assert.deepEqual(errors,[]);
  report.passed=true;await writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));
  console.log('PASS download, EN/VI labels, focus return, single photo, click-outside close, disable frees files; no uncaught errors');
}finally{await context.close();await rm(path.join(root,'profiles'),{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});}
