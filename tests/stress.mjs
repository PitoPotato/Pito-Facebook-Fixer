import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir,rm,writeFile } from "node:fs/promises";
import path from "node:path";

const root=path.resolve("test-results/stress-profiles");
const profile=path.join(root,crypto.randomUUID());await mkdir(profile,{recursive:true});
const extension=path.resolve("dist");
const executable=process.env.PFF_TEST_BROWSER||path.resolve("test-results/browser/chrome-win/chrome.exe");
const launch=()=>chromium.launchPersistentContext(profile,{executablePath:executable,headless:true,
  ignoreDefaultArgs:["--disable-extensions"],args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
let context;
const report={syntheticMessages:0,snapshots:[],primaryFacebookUsed:false,realFacebookNetworkUsed:false};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,message){for(let n=0;n<100;n++){if(await fn())return;await wait(100);}throw Error(message);}
try {
  context=await launch();
  await context.route(/^https?:\/\//,route=>route.fulfill({contentType:"text/html",body:'<!doctype html><html><meta charset="utf-8"><body><div role="log" data-thread-id="20002" id="log"></div></body></html>'}));
  await context.addCookies([{name:"c_user",value:"10001",domain:".facebook.com",path:"/",secure:true,sameSite:"Lax"}]);
  const worker=context.serviceWorkers()[0]||await context.waitForEvent("serviceworker");
  const id=new URL(worker.url()).hostname;
  const ui=await context.newPage();await ui.goto(`chrome-extension://${id}/options.html`);
  const rpc=message=>ui.evaluate(async message=>{const r=await chrome.runtime.sendMessage(message);if(!r.ok)throw Error(r.error);return r;},message);
  const config=(await rpc({type:"status"})).settings;
  await rpc({type:"save",settings:{...config,maxMessages:100,maxBytes:2097152,retentionDays:1}});
  const page=await context.newPage();await page.goto("https://www.facebook.com/messages/t/20002/");
  for(let round=0;round<16;round++) {
    await page.evaluate(round=>{
      const log=document.getElementById("log");
      for(let i=0;i<32;i++){
        const row=document.createElement("div");row.dataset.messageId=`mid.stress.${round*32+i}`;
        const text=document.createElement("span");text.dir="auto";
        text.textContent=`Tin kiểm thử ${round*32+i}: `+"Nội dung dài có dấu 🐈. ".repeat(250);
        row.append(text);log.append(row);
      }
      while(log.children.length>40)log.firstElementChild.remove();
    },round);
    // Wait for an actual IndexedDB record via extension RPC, not a DOM counter.
    const latest=`mid.stress.${round*32+31}`;
    await until(async()=>{
      const status=await ui.evaluate(async tabId=>chrome.tabs.sendMessage(tabId,{type:"tabStatus"}),
        (await ui.evaluate(async()=>{const tabs=await chrome.tabs.query({url:"https://www.facebook.com/*"});return tabs[0].id;})));
      if(status.error)throw Error(status.error);
      return status.counters.messagesObserved>=(round+1)*32&&status.savedBatches>=round+1;
    },"Failed to write stress batch to the archive");
    const stats=(await rpc({type:"status"})).stats;
    assert.ok(stats.count<=100);assert.ok(stats.bytes<=2097152);
    report.syntheticMessages+=32;report.snapshots.push({round,count:stats.count,bytes:stats.bytes,evicted:stats.evicted});
    if(round===15){
      await page.evaluate(id=>{const row=document.querySelector(`[data-message-id="${id}"]`);row.textContent="Người thử đã xóa một tin nhắn";},latest);
      await page.waitForSelector(`[data-message-id="${latest}"]:is([data-pff-restored],:has([data-pff-restored]))`);
    }
  }
  assert.ok(report.snapshots.at(-1).evicted>400);
  const saved=(await rpc({type:"list"})).rows;
  assert.ok(saved.some(row=>row.id==="mid.stress.511"));
  await context.close();context=await launch();
  const restartedWorker=context.serviceWorkers()[0]||await context.waitForEvent("serviceworker");
  const ui2=await context.newPage();await ui2.goto(`chrome-extension://${new URL(restartedWorker.url()).hostname}/options.html`);
  const persisted=await ui2.evaluate(async()=>chrome.runtime.sendMessage({type:"list"}));
  assert.ok(persisted.rows.some(row=>row.id==="mid.stress.511"));
  report.restartPersistencePassed=true;report.passed=true;
  await writeFile("test-results/stress-report.json",JSON.stringify(report,null,2));
  console.log("PASS 512 messages through the real extension; all 16 checkpoints bounded; newest unsent text survives browser restart");
}finally{
  await context?.close();
  if(path.resolve(profile).startsWith(root+path.sep))await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
