import { DAY, MAX_BATCH, MAX_TEXT, messageMeta, validId } from "./shared.js";
import {MAX_ASSETS,MAX_VIDEO_BYTES,MAX_MESSAGE_MEDIA_BYTES,ASSET_CHUNK_BYTES,MEDIA_KINDS,assetLimit,detectedMime,assetSummary,encodeBase64,cleanFileName} from './media.js';
import {createVaultRecord,unwrapVaultRecord,importPublicKey,importPrivateKey,sealBytes,openBytes,sealedDigest,sealJson,openJson,sealAsset,openAssetChunk,openAsset,validPassword} from './vault.js';

export const MAX_EDIT_HISTORY = 5;
const SEARCH_SCAN_PLAIN = 4000, SEARCH_SCAN_SEALED = 400, MAINTENANCE_SLICE = 256, MAINTENANCE_INTERVAL = 30 * 60000;
const LIST_STATES = new Set(['removed','vanished','normal','all']);
const request = req => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
});
const finished = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve; tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
  tx.onerror = () => {}; // Abort handler owns the rejection.
});
const emptyStats = () => ({ count: 0, bytes: 0, removed: 0, removedBytes: 0, evicted: 0, rejected: 0, mediaPurged: 0, capacityBlocked: false, lastCleanup: 0 });
const protectedRow = (row, settings) => row.removedAt && settings.cleanupRemoved === false;
// A recalled message is worth keeping for the full period from its recall, not
// from whenever the extension first happened to see it.
const expiry = (row, settings) => protectedRow(row, settings) || !settings.retentionDays ? Number.MAX_SAFE_INTEGER : (row.removedAt || row.capturedAt) + settings.retentionDays * DAY;
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
function recordBytes(record) {
  let binary=0;
  const json=JSON.stringify({...record,bytes:0},(_,value)=>{
    if(value instanceof Uint8Array){binary+=value.byteLength;return null;}
    if(value instanceof Blob){binary+=value.size;return null;}
    return value;
  });
  return binary+encoder.encode(json).byteLength+512;
}
const assetSize = asset => asset.plainSize ?? asset.blob.size;
const sameBytes = (a,b) => a.byteLength===b.byteLength&&a.every((value,index)=>value===b[index]);
const storedTextDigest = record => record.digest ? record.digest.split(':')[0] : null;
const purged = (record,text) => !text&&!!record.purgedKinds?.length;
const sealedRow = record => !!record.seal;
const hasSealedPart = record => sealedRow(record) || !!record.metaBox || (record.assets || []).some(a => a.seal) || (record.history || []).some(e => e.seal);
const assetKeyName = asset => `${asset.kind}:${asset.position??0}`;
// Identifies the lock a record would be sealed for; the "migrating" flag is not part of it.
const vaultIdentity = record => record ? `${record.disabling === true}|${Array.from(record.publicKey).join(",")}` : "none";
function withoutPlain(asset){const {plain,...stored}=asset;return stored;}

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
async function findRecord(store,item) {
  let key=[item.account,item.thread,item.id],old=await request(store.get(key));
  if(!old&&item.removed){
    const candidates=await request(store.index("aliases").getAll(JSON.stringify([item.account,item.id]),2));
    if(candidates.length===1){old=candidates[0];key=[old.account,old.thread,old.id];}
  }
  if(!old&&/^mid\./.test(item.id)){
    const candidates=(await request(store.index("accountMessage").getAll([item.account,item.id],3)))
      .filter(row=>row.thread==="by-message-id"||item.thread==="by-message-id");
    // Only cross the popup/full-page boundary for an unambiguous global
    // Facebook message ID. Never match a title, timestamp or message text.
    if(candidates.length===1){old=candidates[0];key=[old.account,old.thread,old.id];}
  }
  return {key,old};
}
const memoryKeys = () => { let value=null; return { get:async()=>value, set:async next=>{value=next;}, clear:async()=>{value=null;} }; };

