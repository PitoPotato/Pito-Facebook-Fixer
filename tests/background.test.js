import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/shared.js";

const id="abcdefghijklmnopabcdefghijklmnop";
let receive,startup,installed;
let persisted={settings:{...DEFAULTS},settingsRevision:0};const storageListeners=[];
globalThis.chrome={
  runtime:{id,getURL:path=>`chrome-extension://${id}/${path}`,sendMessage:async()=>{},
    onMessage:{addListener:fn=>{receive=fn;}},onInstalled:{addListener:fn=>{installed=fn;}},onStartup:{addListener:fn=>{startup=fn;}}},
  storage:{onChanged:{addListener:fn=>storageListeners.push(fn)},local:{get:async()=>structuredClone(persisted),set:async values=>{const changes={};for(const [key,value] of Object.entries(values)){changes[key]={oldValue:persisted[key],newValue:value};persisted[key]=structuredClone(value);}for(const listener of storageListeners)listener(changes,'local');},setAccessLevel:async()=>{}}},
  tabs:{query:async()=>[],sendMessage:async()=>{}},alarms:{create:async()=>{},onAlarm:{addListener:()=>{}}},
};
await import("../src/background.js");
const owner={id,url:`chrome-extension://${id}/options.html`,origin:`chrome-extension://${id}`};
const page={id,tab:{id:7,url:"https://www.facebook.com/"},url:"https://www.facebook.com/messages/t/20002/",origin:"https://www.facebook.com"};
const rpc=(message,sender=page)=>new Promise(resolve=>receive(message,sender,resolve));
const item={account:"10001",thread:"20002",id:"mid.regression",text:"Tin phải được ghi trước lúc thu hồi",token:"pff-1"};

test("regression: observed message goes through background to storage with absent frameId", async()=>{
  await rpc({type:"clear"},owner);
  assert.equal((await rpc({type:"config"})).ok,true);
  assert.equal((await rpc({type:"observe",items:[item]})).ok,true);
  const stored=await rpc({type:"status"},owner);
  assert.equal(stored.stats.count,1);
  const removed=await rpc({type:"observe",items:[{...item,removed:true,text:undefined,token:"pff-2"}]});
  assert.equal(removed.ok,true);assert.equal(removed.restored.length,1);
  assert.equal(removed.restored[0].text,item.text);assert.equal(removed.restored[0].token,"pff-2");
});
test("origin-only page metadata can store; frames cannot access extension administration",async()=>{
  assert.equal((await rpc({type:"config"},{...page,url:undefined,frameId:9})).ok,true);
  for(const type of ["status","list","clear","save","purgeMedia"]) assert.equal((await rpc({type,settings:DEFAULTS},page)).ok,false);
});
test("source rejection carries useful metadata rather than silently dropping the message",async()=>{
  const result=await rpc({type:"observe",items:[item]},{...page,url:"https://evil.example/",origin:"https://evil.example"});
  assert.equal(result.ok,false);assert.equal(result.code,"PFF_SOURCE_REJECTED");
  assert.equal(result.diagnostics.reason,"document_url");
  assert.equal((await rpc({type:"status"},owner)).stats.count,1);
});
test("unrelated notifications never claim the RPC response channel",()=>{
  let responded=false;
  assert.equal(receive({type:"archiveStats"},owner,()=>{responded=true;}),undefined);
  assert.equal(responded,false);
});

test("unmatched removal diagnostics distinguish missing identity from a successful archive lookup without message text",async()=>{
  const missing={...item,id:'mid.not-captured',text:undefined,removed:true,token:'pff-missing'};
  const result=await rpc({type:'observe',items:[missing,{...item,text:undefined,removed:true,token:'pff-found'}]});
  assert.equal(result.ok,true);
  assert.deepEqual(result.unmatched,[{account:item.account,thread:item.thread,id:missing.id,token:missing.token}]);
  assert.equal(result.restored.length,1);
  assert.equal(result.restored[0].token,'pff-found');
  assert.equal(JSON.stringify(result.unmatched).includes(item.text),false);
});

test('saving independent patches concurrently preserves other preferences and increases revisions',async()=>{
  const before=await rpc({type:'save',settings:{maxBytes:128*1024*1024,retentionDays:47}},owner);
  const [a,b]=await Promise.all([rpc({type:'save',settings:{focusGuard:false}},owner),rpc({type:'save',settings:{archive:false}},owner)]);
  assert.ok(a.settingsRevision>before.settingsRevision);assert.ok(b.settingsRevision>a.settingsRevision);
  const current=await rpc({type:'config'});assert.equal(current.settings.focusGuard,false);assert.equal(current.settings.archive,false);assert.equal(current.settings.retentionDays,47);assert.equal(current.settings.maxBytes,128*1024*1024);
});

test('startup and installation migrations cannot overwrite a newer save; legacy story setting is suspended',async()=>{
  persisted.settings={...persisted.settings,blockStory:true,theme:'dark'};
  startup();const saved=await rpc({type:'save',settings:{focusGuard:true,retentionDays:19}},owner);
  installed();await rpc({type:'status'},owner);
  assert.equal(persisted.settings.focusGuard,true);assert.equal(persisted.settings.retentionDays,19);assert.equal(persisted.settings.theme,'dark');assert.equal(persisted.settings.blockStory,false);assert.ok(persisted.settingsRevision>=saved.settingsRevision);
});
