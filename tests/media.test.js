import 'fake-indexeddb/auto';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Archive} from '../src/archive.js';
import {DEFAULTS,DAY} from '../src/shared.js';
import {allowedMediaURL,detectedMime,encodeBase64,decodeBase64,emojiOnly,readMedia,MAX_ASSET_BYTES} from '../src/media.js';

const png=Uint8Array.from([137,80,78,71,13,10,26,10,...Array(40).fill(0)]);
const wav=Uint8Array.from([...new TextEncoder().encode('RIFF'),0,0,0,0,...new TextEncoder().encode('WAVE'),...Array(48).fill(0)]);
const create=()=>new Archive(`media-${crypto.randomUUID()}`);
const message=(id,assets)=>({account:'10001',thread:'by-message-id',id,text:'',assets,token:'pff-1'});
const removed=(id,extra={})=>({...message(id),removed:true,...extra});

test('emoji image alt can represent single, joined, flags and keycap emoji without accepting ordinary alt text',()=>{
  for(const text of ['😀','👨‍👩‍👧‍👦','🇻🇳','👍🏽','1️⃣'])assert.equal(emojiOnly(text),true,text);
  for(const text of ['', 'Open photo','Sent','Xin chào 😀','123'])assert.equal(emojiOnly(text),false,text);
});
test('media URL and content validation excludes arbitrary sites, credentials, SVG, video and type spoofing',()=>{
  for(const url of ['https://scontent.xx.fbcdn.net/photo.jpg','https://cdn.fbsbx.com/voice','blob:https://www.facebook.com/id','data:image/png;base64,iVBORw=='])assert.equal(allowedMediaURL(url),true,url);
  for(const url of ['https://evil.example/x','https://fbcdn.net.evil.example/x','https://user:pass@cdn.fbsbx.com/x','http://cdn.fbsbx.com/x','blob:https://evil.example/id','data:image/svg+xml;base64,PHN2Zz4=','data:video/mp4;base64,AAAA'])assert.equal(allowedMediaURL(url),false,url);
  assert.equal(detectedMime(new TextEncoder().encode('<script>alert(1)</script>'),'image/png','image'),null);
  assert.equal(detectedMime(wav,'audio/wav','video'),null);
  assert.equal(detectedMime(png,'application/octet-stream','image'),'image/png');
});
test('base64 binary transport is lossless and rejects malformed data',()=>{
  const bytes=crypto.getRandomValues(new Uint8Array(4096));assert.deepEqual(decodeBase64(encodeBase64(bytes)),bytes);
  assert.throws(()=>decodeBase64('<svg>'));
});
test('image and voice binaries survive removal, aliases and reopening without returning Blob through JSON RPC',async()=>{
  const db=create();await db.ingest([message('msgr.1111111111111111',[{kind:'image',mime:'image/png',data:png},{kind:'voice',mime:'audio/wav',data:wav}])],DEFAULTS);
  const firstBytes=(await db.stats()).bytes;
  await db.ingest([message('msgr.1111111111111111',[{kind:'image',mime:'image/png',data:png},{kind:'voice',mime:'audio/wav',data:wav}])],DEFAULTS);
  assert.equal((await db.stats()).bytes,firstBytes);
  const result=await db.ingest([removed('msgr.1111111111111111',{tombstoneId:'msgr.2222222222222222'})],DEFAULTS);
  assert.equal(result[0].assets.length,2);assert.equal('blob' in result[0].assets[0],false);
  assert.equal('data' in result[0].assets[0],false);assert.ok(firstBytes>=png.length+wav.length);
  const reopened=new Archive(db.name);
  for(const [index,bytes] of [png,wav].entries()){
    const chunk=await reopened.assetChunk({account:'10001',thread:'by-message-id',id:'msgr.2222222222222222',index,offset:0});
    assert.deepEqual(decodeBase64(chunk.data),bytes);assert.equal(chunk.done,true);
  }
  await assert.rejects(()=>reopened.assetChunk({account:'99999',thread:'by-message-id',id:'msgr.2222222222222222',index:0}));
  await reopened.clear();await assert.rejects(()=>reopened.assetChunk({account:'10001',thread:'by-message-id',id:'msgr.2222222222222222',index:0}));
});
test('media bytes participate in eviction and TTL; unsupported/oversize assets are not archived',async()=>{
  const db=create(),data=new Uint8Array(1500);data.set(png.subarray(0,8));
  const config={...DEFAULTS,maxBytes:3000};
  await db.ingest(Array.from({length:5},(_,i)=>message(`mid.image.${i}`,[{kind:'image',data,mime:'image/png'}])),config);
  const stats=await db.stats();assert.ok(stats.bytes<=3000);assert.ok(stats.evicted>=4);
  assert.deepEqual(await db.ingest([removed('mid.image.0')],config),[]);
  const bad=new Uint8Array(MAX_ASSET_BYTES+1);bad.set(png);
  await db.ingest([message('mid.bad',[{kind:'image',mime:'image/png',data:bad}])],config);
  assert.deepEqual(await db.ingest([removed('mid.bad')],config),[]);
  const expires=create(),now=Date.now();await expires.ingest([message('mid.expires',[{kind:'voice',mime:'audio/wav',data:wav}])],{...DEFAULTS,retentionDays:1},now);
  await expires.maintain({...DEFAULTS,retentionDays:1},now+DAY+1);assert.equal((await expires.stats()).count,0);
});
test('streaming fetch reads supported binary and cancels payloads over the fixed cap',async()=>{
  assert.equal((await readMedia(new Response(png,{headers:{'content-type':'image/png'}}),'image')).mime,'image/png');
  await assert.rejects(()=>readMedia(new Response(png,{headers:{'content-length':String(MAX_ASSET_BYTES+1)}}),'image'));
  await assert.rejects(()=>readMedia(new Response('not an image',{headers:{'content-type':'image/png'}}),'image'));
});
test('partial caption rerenders and failed media refreshes preserve already captured binary without duplicate storage',async()=>{
  const db=create(),original={...message('mid.partial',[{kind:'image',mime:'image/png',data:png}]),text:'Caption đầu'};
  await db.ingest([original],DEFAULTS);
  await db.ingest([{...original,text:'Caption đã sửa',assets:[]}],DEFAULTS);
  const bytes=(await db.stats()).bytes;
  await db.ingest([{...original,text:'Caption đã sửa',assets:[]}],DEFAULTS);
  assert.equal((await db.stats()).bytes,bytes);assert.equal((await db.stats()).count,1);
  const [restored]=await db.ingest([removed('mid.partial')],DEFAULTS);
  assert.equal(restored.text,'Caption đã sửa');assert.equal(restored.assets.length,1);
  const chunk=await db.assetChunk({account:'10001',thread:'by-message-id',id:'mid.partial',index:0});
  assert.deepEqual(decodeBase64(chunk.data),png);
});

