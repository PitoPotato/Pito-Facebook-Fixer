// Synthetic performance comparison. Fixtures only, never a real account.
//   node tests/perf-browser.mjs                       current dist, plus "none"
//   PFF_PERF_VARIANTS="none,baseline=path,current=dist" PFF_PERF_ROUNDS=3
// Results: test-results/perf/<label>.json
import {chromium} from 'playwright';
import {mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('test-results/perf'),rounds=Number(process.env.PFF_PERF_ROUNDS||3),seconds=Number(process.env.PFF_PERF_SECONDS||4);
const label=process.env.PFF_PERF_LABEL||'latest';
const variants=(process.env.PFF_PERF_VARIANTS||'none,current=dist').split(',').map(entry=>{const [name,value]=entry.split('=');return {name,extension:name==='none'?null:path.resolve(value)};});
const browser=process.env.PFF_TEST_BROWSER||path.resolve('test-results/browser-current/chrome-win64/chrome.exe');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const median=values=>{const s=[...values].sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:null;};
const COUNT=Number(process.env.PFF_PERF_ROWS||600);
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
const CDN='https://pff-perf.invalid.fbcdn.net/photos';
const rows=Array.from({length:COUNT},(_,i)=>`<div role="article" style="padding:6px"><div data-message-id="mid.perf.${i}" data-scope="messages_table" aria-label="At 01:${String(i%60).padStart(2,'0')}, An: Tin nhắn số ${i}"><h4 dir="auto">An</h4><div role="presentation"><div><div><span dir="auto"><div dir="auto">Tin nhắn số ${i} với một ít nội dung để có độ dài như thật</div></span></div></div></div><div><span role="presentation"><span dir="auto">Sent</span></span></div></div></div>`).join('');
const feed=Array.from({length:200},(_,i)=>`<div class="post"><h3>Post ${i}</h3><span class="counter">0</span><img alt="" width="4" height="4"><p>${'lorem '.repeat(30)}</p></div>`).join('');
const fixture=`<!doctype html><meta charset="utf-8"><body style="margin:0;font:14px system-ui"><div id="chat" role="log" data-thread-id="20002" style="height:400px;overflow:auto;width:420px;float:left">${rows}</div><div id="feed" style="height:400px;overflow:auto;margin-left:430px">${feed}</div><script>window.require=()=>({getID:()=> '10001'});
window.scrollChat=ms=>new Promise(done=>{const chat=document.getElementById('chat'),start=performance.now();let dir=1;(function step(){chat.scrollTop+=dir*220;if(chat.scrollTop<=0)dir=1;else if(chat.scrollTop+chat.clientHeight>=chat.scrollHeight-1)dir=-1;if(performance.now()-start<ms)requestAnimationFrame(step);else done();})();});
window.churnFeed=ms=>new Promise(done=>{const posts=[...document.querySelectorAll('.post')],start=performance.now();let n=0;const timer=setInterval(()=>{for(let i=0;i<40;i++){const post=posts[(n+i)%posts.length];post.querySelector('.counter').firstChild.data=String(n);post.querySelector('img').alt='x'+n;const extra=document.createElement('div');extra.innerHTML='<span><b>new</b> node</span>';post.append(extra);if(post.children.length>8)post.children[4].remove();}n++;if(performance.now()-start>=ms){clearInterval(timer);done();}},16);});
window.virtualScroll=ms=>new Promise(done=>{const chat=document.getElementById('chat'),start=performance.now();let next=100000;(function step(){for(let i=0;i<3;i++){chat.firstElementChild?.remove();const a=document.createElement('div');a.setAttribute('role','article');a.style.padding='6px';a.innerHTML='<div data-message-id="mid.virtual.'+next+'" aria-label="At 02:00, An: Tin ảo '+next+'"><h4 dir="auto">An</h4><span dir="auto"><div dir="auto">Tin ảo '+next+'</div></span><span dir="auto">Sent</span></div>';chat.append(a);next++;}chat.scrollTop+=120;if(performance.now()-start<ms)requestAnimationFrame(step);else done();})();});
window.longTasks=[];new PerformanceObserver(list=>{for(const entry of list.getEntries())window.longTasks.push(entry.duration);}).observe({entryTypes:['longtask']});
</script></body>`;
const mediaRows=n=>`<!doctype html><meta charset="utf-8"><body><div role="log" data-thread-id="20002">${Array.from({length:n},(_,i)=>`<div role="article"><div data-message-id="mid.media.${i}"><img alt="Open photo" width="10" src="${CDN}/p${i}.png"></div></div>`).join('')}</div><script>window.require=()=>({getID:()=> '10001'});</script></body>`;
const big=Buffer.alloc(7.5*1024*1024);png.copy(big);for(let i=64;i<big.length;i+=4096)big[i]=i&255;
const blobFixture=`<!doctype html><meta charset="utf-8"><body><div role="log" data-thread-id="20002" id="log"></div><script>window.require=()=>({getID:()=> '10001'});
window.addBlobPhoto=(i,size)=>{const b=new Uint8Array(size);b.set([137,80,78,71,13,10,26,10]);for(let n=64;n<b.length;n+=4096)b[n]=(n+i)&255;const url=URL.createObjectURL(new Blob([b],{type:'image/png'}));const a=document.createElement('div');a.setAttribute('role','article');a.innerHTML='<div data-message-id="mid.blob.'+i+'"><img alt="Open photo" width="10" src="'+url+'"></div>';document.getElementById('log').append(a);};
</script></body>`;

async function run(variant,round){
  const profile=path.join(root,'profiles',crypto.randomUUID());await mkdir(profile,{recursive:true});
  const port=9300+Math.floor(Math.random()*400);
  const context=await chromium.launchPersistentContext(profile,{executablePath:browser,headless:true,ignoreDefaultArgs:variant.extension?['--disable-extensions']:[],args:[...(variant.extension?[`--disable-extensions-except=${variant.extension}`,`--load-extension=${variant.extension}`]:[]),`--remote-debugging-port=${port}`,'--mute-audio'],viewport:{width:1100,height:700}});
  context.setDefaultTimeout(30000);
  await context.route(/^https?:\/\//,route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/media-fixture')return route.fulfill({contentType:'text/html',body:mediaRows(24)});
    if(url.pathname==='/blob-fixture')return route.fulfill({contentType:'text/html',body:blobFixture});
    if(url.hostname==='www.facebook.com')return route.fulfill({contentType:'text/html',body:fixture});
    if(url.hostname.endsWith('.fbcdn.net'))return route.fulfill({contentType:'image/png',body:png});
    return route.abort();
  });
  await context.addCookies([{name:'c_user',value:'10001',domain:'.facebook.com',path:'/',secure:true,sameSite:'Lax'}]);
  const result={};
  try{
    let worker=null,ui=null,rpc=null,workerHeap=async()=>null;
    if(variant.extension){
      worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
      ui=await context.newPage();await ui.goto(`chrome-extension://${new URL(worker.url()).hostname}/options.html`);
      rpc=m=>ui.evaluate(async m=>{const r=await chrome.runtime.sendMessage(m);if(!r?.ok)throw Error(r?.error);return r;},m);
      await rpc({type:'save',settings:{maxBytes:1024*1024*1024,maxMessages:100000,autoVoice:false}});
      const info=(await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t=>t.type==='service_worker');
      if(info){
        const socket=new WebSocket(info.webSocketDebuggerUrl);await new Promise((ok,no)=>{socket.onopen=ok;socket.onerror=no;});
        let id=0;const waiting=new Map();socket.onmessage=e=>{const m=JSON.parse(e.data);waiting.get(m.id)?.(m.result);waiting.delete(m.id);};
        const send=(method,params={})=>new Promise(ok=>{const n=++id;waiting.set(n,ok);socket.send(JSON.stringify({id:n,method,params}));});
        await send('Runtime.enable');
        workerHeap=async()=>{const usage=await send('Runtime.getHeapUsage');return usage.usedSize+(usage.backingStorageSize||0);};
        result.closeWorkerSocket=()=>socket.close();
      }
    }
    const page=await context.newPage(),cdp=await context.newCDPSession(page);await cdp.send('Performance.enable');await cdp.send('Runtime.enable');
    const tabMemory=async session=>{const usage=await session.send('Runtime.getHeapUsage');return usage.usedSize+(usage.backingStorageSize||0);};
    await page.goto('https://www.facebook.com/messages/t/20002/');
    if(rpc){for(let i=0;i<300;i++){if((await rpc({type:'status'})).stats.count>=COUNT)break;await sleep(100);}}
    else await sleep(1500);
    await sleep(1200);
    const metrics=async()=>Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m=>[m.name,m.value]));
    const scenario=async(name,start)=>{
      await page.evaluate(()=>{window.longTasks.length=0;});
      const before=await metrics();await page.evaluate(start,seconds*1000);await sleep(400);const after=await metrics();
      const tasks=await page.evaluate(()=>window.longTasks);
      result[name]={scriptMs:Math.round((after.ScriptDuration-before.ScriptDuration)*1000),taskMs:Math.round((after.TaskDuration-before.TaskDuration)*1000),layoutMs:Math.round((after.LayoutDuration-before.LayoutDuration)*1000),layouts:after.LayoutCount-before.LayoutCount,longTasks:tasks.length,longTaskMs:Math.round(tasks.reduce((a,b)=>a+b,0))};
    };
    await scenario('scroll',ms=>window.scrollChat(ms));
    await scenario('feedChurn',ms=>window.churnFeed(ms));
    // Closer to Messenger: rows are added and removed while the list scrolls.
    await scenario('virtualScroll',ms=>window.virtualScroll(ms));
    await cdp.send('HeapProfiler.collectGarbage');await sleep(300);
    result.tabHeapIdleMiB=Number(((await tabMemory(cdp))/1048576).toFixed(2));
    if(variant.extension){
      result.workerHeapIdleMiB=Number((((await workerHeap())||0)/1048576).toFixed(2));
      await worker.evaluate(()=>{const original=globalThis.fetch;globalThis.__perfFetches=0;globalThis.fetch=(input,init)=>{if(String(input).includes('pff-perf.invalid')){globalThis.__perfFetches++;return Promise.resolve(new Response(Uint8Array.from([137,80,78,71,13,10,26,10,...Array(5000).fill(7)])));}return original(input,init);};});
      const media=await context.newPage();await media.goto('https://www.facebook.com/media-fixture');
      const countBefore=(await rpc({type:'status'})).stats.count;
      for(let i=0;i<200;i++){if((await rpc({type:'status'})).stats.count>=countBefore+24)break;await sleep(100);}
      const first=await worker.evaluate(()=>globalThis.__perfFetches);
      for(let reload=0;reload<2;reload++){await media.reload();await sleep(2500);}
      result.mediaDownloads={firstVisit:first,afterTwoReloads:(await worker.evaluate(()=>globalThis.__perfFetches))-first};
      await media.close();
      // Peak memory while saving large page-decrypted photos.
      const blobPage=await context.newPage(),blobCdp=await context.newCDPSession(blobPage);await blobCdp.send('Runtime.enable');await blobPage.goto('https://www.facebook.com/blob-fixture');await sleep(800);
      const tabBefore=await tabMemory(blobCdp),workerBefore=(await workerHeap())||0;
      let tabPeak=0,workerPeak=0,sampling=true;
      const sampler=(async()=>{while(sampling){tabPeak=Math.max(tabPeak,await tabMemory(blobCdp));workerPeak=Math.max(workerPeak,(await workerHeap())||0);await sleep(15);}})();
      const stored=(await rpc({type:'status'})).stats.count;
      await blobPage.evaluate(()=>{for(let i=0;i<4;i++)window.addBlobPhoto(i,7.5*1024*1024);});
      for(let i=0;i<400;i++){if((await rpc({type:'status'})).stats.count>=stored+4)break;await sleep(100);}
      sampling=false;await sampler;
      // "Above start" still includes the 4 photos (30 MiB) that the fixture page itself allocates.
      result.largeMediaPeak={tabHeapMiB:Number((tabPeak/1048576).toFixed(1)),tabAboveStartMiB:Number(((tabPeak-tabBefore)/1048576).toFixed(1)),workerHeapMiB:Number((workerPeak/1048576).toFixed(1)),workerAboveStartMiB:Number(((workerPeak-workerBefore)/1048576).toFixed(1)),saved:(await rpc({type:'status'})).stats.count-stored};
      await blobPage.close();
      // Cleanup cost and how long a capture waits behind it on a full archive.
      const total=Number(process.env.PFF_PERF_ARCHIVE||20000);
      for(let batch=0;batch*64<total;batch++){
        const items=Array.from({length:64},(_,i)=>({account:'10001',thread:'20002',id:`mid.fill.${batch}.${i}`,token:`pff-${i+1}`,text:`Tin đệm ${batch}-${i}`}));
        await rpc({type:'observe',items});
      }
      const retention=(await rpc({type:'status'})).settings.retentionDays;
      const started=performance.now();let captureWait=null;
      const saving=rpc({type:'save',settings:{retentionDays:retention+1}});
      await sleep(30);
      const waited=performance.now();await rpc({type:'observe',items:[{account:'10001',thread:'20002',id:'mid.during',token:'pff-1',text:'trong khi dọn'}]});captureWait=Math.round(performance.now()-waited);
      await saving;
      const fullCleanupMs=Math.round(performance.now()-started);
      // A policy change that alters no record: every record is read, none rewritten.
      const idleStart=performance.now();await rpc({type:'save',settings:{voiceRetentionDays:3650}});
      result.maintenance={records:(await rpc({type:'status'})).stats.count,fullCleanupMs,captureWaitMs:captureWait,unchangedCleanupMs:Math.round(performance.now()-idleStart)};
    }
  }finally{
    result.closeWorkerSocket?.();delete result.closeWorkerSocket;
    await context.close();await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200}).catch(()=>{});
  }
  console.log(variant.name,'round',round,JSON.stringify(result));
  return result;
}
const collect=(runs,pick)=>median(runs.map(pick).filter(value=>value!=null));
const report={synthetic:true,primaryFacebookUsed:false,rounds,secondsPerScenario:seconds,rows:COUNT,createdAt:new Date().toISOString(),variants:{}};
for(const variant of variants){
  const runs=[];for(let round=1;round<=rounds;round++)runs.push(await run(variant,round));
  const summary={};
  for(const scenario of ['scroll','feedChurn','virtualScroll'])summary[scenario]=Object.fromEntries(Object.keys(runs[0][scenario]).map(key=>[key,collect(runs,r=>r[scenario][key])]));
  summary.tabHeapIdleMiB=collect(runs,r=>r.tabHeapIdleMiB);
  if(variant.extension){
    summary.workerHeapIdleMiB=collect(runs,r=>r.workerHeapIdleMiB);
    summary.mediaDownloads={firstVisit:collect(runs,r=>r.mediaDownloads.firstVisit),afterTwoReloads:collect(runs,r=>r.mediaDownloads.afterTwoReloads)};
    summary.largeMediaPeak=Object.fromEntries(Object.keys(runs[0].largeMediaPeak).map(key=>[key,collect(runs,r=>r.largeMediaPeak[key])]));
    summary.maintenance=Object.fromEntries(Object.keys(runs[0].maintenance).map(key=>[key,collect(runs,r=>r.maintenance[key])]));
  }
  report.variants[variant.name]=summary;
}
await mkdir(root,{recursive:true});await writeFile(path.join(root,`${label}.json`),JSON.stringify(report,null,2));
console.log(JSON.stringify(report.variants,null,1));
