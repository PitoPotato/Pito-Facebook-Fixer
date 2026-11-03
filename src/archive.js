import { DAY, MAX_BATCH, MAX_TEXT, validId } from "./shared.js";
import {MAX_ASSETS,MAX_ASSET_BYTES,MAX_MESSAGE_MEDIA_BYTES,ASSET_CHUNK_BYTES,detectedMime,assetSummary,encodeBase64} from './media.js';

const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
});
const finished = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  tx.onerror = () => {}; // Abort handler owns the rejection.
});
const emptyStats = () => ({ count: 0, bytes: 0, removed: 0, removedBytes: 0, evicted: 0, rejected: 0, mediaPurged: 0, capacityBlocked: false, lastCleanup: 0 });
const protectedRow = (row, settings) => row.removedAt && settings.cleanupRemoved === false;
const expiry = (row, settings) => protectedRow(row, settings) || !settings.retentionDays ? Number.MAX_SAFE_INTEGER : row.capturedAt + settings.retentionDays * DAY;
const displayText = async row => (await unpack(row)) || (row.purgedKinds?.length ? 'Tệp phương tiện đã được dọn khỏi kho.' : '');
async function loadStats(meta, store) {
  const stats = {...emptyStats(), ...await request(meta.get('stats'))};
  // Version 4 archives have no protected-byte counter. Migrate metadata once.
  if ((await request(meta.get('policyVersion'))) !== 1) {
    stats.removedBytes = 0;
    await new Promise((resolve, reject) => { const req=store.openCursor(); req.onerror=()=>reject(req.error); req.onsuccess=()=>{const c=req.result;if(!c)return resolve();if(c.value.removedAt)stats.removedBytes+=c.value.bytes;c.continue();}; });
    meta.put(1, 'policyVersion');
  }
  return stats;
}
const encoder = new TextEncoder();
const sha = async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
const recordBytes = record => record.data.byteLength+(record.assets||[]).reduce((sum,asset)=>sum+asset.blob.size,0)+
  encoder.encode(JSON.stringify({...record,data:null,bytes:0,assets:record.assets?.map(asset=>({...asset,blob:null}))})).byteLength+512;

