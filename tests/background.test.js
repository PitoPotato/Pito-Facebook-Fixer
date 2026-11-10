import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/shared.js";

const id="abcdefghijklmnopabcdefghijklmnop";
let receive,startup,installed;
let persisted={settings:{...DEFAULTS},settingsRevision:0};const storageListeners=[],session={};
globalThis.chrome={
  runtime:{id,getURL:path=>`chrome-extension://${id}/${path}`,sendMessage:async()=>{},
    onMessage:{addListener:fn=>{receive=fn;}},onInstalled:{addListener:fn=>{installed=fn;}},onStartup:{addListener:fn=>{startup=fn;}}},
  storage:{onChanged:{addListener:fn=>storageListeners.push(fn)},local:{get:async()=>structuredClone(persisted),set:async values=>{const changes={};for(const [key,value] of Object.entries(values)){changes[key]={oldValue:persisted[key],newValue:value};persisted[key]=structuredClone(value);}for(const listener of storageListeners)listener(changes,'local');},setAccessLevel:async()=>{}},
    session:{get:async key=>({[key]:session[key]}),set:async values=>{Object.assign(session,values);},remove:async key=>{delete session[key];}}},
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
  for(const type of ["status","list","clear","save","purgeMedia","vaultStatus","vaultEnable","vaultUnlock","vaultLock","vaultDisable","vaultMigrate","archiveImported"]) assert.equal((await rpc({type,settings:DEFAULTS,password:"password one"},page)).ok,false,type);
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

const png=Uint8Array.from([137,80,78,71,13,10,26,10,...Array(2500000).fill(5)]);
const base64=bytes=>Buffer.from(bytes).toString('base64');
const uploadId=()=>crypto.randomUUID();
const CHUNK=1024*1024;
async function upload(bytes,sender=page,id=uploadId()){
  for(let offset=0;offset<bytes.length;offset+=CHUNK){
    const result=await rpc({type:'assetUpload',uploadId:id,offset,total:bytes.length,data:base64(bytes.subarray(offset,offset+CHUNK))},sender);
    if(!result.ok)return {id,result};
  }
  return {id,result:{ok:true}};
}
const media=(id,upload,extra={})=>({account:'10001',thread:'20002',id,token:'pff-9',text:'',media:[{kind:'image',url:'blob:https://www.facebook.com/x',position:0,upload,...extra}]});

test('page media arrives in chunks and is stored once complete',async()=>{
  await rpc({type:'save',settings:{archive:true}},owner);
  const {id}=await upload(png);
  const saved=await rpc({type:'observe',items:[media('mid.upload',id)]});
  assert.equal(saved.ok,true);assert.equal(saved.mediaSaved,1);assert.equal(saved.mediaFailed,0);
  const removed=await rpc({type:'observe',items:[{account:'10001',thread:'20002',id:'mid.upload',token:'pff-10',removed:true}]});
  assert.equal(removed.restored[0].assets[0].size,png.length);
});
test('another tab cannot use an upload, and incomplete or out-of-order uploads are refused',async()=>{
  const {id}=await upload(png);
  const other={...page,tab:{id:8,url:page.tab.url}};
  assert.equal((await rpc({type:'observe',items:[media('mid.stolen',id)]},other)).mediaFailed,1);
  const partial=uploadId();
  assert.equal((await rpc({type:'assetUpload',uploadId:partial,offset:0,total:png.length,data:base64(png.subarray(0,CHUNK))})).ok,true);
  assert.equal((await rpc({type:'observe',items:[media('mid.partial',partial)]})).mediaFailed,1);
  assert.equal((await rpc({type:'assetUpload',uploadId:partial,offset:CHUNK*2,total:png.length,data:base64(png.subarray(0,CHUNK))})).ok,false);
  assert.equal((await rpc({type:'assetUpload',uploadId:uploadId(),offset:CHUNK,total:png.length,data:base64(png.subarray(0,CHUNK))})).ok,false,'must start at zero');
  assert.equal((await rpc({type:'assetUpload',uploadId:'not-a-uuid',offset:0,total:8,data:base64(png.subarray(0,8))})).ok,false);
  assert.equal((await rpc({type:'assetUpload',uploadId:uploadId(),offset:0,total:65*1024*1024,data:base64(png.subarray(0,8))})).ok,false,'over the absolute limit');
  const foreign=await rpc({type:'assetUpload',uploadId:uploadId(),offset:0,total:8,data:base64(png.subarray(0,8))},{...page,url:'https://evil.example/',origin:'https://evil.example'});
  assert.equal(foreign.ok,false);assert.equal(foreign.code,'PFF_SOURCE_REJECTED');
});
test('an upload that fails type detection or the kind limit is not stored',async()=>{
  const {id}=await upload(new TextEncoder().encode('<svg onload=alert(1)>'.repeat(10)));
  assert.equal((await rpc({type:'observe',items:[media('mid.fake',id)]})).mediaFailed,1);
  const big=new Uint8Array(9*1024*1024);big.set(png.subarray(0,8));
  const large=await upload(big);
  assert.equal((await rpc({type:'observe',items:[media('mid.large',large.id)]})).mediaFailed,1);
});
test('capture switches are enforced by the worker even if a page sends the media',async()=>{
  await rpc({type:'save',settings:{saveStickers:false,saveFiles:false,saveVideo:false}},owner);
  for(const extra of [{subtype:'sticker'},{subtype:'gif'},{kind:'file'},{kind:'video'}]){
    const {id}=await upload(png);
    const result=await rpc({type:'observe',items:[media(`mid.off.${extra.kind||extra.subtype}`,id,extra)]});
    assert.equal(result.mediaSaved,0,JSON.stringify(extra));assert.equal(result.mediaFailed,0,JSON.stringify(extra));
  }
  await rpc({type:'save',settings:{saveStickers:true,saveFiles:true}},owner);
});
test('the owner page reads any stored asset; a Facebook page reads only recalled ones',async()=>{
  const {id}=await upload(png);await rpc({type:'observe',items:[media('mid.owner',id)]});
  const request={type:'asset',account:'10001',thread:'20002',id:'mid.owner',index:0,offset:0};
  assert.equal((await rpc(request,owner)).ok,true);assert.equal((await rpc(request,page)).ok,false);
});
test('the password lock is available through the owner page, with the key kept in session storage',async()=>{
  assert.equal((await rpc({type:'vaultEnable',password:'password one'},owner)).unlocked,true);
  assert.ok(session.vaultKey);assert.equal(JSON.stringify(persisted).includes(session.vaultKey),false);
  assert.equal((await rpc({type:'vaultLock'},owner)).unlocked,false);assert.equal(session.vaultKey,undefined);
  assert.equal((await rpc({type:'vaultUnlock',password:'wrong password'},owner)).error,'errWrongPassword');
  assert.equal((await rpc({type:'vaultDisable',password:'password one'},owner)).disabling,true);
  let after=null,last;do{last=await rpc({type:'vaultMigrate',after},owner);assert.equal(last.ok,true);after=last.next;}while(after);
  assert.equal(last.vault.enabled,false);
});

test('a CDN file already saved is not fetched again, even when its signed URL changes',async()=>{
  const realFetch=globalThis.fetch;let fetches=0;
  globalThis.fetch=async()=>{fetches++;return new Response(png.subarray(0,5000));};
  try{
    const send=(id,url)=>rpc({type:'observe',items:[{account:'10001',thread:'20002',id,token:'pff-11',text:'',media:[{kind:'image',url,position:0}]}]});
    assert.equal((await send('mid.cdn','https://a.fbcdn.net/v/p.png?stp=small&oh=one&oe=1')).mediaSaved,1);assert.equal(fetches,1);
    assert.equal((await send('mid.cdn','https://b.fbcdn.net/v/p.png?stp=small&oh=two&oe=2')).mediaSaved,0);assert.equal(fetches,1,'rotated signature');
    await send('mid.cdn','https://a.fbcdn.net/v/p.png?stp=large&oh=three');assert.equal(fetches,2,'a different size is a different file');
  }finally{globalThis.fetch=realFetch;}
});
test('cleanup does not hold the queue: a capture commits while a long cleanup is running',async()=>{
  await rpc({type:'clear'},owner);await rpc({type:'save',settings:{maxBytes:1024*1024*1024,maxMessages:100000}},owner);
  for(let batch=0;batch<40;batch++)await rpc({type:'observe',items:Array.from({length:64},(_,i)=>({account:'10001',thread:'20002',id:`mid.bulk.${batch}.${i}`,token:'pff-1',text:'x'}))});
  let cleaned=false;
  const cleaning=rpc({type:'save',settings:{retentionDays:123}},owner).then(result=>{cleaned=true;return result;});
  await new Promise(resolve=>setTimeout(resolve,1));
  const captured=await rpc({type:'observe',items:[{account:'10001',thread:'20002',id:'mid.during',token:'pff-1',text:'giữa lúc dọn'}]});
  assert.equal(captured.ok,true);assert.equal(cleaned,false,'the capture finished before the whole cleanup');
  assert.equal((await cleaning).maintenanceError,null);
});
