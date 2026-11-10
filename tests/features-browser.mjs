import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

// Synthetic Facebook only: every page and CDN URL below is stubbed locally.
const root=path.resolve('test-results/features-browser'),profile=path.join(root,'profiles',crypto.randomUUID());await mkdir(profile,{recursive:true});
const extension=path.resolve(process.env.PFF_TEST_EXTENSION||'dist');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
const pdf=Buffer.from('%PDF-1.4 synthetic attachment for tests');
const CDN='https://pff-test.invalid.fbcdn.net',FILES='https://pff-test.invalid.fbsbx.com';
const remote={[`${CDN}/stickers/s.png`]:png,[`${CDN}/photos/a.gif`]:gif,[`${FILES}/v/report.pdf`]:pdf};
const row=(id,body,label='')=>`<div role="article"><div data-message-id="${id}" aria-label="At 01:00, An${label}">${body}</div></div>`;
const fixture=`<!doctype html><meta charset="utf-8"><body style="font:15px system-ui"><div role="log" id="log" data-thread-id="20002" style="max-width:500px">
${row('mid.meta','<h4 dir="auto">An</h4><blockquote>Câu được trả lời</blockquote><span dir="auto" data-message-text>Tin có người gửi</span>',': Tin có người gửi')}
${row('mid.sticker',`<img alt="Sticker" width="64" src="${CDN}/stickers/s.png">`)}
${row('mid.gif',`<img alt="GIF" width="64" src="${CDN}/photos/a.gif">`)}
${row('mid.file',`<a href="${FILES}/v/report.pdf">report.pdf</a>`)}
${row('mid.video','<video id="vid" controls width="160"></video>')}
${row('mid.edit','<span dir="auto" data-message-text id="editable">Bản đầu tiên</span>',': x')}
</div><script>window.require=()=>({getID:()=> '10001'});
document.querySelector('[data-message-id="mid.meta"]').__reactFiber$fixture={memoizedProps:{message:{messageId:'mid.meta',senderId:'777',timestampMs:1800000000000}},return:null};
const big=new Uint8Array(15*1024*1024);big.set([0,0,0,32,102,116,121,112,105,115,111,109]);big[9000000]=77;
window.videoBytes=big;document.getElementById('vid').src=URL.createObjectURL(new Blob([big],{type:'video/mp4'}));
</script></body>`;
const context=await chromium.launchPersistentContext(profile,{executablePath:process.env.PFF_TEST_BROWSER||path.resolve('test-results/browser-current/chrome-win64/chrome.exe'),headless:true,ignoreDefaultArgs:['--disable-extensions'],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--mute-audio'],viewport:{width:1200,height:1400},acceptDownloads:true});
context.setDefaultTimeout(12000);
const errors=[];context.on('weberror',e=>errors.push(e.error().message));
await context.route(/^https?:\/\//,route=>{const url=route.request().url();if(url.startsWith('https://www.facebook.com/'))return route.fulfill({contentType:'text/html',body:fixture});if(remote[url])return route.fulfill({body:remote[url]});return route.abort();});
await context.addCookies([{name:'c_user',value:'10001',domain:'.facebook.com',path:'/',secure:true,sameSite:'Lax'}]);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,message,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await sleep(100);}throw Error(`Timed out: ${message}`);}
const sha=bytes=>crypto.subtle.digest('SHA-256',bytes).then(d=>Buffer.from(d).toString('hex'));
const report={synthetic:true,primaryFacebookUsed:false};
try{
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker'),base=`chrome-extension://${new URL(worker.url()).hostname}/`;
  await worker.evaluate(files=>{const original=globalThis.fetch;globalThis.fetch=(input,init)=>files[String(input)]?Promise.resolve(new Response(Uint8Array.from(files[String(input)]))):original(input,init);},Object.fromEntries(Object.entries(remote).map(([k,v])=>[k,[...v]])));
  const ui=await context.newPage();await ui.goto(base+'options.html#archive');await ui.waitForFunction(()=>document.querySelector('#settingsFields')?.disabled===false);
  const rpc=m=>ui.evaluate(async m=>{const r=await chrome.runtime.sendMessage(m);if(!r?.ok)throw Error(r?.error);return r;},m);
  const status=()=>rpc({type:'status'});
  await rpc({type:'save',settings:{maxBytes:256*1024*1024,autoVoice:false}});
  const page=await context.newPage();await page.goto('https://www.facebook.com/messages/t/20002/');
  await until(async()=>(await status()).stats.count===5,'text, sticker, GIF and file captured; video off by default');
  assert.equal((await rpc({type:'list',state:'all'})).rows.some(row=>row.id==='mid.video'),false,'Video was saved although the setting is off');
  await rpc({type:'save',settings:{saveVideo:true,maxVideoMiB:32}});
  await until(async()=>(await status()).stats.count===6,'turning video on captures what is already on screen');
  report.videoOffByDefault=true;
  console.log('PASS stickers, GIFs and attachments are captured; a 15 MiB video only once its switch is on');

  await page.evaluate(()=>{document.getElementById('editable').textContent='Bản đã sửa';});
  await until(async()=>(await rpc({type:'list',state:'all'})).rows.find(row=>row.id==='mid.edit')?.text==='Bản đã sửa','edit committed');
  const all=(await rpc({type:'list',state:'all'})).rows,meta=all.find(row=>row.id==='mid.meta'),edited=all.find(row=>row.id==='mid.edit');
  assert.equal(meta.senderName,'An');assert.equal(meta.senderId,'777');assert.equal(meta.sentAt,1800000000000);assert.equal(meta.replyText,'Câu được trả lời');
  assert.deepEqual(edited.history.map(entry=>entry.text),['Bản đầu tiên']);
  await ui.selectOption('#archiveState','all');await until(async()=>await ui.locator('.archive-row').count()===6,'All-saved filter');
  assert.match(await ui.locator('.archive-row',{hasText:'Tin có người gửi'}).locator('.archive-meta').innerText(),/An · sent/);
  assert.match(await ui.locator('.archive-row',{hasText:'Tin có người gửi'}).locator('.archive-reply').innerText(),/Câu được trả lời/);
  const editedRow=ui.locator('.archive-row',{hasText:'Bản đã sửa'});await editedRow.locator('.archive-history summary').click();assert.match(await editedRow.locator('.archive-history').innerText(),/Bản đầu tiên/);
  await ui.fill('#archiveSearch','bản đầu tiên');await until(async()=>await ui.locator('.archive-row').count()===1,'Search reaches old edits');
  await ui.fill('#archiveSearch','');await until(async()=>await ui.locator('.archive-row').count()===6,'Clearing search');
  await ui.selectOption('#archiveState','removed');await until(async()=>await ui.locator('.empty-state').count()===1,'Recalled filter starts empty');
  assert.equal(await ui.locator('#archiveState option[value="vanished"]').isDisabled(),true);
  report.sendersRepliesHistoryAndSearch=true;
  console.log('PASS sender, sent time, reply, edit history, state filter and archive-wide search');

  await worker.evaluate(()=>{const original=IDBDatabase.prototype.transaction;globalThis.__failWrites=3;IDBDatabase.prototype.transaction=function(names,mode){if(mode==='readwrite'&&globalThis.__failWrites>0){globalThis.__failWrites--;throw new DOMException('Synthetic failure','AbortError');}return original.apply(this,arguments);};});
  await page.evaluate(()=>{const log=document.getElementById('log'),article=document.createElement('div');article.setAttribute('role','article');article.innerHTML='<div data-message-id="mid.retry" aria-label="At 01:00, An: Tin phải được thử lại"><span dir="auto" data-message-text>Tin phải được thử lại</span></div>';log.append(article);});
  await until(async()=>(await worker.evaluate(()=>globalThis.__failWrites))===0,'three synthetic write failures consumed');
  // Recall it while its capture is still waiting for the retry.
  await page.evaluate(()=>{const r=document.querySelector('[data-message-id="mid.retry"]');r.setAttribute('aria-label','At 01:00, An');r.innerHTML='<span dir="auto">You deleted a message</span>';});
  await until(async()=>(await rpc({type:'list'})).rows.some(row=>row.id==='mid.retry'&&row.text==='Tin phải được thử lại'),'retried capture committed before its recall',20000);
  await until(async()=>(await page.locator('[data-message-id="mid.retry"] [data-pff-restored]').textContent().catch(()=>null))==='Tin phải được thử lại','recall restored after the retry');
  report.failedBatchRetried=true;
  // A newer edit seen while an older capture waits must not be overwritten by the retry.
  await worker.evaluate(()=>{globalThis.__failWrites=3;});
  await page.evaluate(()=>{const log=document.getElementById('log'),article=document.createElement('div');article.setAttribute('role','article');article.innerHTML='<div data-message-id="mid.retry2" aria-label="At 01:00, An: Phiên bản 1"><span dir="auto" data-message-text id="retry2">Phiên bản 1</span></div>';log.append(article);});
  await until(async()=>(await worker.evaluate(()=>globalThis.__failWrites))===0,'failures for the first version consumed');
  await page.evaluate(()=>{const r=document.querySelector('[data-message-id="mid.retry2"]');r.setAttribute('aria-label','At 01:00, An: Phiên bản 2');document.getElementById('retry2').textContent='Phiên bản 2';});
  await until(async()=>(await rpc({type:'list',state:'all'})).rows.find(row=>row.id==='mid.retry2')?.text==='Phiên bản 2','newer version committed after the retried older one',30000);
  await sleep(7000);
  assert.equal((await rpc({type:'list',state:'all'})).rows.find(row=>row.id==='mid.retry2').text,'Phiên bản 2','a retried older version overwrote a newer edit');
  assert.deepEqual((await rpc({type:'list',state:'all'})).rows.find(row=>row.id==='mid.retry2').history.map(entry=>entry.text),['Phiên bản 1'],'the older version is kept as history, not dropped');
  console.log('PASS a batch that failed every immediate attempt is retried, a recall seen meanwhile waits for it, and a newer edit is never overwritten');

  await page.evaluate(()=>{for(const row of document.querySelectorAll('#log [data-message-id]'))row.innerHTML='<span dir="auto">You deleted a message</span>';});
  await until(async()=>await page.locator('#log [data-pff-restored]').count()===8,'all kinds restored');
  await until(async()=>page.locator('[data-message-id="mid.sticker"] img').evaluate(n=>n.complete&&n.naturalWidth>0),'sticker decoded');
  await until(async()=>page.locator('[data-message-id="mid.gif"] img').evaluate(n=>n.complete&&n.naturalWidth>0),'GIF decoded');
  const video=page.locator('[data-message-id="mid.video"] video');assert.equal(await video.getAttribute('src'),null,'A video must not load before it is requested');
  await video.click();await until(async()=>!!await video.getAttribute('src'),'video loads on request',30000);
  assert.equal(await video.evaluate(async n=>{const b=await(await fetch(n.src)).arrayBuffer();const a=new Uint8Array(b);return a.length===15*1024*1024&&a[9000000]===77;}),true,'Restored video bytes differ');
  const button=page.locator('[data-message-id="mid.file"] [data-pff-file]');assert.match(await button.innerText(),/report\.pdf/);
  const [download]=await Promise.all([page.waitForEvent('download'),button.click()]);assert.equal(download.suggestedFilename(),'report.pdf');
  const saved=path.join(root,'report.pdf');await download.saveAs(saved);assert.equal(await sha(await import('node:fs/promises').then(f=>f.readFile(saved))),await sha(pdf));
  assert.equal((await rpc({type:'list'})).rows.find(row=>row.id==='mid.meta').text,'Tin có người gửi');
  report.allKindsRestored=true;
  console.log('PASS sticker, GIF, on-demand video and downloadable file are restored byte for byte');

  await ui.evaluate(()=>location.hash='backup');await ui.locator('#exportPassword').waitFor();
  await until(async()=>(await ui.locator('#persistState').innerText()).length>0,'browser storage protection status');
  assert.match(await ui.locator('#storageUsage').innerText(),/MiB/);
  await ui.fill('#exportPassword','backup-pass-1');await ui.fill('#exportConfirm','different-pass');await ui.click('#exportBackup');
  await until(async()=>/do not match/.test(await ui.locator('#exportStatus').innerText()),'Mismatched passwords rejected');
  await ui.fill('#exportConfirm','backup-pass-1');
  const [backup]=await Promise.all([ui.waitForEvent('download'),ui.click('#exportBackup')]);assert.match(backup.suggestedFilename(),/\.pffbak$/);
  const backupPath=path.join(root,'archive.pffbak');await backup.saveAs(backupPath);
  await rpc({type:'clear'});await until(async()=>await page.locator('#log [data-pff-restored]').count()===0,'clear removes restored bubbles');
  await ui.setInputFiles('#importFile',backupPath);await ui.fill('#importPassword','wrong-password');await ui.click('#importBackup');
  await until(async()=>/password is wrong/.test(await ui.locator('#importStatus').innerText()),'Wrong backup password');
  assert.equal((await status()).stats.count,0);
  await ui.fill('#importPassword','backup-pass-1');await ui.click('#importBackup');
  await until(async()=>/Imported 8/.test(await ui.locator('#importStatus').innerText()),'Backup import',30000);
  assert.equal((await status()).stats.count,8);
  await until(async()=>await page.locator('#log [data-pff-restored]').count()===8,'imported archive restores in the open tab');
  await page.locator('[data-message-id="mid.video"] video').click();
  await until(async()=>page.locator('[data-message-id="mid.video"] video').evaluate(async n=>{if(!n.src)return false;const a=new Uint8Array(await(await fetch(n.src)).arrayBuffer());return a.length===15*1024*1024&&a[9000000]===77;}),'video intact after import',30000);
  report.backupRoundTrip=true;
  console.log('PASS encrypted export, wrong-password refusal and import through the real interface');

  await ui.fill('#vaultNewPassword','vault-pass-12');await ui.fill('#vaultConfirmPassword','vault-pass-12');await ui.click('#vaultEnable');
  await until(async()=>/Unlocked until/.test(await ui.locator('#vaultState').innerText()),'Lock enabled and existing messages sealed',60000);
  const sealed=await ui.evaluate(()=>new Promise((resolve,reject)=>{const open=indexedDB.open('pito-message-archive-v1');open.onerror=()=>reject(open.error);open.onsuccess=()=>{const get=open.result.transaction('messages').objectStore('messages').getAll();get.onsuccess=()=>{resolve(get.result.map(r=>({sealed:!!r.seal,text:new TextDecoder().decode(r.data).includes('Tin có người gửi')})));open.result.close();};};}));
  assert.equal(sealed.every(r=>r.sealed&&!r.text),true,'A stored record was not sealed');
  await ui.click('#vaultLock');await until(async()=>/Locked\./.test(await ui.locator('#vaultState').innerText()),'Locked');
  await until(async()=>await page.locator('#log [data-pff-restored]').count()===0,'Locking removes readable content from the open tab');
  assert.equal(await page.locator('[data-message-id="mid.meta"]').textContent(),'You deleted a message');
  await ui.evaluate(()=>location.hash='archive');await until(async()=>(await rpc({type:'list'})).locked===true,'list reports the lock');
  await ui.click('#refreshArchive');await until(async()=>await ui.locator('#archiveLockNotice').isVisible(),'Lock notice');assert.match(await ui.locator('.message-body').first().innerText(),/Locked/);
  await ui.evaluate(()=>location.hash='backup');
  await ui.fill('#vaultPassword','wrong-password');await ui.click('#vaultUnlock');await until(async()=>/not correct/.test(await ui.locator('#vaultState').innerText()),'Wrong unlock password');
  await ui.fill('#vaultPassword','vault-pass-12');await ui.click('#vaultUnlock');
  await until(async()=>await page.locator('#log [data-pff-restored]').count()===8,'Unlocking restores the recalled messages');
  await ui.fill('#vaultDisablePassword','vault-pass-12');await ui.click('#vaultDisable');
  await until(async()=>/^Off\./.test(await ui.locator('#vaultState').innerText()),'Lock removed',60000);
  assert.equal((await rpc({type:'list'})).rows.some(row=>row.text==='Tin có người gửi'),true);
  report.passwordLock=true;
  console.log('PASS password lock seals the archive, hides it while locked and restores it after unlocking');

  assert.deepEqual(errors,[]);
  await writeFile(path.join(root,'report.json'),JSON.stringify({...report,passed:true},null,2));
}finally{await context.close();await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});}