export async function pack(text) {
  const raw = encoder.encode(text.slice(0, MAX_TEXT));
  if (raw.length >= 1024 && typeof CompressionStream === "function") {
    const compressed = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    if (compressed.length + 32 < raw.length) return { data: compressed, codec: "gzip" };
  }
  return { data: raw, codec: "utf8" };
}
export async function unpack(record) {
  if (record.codec === "gzip") {
    return new Response(new Blob([record.data]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
  }
  return new TextDecoder().decode(record.data);
}
export function validObservation(item) {
  return item && validId(item.account) && /^\d+$/.test(item.account) && validId(item.thread) && validId(item.id)
    && (item.removed === true || (typeof item.text === "string" && item.text.length > 0 && item.text.length <= MAX_TEXT)
      || (Array.isArray(item.media)&&item.media.length>0&&item.media.length<=MAX_ASSETS)
      || (Array.isArray(item.assets)&&item.assets.length>0&&item.assets.length<=MAX_ASSETS));
}

export class Archive {
  constructor(name = "pito-message-archive-v1") { this.name = name; }
  async open() {
    if (!this.dbPromise) this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 4);
      req.onupgradeneeded = () => {
        const store = req.result.objectStoreNames.contains("messages") ? req.transaction.objectStore("messages") :
          req.result.createObjectStore("messages", { keyPath: ["account", "thread", "id"] });
        if (!store.indexNames.contains("capturedAt")) store.createIndex("capturedAt", "capturedAt");
        if (!store.indexNames.contains("expiresAt")) store.createIndex("expiresAt", "expiresAt");
        if (!store.indexNames.contains("removedAt")) store.createIndex("removedAt", ["removedAt", "account", "thread", "id"]);
        if (!store.indexNames.contains("accountMessage")) store.createIndex("accountMessage", ["account", "id"]);
        if (!store.indexNames.contains("aliases")) store.createIndex("aliases", "aliasKeys", { multiEntry: true });
        if (!req.result.objectStoreNames.contains("meta")) req.result.createObjectStore("meta");
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => { req.result.close(); this.dbPromise = null; };
        resolve(req.result);
      };
      req.onerror = () => { this.dbPromise = null; reject(req.error); };
    });
    return this.dbPromise;
  }
  async ingest(items, settings, now = Date.now()) {
    if (!settings.archive) return [];
    const prepared = [];
    for (const item of items.slice(0, MAX_BATCH)) {
      if (!validObservation(item)) continue;
      if (item.removed) { prepared.push(item); continue; }
      const text = (item.text||'').slice(0, MAX_TEXT),assets=[];let total=0;
      for(const asset of (item.assets||[]).slice(0,MAX_ASSETS)){
        if(!(asset.data instanceof Uint8Array)||!asset.data.byteLength||asset.data.byteLength>MAX_ASSET_BYTES)continue;
        total+=asset.data.byteLength;if(total>MAX_MESSAGE_MEDIA_BYTES)break;
        const mime=detectedMime(asset.data,asset.mime,asset.kind);if(!mime)continue;
        assets.push({kind:asset.kind,mime,position:Number.isInteger(asset.position)&&asset.position>=0&&asset.position<MAX_ASSETS?asset.position:assets.length,capturedAt:now,blob:new Blob([asset.data],{type:mime}),digest:await sha(asset.data)});
      }
      if(!text.trim()&&!assets.length)continue;
      const textDigest=await sha(encoder.encode(text));
      prepared.push({ ...item, assets, ...(await pack(text)), textDigest });
    }
    const db = await this.open();
    const tx = db.transaction(["messages", "meta"], "readwrite");
    const done = finished(tx);
    try {
      const store = tx.objectStore("messages"), meta = tx.objectStore("meta");
      const stats = await loadStats(meta, store);
      const restored = [];
      for (const item of prepared) {
        let key = [item.account, item.thread, item.id];
        let old = await request(store.get(key));
        if (!old && item.removed) {
          const candidates = await request(store.index("aliases").getAll(JSON.stringify([item.account, item.id]), 2));
          if (candidates.length === 1) { old = candidates[0]; key = [old.account, old.thread, old.id]; }
        }
        if (!old && /^mid\./.test(item.id)) {
          const candidates = (await request(store.index("accountMessage").getAll([item.account, item.id], 3)))
            .filter(row => row.thread === "by-message-id" || item.thread === "by-message-id");
          // Only cross the popup/full-page boundary for an unambiguous global
          // Facebook message ID. Never match a title, timestamp or message text.
          if (candidates.length === 1) { old = candidates[0]; key = [old.account, old.thread, old.id]; }
        }
        if (old && old.expiresAt <= now && !protectedRow(old, settings)) {
          store.delete(key); stats.count--; stats.bytes -= old.bytes;
          if (old.removedAt) {stats.removed--;stats.removedBytes-=old.bytes;} stats.evicted++; old = null;
        }
        if (item.removed) {
          // A tombstone without an earlier capture cannot manufacture content.
          if (!old) continue;
          const previousRemovedBytes=old.removedAt?old.bytes:0,previousBytes=old.bytes;
          if (!old.removedAt) { old.removedAt = now; stats.removed++; }
          old.expiresAt=expiry(old,settings);
          if (validId(item.tombstoneId) && item.tombstoneId !== old.id) {
            old.aliases = [...new Set([...(old.aliases || []), item.tombstoneId])].slice(-4);
            old.aliasKeys = old.aliases.map(id => JSON.stringify([old.account, id]));
          }
          old.bytes=recordBytes(old);stats.bytes+=old.bytes-previousBytes;stats.removedBytes+=old.bytes-previousRemovedBytes;
          store.put(old);
          restored.push({ ...old, token: item.token, responseThread: item.thread, responseId: item.id });
          continue;
        }
        if(stats.capacityBlocked&&settings.cleanupRemoved===false){stats.rejected++;continue;}
        // A rerender or a failed re-download can temporarily omit media while
        // leaving the caption. Never erase an already captured binary then.
        const assets=(old?.assets||[]).map((a,index)=>({...a,position:a.position??index,capturedAt:a.capturedAt??old.capturedAt}));
        for(const incoming of item.assets){
          if(old?.purgedKinds?.includes(incoming.kind))continue;
          const index=assets.findIndex(a=>a.kind===incoming.kind&&(a.position??0)===incoming.position);
          if(index<0)assets.push(incoming);else if(assets[index].digest!==incoming.digest)assets[index]=incoming;
        }
        assets.sort((a,b)=>(a.position??0)-(b.position??0));
        let combined=0;for(let i=0;i<assets.length;i++){combined+=assets[i].blob.size;if(i>=MAX_ASSETS||combined>MAX_MESSAGE_MEDIA_BYTES){assets.splice(i);break;}}
        const digest=[item.textDigest,...assets.map(asset=>asset.digest)].join(':');
        if (old?.removedAt || old?.digest === digest) continue;
        const record = {
          account: item.account, thread: old?.thread || item.thread, id: item.id,
          data: item.data, codec: item.codec, digest,
          ...(assets.length?{assets}:{}),...(item.kind==='emoji'?{kind:'emoji'}:{}),
          ...(old?.purgedKinds?{purgedKinds:old.purgedKinds}:{}),
          capturedAt: old?.capturedAt || now, expiresAt: 0,
          removedAt: 0, truncated: item.truncated === true,
        };
        record.expiresAt=expiry(record,settings);
        // Payload budget includes a conservative allowance for keys/indexes.
        // Browser database files and WAL overhead are not precisely measurable here.
        record.bytes = recordBytes(record);
        // Protected records never make room for a new capture. Refuse before
        // writing if even evicting every eligible record could not fit it.
        if(settings.cleanupRemoved===false&&(stats.removedBytes+record.bytes>settings.maxBytes||stats.removed>=settings.maxMessages)){
          stats.rejected++;stats.capacityBlocked=true;continue;
        }
        stats.bytes += record.bytes - (old?.bytes || 0);
        if (!old) stats.count++;
        store.put(record);
      }
      await this.pruneTransaction(store, stats, settings, now);
      meta.put(stats, "stats");
      await done;
      return Promise.all(restored.map(async r => ({ token: r.token, account: r.account, thread: r.responseThread || r.thread, id: r.responseId || r.id,
        text: await displayText(r), mediaPurged:!r.data.byteLength&&!!r.purgedKinds?.length,kind:r.kind, assets:(r.assets||[]).map(assetSummary), truncated: r.truncated, capturedAt: r.capturedAt, removedAt: r.removedAt })));
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {}); throw error;
    }
  }
  async pruneTransaction(store, stats, settings, now) {
    const remove = cursor => {
      const row = cursor.value; cursor.delete(); stats.count--; stats.bytes -= row.bytes;
      if (row.removedAt) {stats.removed--;stats.removedBytes-=row.bytes;} stats.evicted++;
    };
    await new Promise((resolve, reject) => {
      const req = store.index("expiresAt").openCursor(IDBKeyRange.upperBound(now));
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { const c = req.result; if (!c) return resolve(); if(!protectedRow(c.value,settings))remove(c); c.continue(); };
    });
    if (stats.bytes > settings.maxBytes || stats.count > settings.maxMessages) {
      const targetBytes = Math.floor(settings.maxBytes * 0.95), targetCount = Math.floor(settings.maxMessages * 0.95);
      await new Promise((resolve, reject) => {
        const req = store.index("capturedAt").openCursor();
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const c = req.result;
          if (!c || (stats.bytes <= targetBytes && stats.count <= targetCount)) return resolve();
          if(!protectedRow(c.value,settings))remove(c); c.continue();
        };
      });
    }
    stats.bytes = Math.max(0, stats.bytes); stats.removedBytes=Math.max(0,stats.removedBytes); stats.lastCleanup = now;
    if(settings.cleanupRemoved!==false||!stats.removed)stats.capacityBlocked=false;
    if(settings.cleanupRemoved===false&&(stats.removedBytes>=settings.maxBytes||stats.removed>=settings.maxMessages))stats.capacityBlocked=true;
  }
  async maintain(settings, now = Date.now(), updateRetention = false) {
    const db = await this.open();
    const tx = db.transaction(["messages", "meta"], "readwrite");
    const done = finished(tx), store = tx.objectStore("messages"), meta = tx.objectStore("meta");
    try {
      const stats = await loadStats(meta, store);
      if(updateRetention)stats.capacityBlocked=false;
      if (updateRetention || now-(stats.lastMediaCleanup||0)>=30*60000) await new Promise((resolve, reject) => {
        const req = store.openCursor(); req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const c = req.result; if (!c) return resolve();
          const row = c.value,previousBytes=row.bytes;
          row.expiresAt=expiry(row,settings);
          if(!protectedRow(row,settings)){
            const removed=(row.assets||[]).filter(a=>settings[`${a.kind}RetentionDays`]>0&&(a.capturedAt||row.capturedAt)+settings[`${a.kind}RetentionDays`]*DAY<=now);
            if(removed.length){row.assets=row.assets.filter(a=>!removed.includes(a));row.purgedKinds=[...new Set([...(row.purgedKinds||[]),...removed.map(a=>a.kind)])];stats.mediaPurged+=removed.length;}
          }
          row.bytes=recordBytes(row);stats.bytes+=row.bytes-previousBytes;if(row.removedAt)stats.removedBytes+=row.bytes-previousBytes;
          c.update(row); c.continue();
        };
      });
      if(updateRetention||now-(stats.lastMediaCleanup||0)>=30*60000)stats.lastMediaCleanup=now;
      await this.pruneTransaction(store, stats, settings, now); meta.put(stats, "stats"); await done;
      return stats;
    } catch (e) { try { tx.abort(); } catch {} await done.catch(() => {}); throw e; }
  }
  async stats() {
    const db = await this.open(); return (await request(db.transaction("meta").objectStore("meta").get("stats"))) || emptyStats();
  }
  async listRemoved(before = null, limit = 30) {
    const db = await this.open();
    const store = db.transaction("messages").objectStore("messages");
    const records = await new Promise((resolve, reject) => {
      const rows = [], req = store.index("removedAt").openCursor(IDBKeyRange.bound([1], before || [Number.MAX_SAFE_INTEGER], false, true), "prev");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const c = req.result; if (!c || rows.length >= Math.min(50, limit)) return resolve(rows);
        if (c.value.expiresAt > Date.now()) rows.push(c.value);
        c.continue();
      };
    });
    return Promise.all(records.map(async r => ({ account: r.account, thread: r.thread, id: r.id,
      capturedAt: r.capturedAt, removedAt: r.removedAt, text: await displayText(r),mediaPurged:!r.data.byteLength&&!!r.purgedKinds?.length,kind:r.kind,assets:(r.assets||[]).map(assetSummary),truncated: r.truncated })));
  }
  async assetChunk({account,thread,id,index,offset=0}) {
    if(![account,thread,id].every(validId)||!Number.isInteger(index)||index<0||index>=MAX_ASSETS||!Number.isSafeInteger(offset)||offset<0||offset>MAX_ASSET_BYTES)throw Error('Yêu cầu phương tiện không hợp lệ.');
    const db=await this.open(),store=db.transaction('messages').objectStore('messages');
    let record=await request(store.get([account,thread,id]));
    if(!record){const matches=await request(store.index('aliases').getAll(JSON.stringify([account,id]),2));if(matches.length===1)record=matches[0];}
    const asset=record?.assets?.[index];
    if(!asset||!record.removedAt||record.expiresAt<=Date.now()||offset>asset.blob.size)throw Error('Bản lưu phương tiện không còn trong kho.');
    const data=new Uint8Array(await asset.blob.slice(offset,offset+ASSET_CHUNK_BYTES).arrayBuffer());
    return {...assetSummary(asset,index),offset,data:encodeBase64(data),done:offset+data.length>=asset.blob.size};
  }
  async clear() {
    const db = await this.open(), tx = db.transaction(["messages", "meta"], "readwrite"), done = finished(tx);
    tx.objectStore("messages").clear(); tx.objectStore("meta").put(emptyStats(), "stats"); await done;
  }
  async capturePolicy({account,thread,id},settings) {
    if(![account,thread,id].every(validId)||!/^\d+$/.test(account))throw Error('Mã tin không hợp lệ.');
    const db=await this.open();let record=await request(db.transaction('messages').objectStore('messages').get([account,thread,id]));
    if(record&&record.expiresAt<=Date.now()&&!protectedRow(record,settings))record=null;
    const stats=await this.stats();
    return {allowed:settings.archive&&!stats.capacityBlocked&&!record?.removedAt,
      skipKinds:[...new Set([...(record?.purgedKinds||[]),...(record?.assets||[]).filter(a=>a.kind==='voice').map(a=>a.kind)])]};
  }
  async purgeMedia(kind,days,includeRemoved,settings,now=Date.now()) {
    if(!['image','voice'].includes(kind)||!Number.isInteger(days)||days<0||days>3650||typeof includeRemoved!=='boolean')throw Error('Yêu cầu dọn tệp không hợp lệ.');
    const db=await this.open(),tx=db.transaction(['messages','meta'],'readwrite'),done=finished(tx),store=tx.objectStore('messages'),meta=tx.objectStore('meta');
    try{
      const stats=await loadStats(meta,store);let files=0,bytes=0;
      await new Promise((resolve,reject)=>{const req=store.openCursor();req.onerror=()=>reject(req.error);req.onsuccess=()=>{
        const c=req.result;if(!c)return resolve();const row=c.value;
        if(includeRemoved||!row.removedAt){
          const removed=(row.assets||[]).filter(a=>a.kind===kind&&(!days||(a.capturedAt||row.capturedAt)<=now-days*DAY));
          if(removed.length){const previous=row.bytes;row.assets=row.assets.filter(a=>!removed.includes(a));row.purgedKinds=[...new Set([...(row.purgedKinds||[]),kind])];row.bytes=recordBytes(row);files+=removed.length;bytes+=previous-row.bytes;stats.bytes+=row.bytes-previous;if(row.removedAt)stats.removedBytes+=row.bytes-previous;c.update(row);}
        }c.continue();
      };});
      stats.mediaPurged+=files;if(files)stats.capacityBlocked=false;await this.pruneTransaction(store,stats,settings,now);meta.put(stats,'stats');await done;return {files,bytes:Math.max(0,bytes),stats};
    }catch(e){try{tx.abort();}catch{}await done.catch(()=>{});throw e;}
  }
}