export class Archive {
  constructor(name = "pito-message-archive-v1", keys = memoryKeys()) { this.name = name; this.keys = keys; this.vaultCache = undefined; }
  async open() {
    if (!this.dbPromise) this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(this.name, 5);
      req.onupgradeneeded = () => {
        const store = req.result.objectStoreNames.contains("messages") ? req.transaction.objectStore("messages") :
          req.result.createObjectStore("messages", { keyPath: ["account", "thread", "id"] });
        if (!store.indexNames.contains("capturedAt")) store.createIndex("capturedAt", "capturedAt");
        if (!store.indexNames.contains("expiresAt")) store.createIndex("expiresAt", "expiresAt");
        if (!store.indexNames.contains("removedAt")) store.createIndex("removedAt", ["removedAt", "account", "thread", "id"]);
        if (!store.indexNames.contains("accountMessage")) store.createIndex("accountMessage", ["account", "id"]);
        if (!store.indexNames.contains("aliases")) store.createIndex("aliases", "aliasKeys", { multiEntry: true });
        if (!store.indexNames.contains("capturedOrder")) store.createIndex("capturedOrder", ["capturedAt", "account", "thread", "id"]);
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
  async vaultHandle(fresh = false) {
    if (this.vaultCache !== undefined && !fresh) return this.vaultCache;
    const db = await this.open(), record = await request(db.transaction("meta").objectStore("meta").get("vault"));
    if (!record) { this.vaultCache = null; return null; }
    const stored = await this.keys.get();
    this.vaultCache = { record, publicKey: await importPublicKey(record.publicKey), privateKey: stored ? await importPrivateKey(stored) : null };
    return this.vaultCache;
  }
  async vaultStatus() {
    const vault = await this.vaultHandle();
    return { enabled: !!vault, unlocked: !!vault?.privateKey, disabling: vault?.record.disabling === true, sealing: vault?.record.migrating === true, unsealed: vault?.record.unsealed || 0 };
  }
  async writeVaultRecord(record) {
    const db = await this.open(), tx = db.transaction("meta", "readwrite"), done = finished(tx);
    if (record) tx.objectStore("meta").put(record, "vault"); else tx.objectStore("meta").delete("vault");
    await done; this.vaultCache = undefined;
  }
  async vaultEnable(passphrase) {
    if (!validPassword(passphrase)) throw Error('errPasswordShort');
    if (await this.vaultHandle(true)) throw Error('errVaultEnabled');
    const { record, privateBytes } = await createVaultRecord(passphrase);
    // "migrating" stays set until one full pass has sealed every older record.
    await this.writeVaultRecord({ ...record, migrating: true });
    await this.keys.set(privateBytes); this.vaultCache = undefined;
    return this.vaultStatus();
  }
  async vaultUnlock(passphrase) {
    const vault = await this.vaultHandle(true);
    if (!vault) throw Error('errVaultDisabled');
    await this.keys.set(await unwrapVaultRecord(vault.record, passphrase)); this.vaultCache = undefined;
    return this.vaultStatus();
  }
  async vaultLock() { await this.keys.clear(); this.vaultCache = undefined; return this.vaultStatus(); }
  async vaultBeginDisable(passphrase) {
    const vault = await this.vaultHandle(true);
    if (!vault) throw Error('errVaultDisabled');
    await this.keys.set(await unwrapVaultRecord(vault.record, passphrase));
    await this.writeVaultRecord({ ...vault.record, disabling: true });
    return this.vaultStatus();
  }
  // Converts a bounded slice of records toward the vault's current direction.
  // Crypto happens outside IndexedDB transactions, which cannot wait for it.
  async vaultSlice(after = null, limit = 16) {
    const vault = await this.vaultHandle();
    if (!vault) return { next: null, processed: 0, done: true };
    const opening = vault.record.disabling === true;
    if (opening && !vault.privateKey) throw Error('errLocked');
    const { rows, next } = await this.rawBatch(after, limit), updates = [];
    for (const row of rows) {
      try {
        if (opening && hasSealedPart(row)) updates.push([row, await this.unsealRecord(row, vault)]);
        else if (!opening && !sealedRow(row)) updates.push([row, await this.sealRecord(row, vault)]);
      } catch {} // counted by the check at the end of the pass
    }
    if (updates.length) {
      const db = await this.open(), tx = db.transaction(["messages", "meta"], "readwrite"), done = finished(tx);
      try {
        const store = tx.objectStore("messages"), meta = tx.objectStore("meta"), stats = await loadStats(meta, store);
        for (const [previous, record] of updates) {
          const current = await request(store.get([record.account, record.thread, record.id]));
          if (!current || hasSealedPart(current) !== hasSealedPart(previous) || current.bytes !== previous.bytes) continue;
          record.bytes = recordBytes(record); stats.bytes += record.bytes - current.bytes;
          if (current.removedAt) stats.removedBytes += record.bytes - current.bytes;
          store.put(record);
        }
        meta.put(stats, "stats"); await done;
      } catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
    }
    if (next) return { next, processed: rows.length, done: false, failed: 0 };
    // At the end of a pass the whole archive is checked, so another pass running
    // at the same time, a record that failed, or a write in between cannot be
    // missed. The lock is removed only when nothing sealed remains; sealing is
    // finished only when nothing plain remains.
    const remaining = await this.countRows(opening ? hasSealedPart : row => !sealedRow(row));
    if (opening && !remaining) { await this.writeVaultRecord(null); await this.keys.clear(); }
    if (!opening) {
      const current = (await this.vaultHandle(true))?.record;
      if (current && !current.disabling && (current.migrating !== remaining > 0 || (current.unsealed || 0) !== remaining)) await this.writeVaultRecord({ ...current, migrating: remaining > 0, unsealed: remaining });
    }
    return { next: null, processed: rows.length, done: true, failed: remaining };
  }
  async countRows(predicate) {
    let after = null, count = 0;
    do { const batch = await this.rawBatch(after, 256); after = batch.next; for (const row of batch.rows) if (predicate(row)) count++; } while (after);
    return count;
  }
  // Seals a plain record. Parts that are already sealed are kept as they are:
  // sealing ciphertext a second time would destroy it.
  async sealRecord(record, vault) {
    const { seal, ...plain } = record, text = await unpack(record), digest = storedTextDigest(record) || await sha(encoder.encode(text));
    const box = await sealBytes(vault.publicKey, record.data, digest), names = {};
    const assets = [];
    for (const asset of record.assets || []) {
      if (asset.seal) { assets.push(asset); continue; }
      const bytes = new Uint8Array(await asset.blob.arrayBuffer());
      if (asset.name) names[assetKeyName(asset)] = asset.name;
      const { name, ...stored } = asset;
      assets.push({ ...stored, ...await sealAsset(vault.publicKey, bytes, asset.digest, ASSET_CHUNK_BYTES) });
    }
    const history = [];
    for (const entry of record.history || []) history.push(entry.seal ? entry : { ...entry, ...await sealBytes(vault.publicKey, entry.data) });
    const { meta, ...rest } = plain, details = { ...(meta || {}), ...(Object.keys(names).length ? { names } : {}) };
    return { ...rest, digest: '', data: box.data, seal: box.seal,
      ...(record.assets ? { assets } : {}), ...(record.history ? { history } : {}),
      ...(Object.keys(details).length ? { metaBox: await sealJson(vault.publicKey, details) } : {}) };
  }
  // Opens every sealed part of a record, including a record that is only
  // partly sealed, and returns the plain form.
  // With skipUnreadable (export only), a file that cannot be read is left out
  // and counted; removing the lock never drops a file, it stops instead.
  async unsealRecord(record, vault, { skipUnreadable = false } = {}) {
    const { seal, metaBox, ...plain } = record, data = seal ? await openBytes(vault.privateKey, record.data, seal) : record.data;
    const details = metaBox ? await openJson(vault.privateKey, metaBox) : {}, { names = {}, ...meta } = details, assets = [];
    let missingFiles = 0;
    for (const asset of record.assets || []) {
      if (!asset.seal) { assets.push(asset); continue; }
      let bytes;
      try { bytes = await openAsset(vault.privateKey, asset); }
      catch (error) { if (!skipUnreadable) throw error; missingFiles++; continue; }
      const { seal: assetSeal, plainSize, ...stored } = asset;
      assets.push({ ...stored, blob: new Blob([bytes], { type: asset.mime }), digest: await sealedDigest(vault.privateKey, assetSeal), ...(names[assetKeyName(asset)] ? { name: names[assetKeyName(asset)] } : {}) });
    }
    const history = [];
    for (const entry of record.history || []) {
      const { seal: entrySeal, ...rest } = entry;
      history.push({ ...rest, data: entrySeal ? await openBytes(vault.privateKey, entry.data, entrySeal) : entry.data });
    }
    if (missingFiles) Object.defineProperty(plain, "missingFiles", { value: missingFiles, enumerable: false });
    return { ...plain, data, digest: seal ? await sealedDigest(vault.privateKey, seal) : record.digest,
      ...(record.assets ? { assets } : {}), ...(record.history ? { history } : {}), ...(Object.keys(meta).length || record.meta ? { meta: { ...(record.meta || {}), ...meta } } : {}) };
  }
  async openRecord(record, vault) {
    if (hasSealedPart(record) && !vault?.privateKey) return { locked: true, text: '', history: [], meta: {}, names: {} };
    const open = (data, seal) => seal ? openBytes(vault.privateKey, data, seal) : data;
    const text = await unpack({ data: await open(record.data, record.seal), codec: record.codec }), history = [];
    for (const entry of record.history || []) history.push({ text: await unpack({ data: await open(entry.data, entry.seal), codec: entry.codec }), at: entry.at });
    const { names = {}, ...meta } = record.metaBox ? await openJson(vault.privateKey, record.metaBox) : {};
    return { locked: false, text, history, meta: { ...(record.meta || {}), ...meta }, names };
  }
  // One record that cannot be opened is shown as damaged instead of failing the whole list.
  async presentRecord(record, vault) {
    let opened;
    try { opened = await this.openRecord(record, vault); }
    catch { opened = { locked: false, damaged: true, text: '', history: [], meta: {}, names: {} }; }
    return { account: record.account, thread: record.thread, id: record.id, capturedAt: record.capturedAt, removedAt: record.removedAt,
      ...(record.removal ? { removal: record.removal } : {}), ...(record.editedAt ? { editedAt: record.editedAt } : {}),
      ...(record.sentAt ? { sentAt: record.sentAt } : {}), ...(record.senderId ? { senderId: record.senderId } : {}),
      senderName: opened.meta.senderName, replyText: opened.meta.replyText, history: opened.history,
      text: opened.text, locked: opened.locked, ...(opened.damaged ? { damaged: true } : {}), mediaPurged: !opened.locked && !opened.damaged && purged(record, opened.text), kind: record.kind, truncated: record.truncated,
      assets: opened.locked || opened.damaged ? [] : (record.assets || []).map((asset, index) => assetSummary({ ...asset, name: asset.name || opened.names[assetKeyName(asset)] }, index)) };
  }
  // Seals everything that is about to change. Runs before the write transaction.
  // Seals everything that is about to change. Runs before the write transaction.
  // A record is always entirely sealed or entirely plain: an observation of a
  // record that migration has not reached yet is written plain, and sealed later.
  async prepareSealed(prepared, vault, sealing) {
    const db = await this.open(), store = db.transaction("messages").objectStore("messages");
    for (const item of prepared) if (!item.removed) item.previous = (await findRecord(store, item)).old;
    for (const item of prepared) {
      if (item.removed) continue;
      const old = item.previous;
      // While locked, or while the lock is being removed, a sealed copy stays as it is.
      if (old && hasSealedPart(old) && (!vault.privateKey || !sealing)) { item.lockedOut = true; continue; }
      if (!sealing || (old && !sealedRow(old))) continue;
      let before;
      try { before = old ? await this.openRecord(old, vault) : { meta: {}, names: {} }; item.previousDigest = old ? await sealedDigest(vault.privateKey, old.seal) : null; }
      catch { item.lockedOut = true; continue; }
      Object.assign(item, await sealBytes(vault.publicKey, item.data, item.textDigest));
      const names = { ...before.names };
      for (const asset of item.assets) {
        const existing = (old?.assets || []).find(a => a.kind === asset.kind && (a.position ?? 0) === asset.position);
        if (existing && assetSize(existing) >= asset.plain.byteLength) { asset.redundant = true; continue; }
        if (asset.name) { names[assetKeyName(asset)] = asset.name; delete asset.name; }
        Object.assign(asset, await sealAsset(vault.publicKey, asset.plain, asset.digest, ASSET_CHUNK_BYTES));
      }
      item.assets = item.assets.filter(asset => !asset.redundant);
      // Details only ever accumulate: a later observation never erases a name or reply.
      const merged = { ...before.meta };
      for (const [key, value] of Object.entries(item.meta)) if (value && !merged[key]) merged[key] = value;
      if (Object.keys(names).length) merged.names = names;
      const previous = JSON.stringify({ ...before.meta, ...(Object.keys(before.names).length ? { names: before.names } : {}) });
      if (Object.keys(merged).length) item.metaBox = await sealJson(vault.publicKey, merged);
      item.metaChanged = JSON.stringify(merged) !== previous;
    }
  }
  async ingest(items, settings, now = Date.now()) {
    if (!settings.archive) return [];
    const prepared = [];
    for (const item of items.slice(0, MAX_BATCH)) {
      if (!validObservation(item)) continue;
      if (item.removed) { prepared.push(item); continue; }
      const text = (item.text||'').slice(0, MAX_TEXT),assets=[];let total=0,videos=0;
      for(const asset of (item.assets||[]).slice(0,MAX_ASSETS)){
        if(!(asset.data instanceof Uint8Array)||!asset.data.byteLength||asset.data.byteLength>assetLimit(asset.kind,settings,asset.subtype))continue;
        if(asset.kind==='video'){videos+=asset.data.byteLength;if(videos>MAX_VIDEO_BYTES)break;}
        else{total+=asset.data.byteLength;if(total>MAX_MESSAGE_MEDIA_BYTES)break;}
        const mime=detectedMime(asset.data,asset.mime,asset.kind);if(!mime)continue;
        assets.push({kind:asset.kind,mime,position:Number.isInteger(asset.position)&&asset.position>=0&&asset.position<MAX_ASSETS?asset.position:assets.length,capturedAt:now,blob:new Blob([asset.data],{type:mime}),plain:asset.data,digest:await sha(asset.data),
          ...(['gif','sticker'].includes(asset.subtype)?{subtype:asset.subtype}:{}),...(asset.kind==='file'&&cleanFileName(asset.name)?{name:cleanFileName(asset.name)}:{}),...(typeof asset.urlKey==='string'?{urlKey:asset.urlKey}:{})});
      }
      if(!text.trim()&&!assets.length)continue;
      const textDigest=await sha(encoder.encode(text)),{senderId,sentAt,...meta}=messageMeta(item);
      prepared.push({ ...item, assets, ...(await pack(text)), textDigest, hasText:!!text.trim(), senderId, sentAt, meta });
    }
    const vault = await this.vaultHandle();
    const sealing = !!vault && vault.record.disabling !== true;
    if (vault && prepared.some(item => !item.removed)) await this.prepareSealed(prepared, vault, sealing);
    const db = await this.open();
    const tx = db.transaction(["messages", "meta"], "readwrite");
    const done = finished(tx);
    try {
      const store = tx.objectStore("messages"), meta = tx.objectStore("meta");
      const stats = await loadStats(meta, store);
      const restored = [], batchDigests = new Map();
      for (const item of prepared) {
        let {key,old} = await findRecord(store,item);
        if (old && old.expiresAt <= now && !protectedRow(old, settings)) {
          store.delete(key); stats.count--; stats.bytes -= old.bytes;
          if (old.removedAt) {stats.removed--;stats.removedBytes-=old.bytes;} stats.evicted++; old = null;
        }
        if (item.removed) {
          // A tombstone without an earlier capture cannot manufacture content.
          if (!old) continue;
          const previousRemovedBytes=old.removedAt?old.bytes:0,previousBytes=old.bytes;
          if (!old.removedAt) { old.removedAt = now; stats.removed++; if(item.vanished===true)old.removal='vanished'; }
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
        // A locked archive cannot compare with its sealed copy; keep that copy.
        if(item.lockedOut)continue;
        // Never combine sealed and plain parts in one record.
        if(old&&hasSealedPart(old)!==!!item.seal)continue;
        if(stats.capacityBlocked&&settings.cleanupRemoved===false){stats.rejected++;continue;}
        if(old?.removedAt)continue;
        // A rerender or a failed re-download can temporarily omit media while
        // leaving the caption. Never erase an already captured binary then.
        const assets=(old?.assets||[]).map((a,index)=>({...a,position:a.position??index,capturedAt:a.capturedAt??old.capturedAt}));
        let assetsChanged=false;
        for(const incoming of item.assets){
          if(old?.purgedKinds?.includes(incoming.kind))continue;
          const index=assets.findIndex(a=>a.kind===incoming.kind&&(a.position??0)===incoming.position);
          // A later render can be a smaller preview; only a larger copy replaces.
          if(index<0){assets.push(incoming);assetsChanged=true;}
          else if(assetSize(incoming)>assetSize(assets[index])){assets[index]=incoming;assetsChanged=true;}
          // Remember the source of a file saved by an older version.
          else if(incoming.urlKey&&!assets[index].urlKey&&assetSize(incoming)===assetSize(assets[index])){assets[index].urlKey=incoming.urlKey;assetsChanged=true;}
        }
        assets.sort((a,b)=>(a.position??0)-(b.position??0));
        let combined=0,videoBytes=0;
        for(let i=0;i<assets.length;i++){
          if(assets[i].kind==='video')videoBytes+=assetSize(assets[i]);else combined+=assetSize(assets[i]);
          if(i>=MAX_ASSETS||combined>MAX_MESSAGE_MEDIA_BYTES||videoBytes>MAX_VIDEO_BYTES){assets.splice(i);break;}
        }
        // A record written earlier in this same batch is compared with that write.
        const batchDigest=old&&batchDigests.get(JSON.stringify([old.account,old.thread,old.id]));
        const previousDigest=!old?null:batchDigest||(sealedRow(old)?item.previousDigest:storedTextDigest(old));
        const oldHasText=!!old&&(sealedRow(old)||old.data.byteLength>0);
        // A rerender can briefly lose the caption while media stays visible.
        const sameDigest=previousDigest?previousDigest===item.textDigest:!!old&&!sealedRow(old)&&old.codec===item.codec&&sameBytes(old.data,item.data);
        const sameText=!!old&&(sameDigest||(!item.hasText&&oldHasText));
        if(old&&sameText&&!assetsChanged){
          if(!sealedRow(old))this.fillMetadata(old,item,stats,store);
          else{
            const previous=old.bytes;let changed=false;
            if(item.metaChanged){old.metaBox=item.metaBox;changed=true;}
            if(item.senderId&&!old.senderId){old.senderId=item.senderId;changed=true;}
            if(item.sentAt&&!old.sentAt){old.sentAt=item.sentAt;changed=true;}
            if(changed){old.bytes=recordBytes(old);stats.bytes+=old.bytes-previous;store.put(old);}
          }
          continue;
        }
        const text=old&&sameText?
          {data:old.data,codec:old.codec,digest:old.digest,...(old.seal?{seal:old.seal}:{})}:
          {data:item.data,codec:item.codec,digest:item.seal?'':item.textDigest,...(item.seal?{seal:item.seal}:{})};
        const history=old&&!sameText&&oldHasText?
          [...(old.history||[]),{data:old.data,codec:old.codec,...(old.seal?{seal:old.seal}:{}),at:old.editedAt||old.capturedAt}].slice(-MAX_EDIT_HISTORY):old?.history;
        const details=item.metaBox?{metaBox:item.metaBox}:old?.metaBox?{metaBox:old.metaBox}:item.seal?{}:this.mergedMeta(old,item);
        const record = {
          account: item.account, thread: old?.thread || item.thread, id: item.id, ...text,
          ...(assets.length?{assets:assets.map(withoutPlain)}:{}),...(history?.length?{history}:{}),...(item.kind==='emoji'?{kind:'emoji'}:{}),
          ...(old?.purgedKinds?{purgedKinds:old.purgedKinds}:{}),...details,
          ...(item.senderId||old?.senderId?{senderId:item.senderId||old.senderId}:{}),...(item.sentAt||old?.sentAt?{sentAt:item.sentAt||old.sentAt}:{}),
          ...(old&&!sameText?{editedAt:now}:old?.editedAt?{editedAt:old.editedAt}:{}),
          capturedAt: old?.capturedAt || now, expiresAt: 0,
          removedAt: 0, truncated: old&&sameText?old.truncated:item.truncated === true,
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
        store.put(record);batchDigests.set(JSON.stringify([record.account,record.thread,record.id]),item.textDigest);
      }
      await this.pruneTransaction(store, stats, settings, now);
      meta.put(stats, "stats");
      await done;
      return Promise.all(restored.map(async r => {
        const row=await this.presentRecord(r,vault);
        return { token: r.token, account: r.account, thread: r.responseThread || r.thread, id: r.responseId || r.id,
          text: row.text, locked: row.locked || row.damaged === true, mediaPurged: row.mediaPurged, kind: r.kind, assets: row.assets, truncated: r.truncated, capturedAt: r.capturedAt, removedAt: r.removedAt };
      }));
    } catch (error) {
      try { tx.abort(); } catch {}
      await done.catch(() => {}); throw error;
    }
  }
  mergedMeta(old,item) {
    const merged={};
    for(const key of ['senderName','replyText','label']){const value=item.meta?.[key]||old?.meta?.[key];if(value)merged[key]=value;}
    return Object.keys(merged).length?{meta:merged}:{};
  }
  // Fills only details that were missing; never rewrites what was saved first.
  fillMetadata(old,item,stats,store) {
    const merged=this.mergedMeta(old,item).meta,nextSender=old.senderId||item.senderId,nextSent=old.sentAt||item.sentAt;
    if(JSON.stringify(merged||null)===JSON.stringify(old.meta||null)&&nextSender===old.senderId&&nextSent===old.sentAt)return;
    const previous=old.bytes;
    if(merged)old.meta=merged;if(nextSender)old.senderId=nextSender;if(nextSent)old.sentAt=nextSent;
    old.bytes=recordBytes(old);stats.bytes+=old.bytes-previous;store.put(old);
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
    const targetBytes = Math.floor(settings.maxBytes * 0.95), targetCount = Math.floor(settings.maxMessages * 0.95);
    const fits = () => stats.bytes <= targetBytes && stats.count <= targetCount;
    const evict = eligible => new Promise((resolve, reject) => {
      const req = store.index("capturedAt").openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const c = req.result;
        if (!c || fits()) return resolve();
        if(eligible(c.value))remove(c); c.continue();
      };
    });
    if (stats.bytes > settings.maxBytes || stats.count > settings.maxMessages) {
      // Ordinary messages go first: a recalled message can no longer be
      // fetched from Facebook, so it is the last thing worth losing.
      await evict(row => !row.removedAt);
      if (!fits() && settings.cleanupRemoved !== false) await evict(row => row.removedAt);
    }
    stats.bytes = Math.max(0, stats.bytes); stats.removedBytes=Math.max(0,stats.removedBytes); stats.lastCleanup = now;
    if(settings.cleanupRemoved!==false||!stats.removed)stats.capacityBlocked=false;
    if(settings.cleanupRemoved===false&&(stats.removedBytes>=settings.maxBytes||stats.removed>=settings.maxMessages))stats.capacityBlocked=true;
  }
  // One bounded transaction of the retention scan. Records are rewritten only
  // when something about them actually changed.
  async maintainSlice(settings, now, after = null, limit = MAINTENANCE_SLICE) {
    const db = await this.open();
    const tx = db.transaction(["messages", "meta"], "readwrite");
    const done = finished(tx), store = tx.objectStore("messages"), meta = tx.objectStore("meta");
    try {
      const stats = await loadStats(meta, store);
      let processed = 0, last = null, written = 0;
      await new Promise((resolve, reject) => {
        const req = store.openCursor(after ? IDBKeyRange.lowerBound(after, true) : undefined); req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const c = req.result; if (!c || processed >= limit) return resolve();
          processed++; last = c.primaryKey;
          const row = c.value, previousBytes = row.bytes, expiresAt = expiry(row, settings);
          let changed = expiresAt !== row.expiresAt;
          row.expiresAt = expiresAt;
          if (!protectedRow(row, settings)) {
            const removed = (row.assets || []).filter(a => settings[`${a.kind}RetentionDays`] > 0 && (a.capturedAt || row.capturedAt) + settings[`${a.kind}RetentionDays`] * DAY <= now);
            if (removed.length) { row.assets = row.assets.filter(a => !removed.includes(a)); row.purgedKinds = [...new Set([...(row.purgedKinds || []), ...removed.map(a => a.kind)])]; stats.mediaPurged += removed.length; changed = true; }
          }
          if (changed) {
            row.bytes = recordBytes(row); stats.bytes += row.bytes - previousBytes; if (row.removedAt) stats.removedBytes += row.bytes - previousBytes;
            c.update(row); written++;
          }
          c.continue();
        };
      });
      meta.put(stats, "stats"); await done;
      return { next: processed >= limit ? last : null, processed, written };
    } catch (e) { try { tx.abort(); } catch {} await done.catch(() => {}); throw e; }
  }
  async finishMaintenance(settings, now, scanned, updateRetention) {
    const db = await this.open();
    const tx = db.transaction(["messages", "meta"], "readwrite");
    const done = finished(tx), store = tx.objectStore("messages"), meta = tx.objectStore("meta");
    try {
      const stats = await loadStats(meta, store);
      if (updateRetention) stats.capacityBlocked = false;
      if (scanned) stats.lastMediaCleanup = now;
      await this.pruneTransaction(store, stats, settings, now); meta.put(stats, "stats"); await done;
      return stats;
    } catch (e) { try { tx.abort(); } catch {} await done.catch(() => {}); throw e; }
  }
  // `schedule` lets the worker run each slice through its queue, so captures
  // can be committed between slices of a long cleanup.
  async maintain(settings, now = Date.now(), updateRetention = false, schedule = work => work()) {
    const scanned = updateRetention || now - ((await this.stats()).lastMediaCleanup || 0) >= MAINTENANCE_INTERVAL;
    if (scanned) {
      let after = null;
      do { const cursor = after; ({ next: after } = await schedule(() => this.maintainSlice(settings, now, cursor))); } while (after);
    }
    return schedule(() => this.finishMaintenance(settings, now, scanned, updateRetention));
  }
  async stats() {
    const db = await this.open(); return (await request(db.transaction("meta").objectStore("meta").get("stats"))) || emptyStats();
  }
  async rawBatch(after = null, limit = 16) {
    const db = await this.open(), store = db.transaction("messages").objectStore("messages");
    return new Promise((resolve, reject) => {
      const rows = [], req = store.openCursor(after ? IDBKeyRange.lowerBound(after, true) : undefined);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve({ rows, next: null });
        if (rows.length >= limit) return resolve({ rows, next: rows.at(-1) && [rows.at(-1).account, rows.at(-1).thread, rows.at(-1).id] });
        rows.push(c.value); c.continue();
      };
    });
  }
  async orderedBatch(indexName, lower, before, limit) {
    const db = await this.open(), store = db.transaction("messages").objectStore("messages");
    return new Promise((resolve, reject) => {
      const rows = [], req = store.index(indexName).openCursor(IDBKeyRange.bound(lower, before || [Number.MAX_SAFE_INTEGER], false, true), "prev");
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve({ rows, exhausted: true });
        if (rows.length >= limit) return resolve({ rows, exhausted: false });
        rows.push(c.value); c.continue();
      };
    });
  }
  // Searches every stored message in bounded scans. A caller continues from
  // `next` so one search over a large archive never holds the worker for long.
  async list({ state = 'removed', before = null, limit = 30, query = '' } = {}, now = Date.now()) {
    if (!LIST_STATES.has(state)) throw Error('errInvalidRequest');
    const vault = await this.vaultHandle(), max = Math.min(50, limit), needle = String(query).trim().toLocaleLowerCase();
    const byRemoval = state === 'removed' || state === 'vanished', indexName = byRemoval ? 'removedAt' : 'capturedOrder';
    const orderKey = row => [byRemoval ? row.removedAt : row.capturedAt, row.account, row.thread, row.id];
    const budget = needle ? (vault ? SEARCH_SCAN_SEALED : SEARCH_SCAN_PLAIN) : Number.MAX_SAFE_INTEGER;
    const rows = []; let cursor = before, scanned = 0, finishedScan = false;
    while (rows.length < max && scanned < budget && !finishedScan) {
      const batch = await this.orderedBatch(indexName, [byRemoval ? 1 : 0], cursor, 64);
      let consumed = 0;
      for (const record of batch.rows) {
        if (rows.length >= max || scanned >= budget) break;
        consumed++; scanned++; cursor = orderKey(record);
        const stateMatches = state === 'all' || (state === 'normal' && !record.removedAt) || (state === 'removed' && record.removal !== 'vanished') || (state === 'vanished' && record.removal === 'vanished');
        if (!stateMatches || record.expiresAt <= now) continue;
        const row = await this.presentRecord(record, vault);
        if (needle && ![row.text, row.senderName, row.replyText, ...row.history.map(entry => entry.text)].some(value => value?.toLocaleLowerCase().includes(needle))) continue;
        rows.push(row);
      }
      finishedScan = batch.exhausted && consumed === batch.rows.length;
    }
    return { rows, next: finishedScan ? null : cursor, scanned, locked: !!vault && !vault.privateKey };
  }
  async listRemoved(before = null, limit = 30) { return (await this.list({ state: 'removed', before, limit })).rows; }
  async assetChunk({account,thread,id,index,offset=0},{any=false}={}) {
    if(![account,thread,id].every(validId)||!Number.isInteger(index)||index<0||index>=MAX_ASSETS||!Number.isSafeInteger(offset)||offset<0||offset>MAX_VIDEO_BYTES)throw Error('errInvalidMedia');
    const db=await this.open(),store=db.transaction('messages').objectStore('messages');
    let record=await request(store.get([account,thread,id]));
    if(!record){const matches=await request(store.index('aliases').getAll(JSON.stringify([account,id]),2));if(matches.length===1)record=matches[0];}
    const asset=record?.assets?.[index];
    if(!asset||(!record.removedAt&&!any)||record.expiresAt<=Date.now()||offset>assetSize(asset))throw Error('errMediaGone');
    let data;
    if(asset.seal){
      const vault=await this.vaultHandle();
      if(!vault?.privateKey)throw Error('errLocked');
      data=offset>=asset.plainSize?new Uint8Array():await openAssetChunk(vault.privateKey,asset,offset);
    }
    else data=new Uint8Array(await asset.blob.slice(offset,offset+ASSET_CHUNK_BYTES).arrayBuffer());
    return {...assetSummary(asset,index),offset,data:encodeBase64(data),done:offset+data.length>=assetSize(asset)};
  }
  // A full reset, including the password lock: this is also the way out when
  // the password is forgotten, since nothing sealed remains to protect.
  async clear() {
    const db = await this.open(), tx = db.transaction(["messages", "meta"], "readwrite"), done = finished(tx);
    tx.objectStore("messages").clear(); tx.objectStore("meta").put(emptyStats(), "stats"); tx.objectStore("meta").delete("vault"); await done;
    await this.keys.clear(); this.vaultCache = undefined;
  }
  async capturePolicy({account,thread,id},settings) {
    if(![account,thread,id].every(validId)||!/^\d+$/.test(account))throw Error('errInvalidMessageId');
    const db=await this.open();let record=await request(db.transaction('messages').objectStore('messages').get([account,thread,id]));
    if(record&&record.expiresAt<=Date.now()&&!protectedRow(record,settings))record=null;
    const stats=await this.stats(),vault=await this.vaultHandle();
    return {allowed:settings.archive&&!stats.capacityBlocked&&!record?.removedAt&&!(record&&sealedRow(record)&&!vault?.privateKey),
      skipKinds:[...new Set([...(record?.purgedKinds||[]),...(record?.assets||[]).filter(a=>a.kind==='voice').map(a=>a.kind)])],
      assets:(record?.assets||[]).map(a=>({kind:a.kind,position:a.position??0,size:assetSize(a),urlKey:a.urlKey}))};
  }
  async purgeMedia(kind,days,includeRemoved,settings,now=Date.now()) {
    if(!MEDIA_KINDS.includes(kind)||!Number.isInteger(days)||days<0||days>3650||typeof includeRemoved!=='boolean')throw Error('errInvalidCleanup');
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
  // Decrypts a stored record into the plain form used inside a backup file.
  async exportRecord(record, vault) {
    if (hasSealedPart(record) && !vault?.privateKey) throw Error('errLocked');
    const plain = hasSealedPart(record) ? await this.unsealRecord(record, vault, { skipUnreadable: true }) : record, assets = [], binaries = [];
    let missingFiles = (plain.assets || []).length < (record.assets || []).length ? (record.assets || []).length - (plain.assets || []).length : 0;
    for (const asset of plain.assets || []) {
      // A file the browser can no longer read is left out; the message itself is still exported.
      let data;
      try { data = new Uint8Array(await asset.blob.arrayBuffer()); } catch { missingFiles++; continue; }
      const { blob, ...fields } = asset; assets.push({ ...fields, size: data.byteLength, digest: await sha(data) }); binaries.push(data);
    }
    const history = [];
    for (const entry of plain.history || []) history.push({ text: await unpack(entry), at: entry.at });
    const { data, codec, digest, bytes, expiresAt, assets: _assets, history: _history, ...fields } = plain;
    return { json: { ...fields, text: await unpack(plain), assets, history }, binaries, missingFiles };
  }
  // Adds records from a verified backup. It never overwrites a local record
  // and never evicts one: anything that does not fit is reported instead.
  // The options page imports while the worker may change the lock. If the lock
  // changes between sealing and writing, the batch is prepared again.
  async importRecords(entries, settings, now = Date.now()) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = await this.importAttempt(entries, settings, now);
      if (outcome) return outcome;
    }
    throw Error('errVaultChanged');
  }
  async importAttempt(entries, settings, now) {
    const result = { imported: 0, duplicates: 0, rejected: 0, expired: 0 }, vault = await this.vaultHandle(true);
    const sealing = !!vault && vault.record.disabling !== true, prepared = [];
    for (const { json, binaries } of entries) {
      const history = [];
      for (const entry of json.history || []) history.push({ ...await pack(entry.text), at: entry.at });
      const textBytes = encoder.encode(json.text), assets = json.assets.map(({ size, ...asset }, index) => ({ ...asset, blob: new Blob([binaries[index]], { type: asset.mime }) }));
      const { text, assets: _a, history: _h, ...fields } = json;
      let record = { ...fields, ...await pack(text), digest: await sha(textBytes), ...(assets.length ? { assets } : {}), ...(history.length ? { history } : {}), expiresAt: 0 };
      record.expiresAt = expiry(record, settings);
      if (record.expiresAt <= now) { result.expired++; continue; }
      if (sealing) record = await this.sealRecord(record, vault);
      record.bytes = recordBytes(record);
      prepared.push(record);
    }
    const db = await this.open(), tx = db.transaction(["messages", "meta"], "readwrite"), done = finished(tx);
    try {
      const store = tx.objectStore("messages"), meta = tx.objectStore("meta"), stats = await loadStats(meta, store);
      if (vaultIdentity(await request(meta.get("vault"))) !== vaultIdentity(vault?.record)) { tx.abort(); await done.catch(() => {}); this.vaultCache = undefined; return null; }
      for (const record of prepared) {
        if (await request(store.getKey([record.account, record.thread, record.id]))) { result.duplicates++; continue; }
        if (stats.bytes + record.bytes > settings.maxBytes || stats.count >= settings.maxMessages) { result.rejected++; continue; }
        store.put(record); stats.count++; stats.bytes += record.bytes; result.imported++;
        if (record.removedAt) { stats.removed++; stats.removedBytes += record.bytes; }
      }
      meta.put(stats, "stats"); await done;
      return result;
    } catch (error) { try { tx.abort(); } catch {} await done.catch(() => {}); throw error; }
  }
}