test('per-type cleanup preserves text/other media, protects recalled files and prevents recapture',async()=>{
  const db=create(),now=Date.now(),config={...DEFAULTS,retentionDays:0,cleanupRemoved:false};
  const assets=[{kind:'image',mime:'image/png',data:png},{kind:'voice',mime:'audio/wav',data:wav}];
  await db.ingest([{...message('mid.protected',assets),text:'Caption'},message('mid.normal',assets)],config,now-3*DAY);
  await db.ingest([removed('mid.protected')],config,now-2*DAY);
  const result=await db.purgeMedia('image',0,false,config,now);assert.equal(result.files,1);
  let record=(await db.ingest([removed('mid.protected')],config,now))[0];assert.equal(record.assets.length,2);assert.equal(record.text,'Caption');
  assert.ok((await db.capturePolicy(message('mid.normal'),config)).skipKinds.includes('image'));
  await db.ingest([message('mid.normal',assets)],config,now);
  record=(await db.ingest([removed('mid.normal')],config,now))[0];assert.deepEqual(record.assets.map(a=>a.kind),['voice']);
  const forced=await db.purgeMedia('image',2,true,config,now);assert.equal(forced.files,1);
  record=(await db.ingest([removed('mid.protected')],config,now))[0];assert.equal(record.text,'Caption');assert.deepEqual(record.assets.map(a=>a.kind),['voice']);
  await db.maintain({...config,voiceRetentionDays:1},now,true);assert.equal((await db.ingest([removed('mid.protected')],config,now))[0].assets.length,1);
  await db.maintain({...config,cleanupRemoved:true,voiceRetentionDays:1},now,true);
  record=(await db.ingest([removed('mid.normal')],config,now))[0];assert.equal(record.assets.length,0);assert.match(record.text,/dọn/);
});

test('incremental album observations merge by position without duplicate bytes or losing earlier photos',async()=>{
  const db=create(),a={kind:'image',mime:'image/png',data:png,position:0},b={...a,position:1,data:Uint8Array.from([...png,42])};
  await db.ingest([message('mid.album',[a])],DEFAULTS);
  await db.ingest([message('mid.album',[b])],DEFAULTS);
  const bytes=(await db.stats()).bytes;
  await db.ingest([message('mid.album',[b])],DEFAULTS);assert.equal((await db.stats()).bytes,bytes);
  const [record]=await db.ingest([removed('mid.album')],DEFAULTS);assert.equal(record.assets.length,2);
  assert.notEqual(record.assets[0].digest,record.assets[1].digest);
});
