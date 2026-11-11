import { Archive } from "./archive.js";
import { DEFAULTS, MAX_BATCH, messageMeta, normalizeSettings, validId } from "./shared.js";
import { classifySender, senderDiagnostics } from "./sender.js";
import {MAX_ASSETS,MAX_MESSAGE_MEDIA_BYTES,MAX_VIDEO_BYTES,UPLOAD_CHUNK_BYTES,assetLimit,validMediaDescriptor,decodeBase64,readMedia,detectedMime,mediaUrlKey} from './media.js';
import { sessionKeys } from "./keys.js";

const archive = new Archive(undefined, sessionKeys);
const SOURCE_BUILD = "0.4.0-archive-v1";
const UPLOAD_TTL = 60000, MAX_UPLOAD_BUFFER = 96 * 1024 * 1024;
let chain = Promise.resolve(), pending = 0;
const uploads = new Map();
const settings = async () => normalizeSettings((await chrome.storage.local.get("settings")).settings);
const configuration=async()=>{const stored=await chrome.storage.local.get(['settings','settingsRevision']);return {settings:normalizeSettings(stored.settings),settingsRevision:stored.settingsRevision||0};};
async function notifyStats() {
  await chrome.runtime.sendMessage({ type: "archiveStats", stats: await archive.stats() }).catch(() => {});
}
async function broadcast(message) {
  const tabs = await chrome.tabs.query({ url: ["https://www.facebook.com/*", "https://web.facebook.com/*", "https://www.messenger.com/*", "https://messenger.com/*"] });
  await Promise.allSettled(tabs.map(tab => chrome.tabs.sendMessage(tab.id, message)));
}
const exclusive = operation => {
  if (pending >= 16) return Promise.reject(new Error("errBusy"));
  pending++;
  const result = chain.then(operation); chain = result.catch(() => {}).finally(() => pending--); return result;
};
// Waits its turn instead of failing when the queue is momentarily full.
async function patient(operation) {
  for (;;) {
    try { return await exclusive(operation); }
    catch (error) { if (error.message !== "errBusy") throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
  }
}
const uploadOwner = sender => sender.tab?.id ?? "extension";
function pruneUploads(now = Date.now()) { for (const [id, upload] of uploads) if (now - upload.at > UPLOAD_TTL) uploads.delete(id); }
const uploadedBytes = () => [...uploads.values()].reduce((sum, upload) => sum + upload.bytes.byteLength, 0);
function receiveUpload(message, sender) {
  const { uploadId, offset, total, data } = message;
  if (typeof uploadId !== "string" || !/^[0-9a-f-]{36}$/.test(uploadId) || !Number.isSafeInteger(total) || total <= 0 || total > MAX_VIDEO_BYTES || !Number.isSafeInteger(offset) || offset < 0) throw Error("errInvalidMedia");
  pruneUploads();
  let upload = uploads.get(uploadId);
  if (!upload) {
    if (offset !== 0) throw Error("errInvalidMedia");
    if (uploadedBytes() + total > MAX_UPLOAD_BUFFER) throw Error("errBusy");
    upload = { owner: uploadOwner(sender), bytes: new Uint8Array(total), received: 0, at: Date.now() };
    uploads.set(uploadId, upload);
  }
  if (upload.owner !== uploadOwner(sender) || upload.bytes.byteLength !== total || offset !== upload.received) throw Error("errInvalidMedia");
  const part = decodeBase64(data);
  if (!part.length || part.length > UPLOAD_CHUNK_BYTES || offset + part.length > total) throw Error("errInvalidMedia");
  upload.bytes.set(part, offset); upload.received += part.length; upload.at = Date.now();
  return { received: upload.received };
}
const wantedMedia = (descriptor, config) => descriptor.kind === "file" ? config.saveFiles :
  descriptor.kind === "video" ? (descriptor.subtype === "gif" ? config.saveStickers : config.saveVideo) :
  descriptor.subtype === "gif" || descriptor.subtype === "sticker" ? config.saveStickers : true;
async function dispatch(message, sender) {
  if (!message) throw new Error("errInvalidRequest");
  const authorization = classifySender(sender, chrome.runtime.id);
  if (!authorization.kind) {
    const error = new Error(`errSource:${authorization.reason}`);
    error.code = "PFF_SOURCE_REJECTED";
    error.diagnostics = senderDiagnostics(sender, chrome.runtime.id, authorization.reason);
    throw error;
  }
  const ownPage = authorization.kind === "extension";
  const admin = () => { if (!ownPage) throw new Error("errExtensionOnly"); };
  switch (message.type) {
    case "config": return configuration();
    case "assetUpload": return receiveUpload(message, sender);
    case "assetUploadDiscard": {
      for (const id of Array.isArray(message.uploads) ? message.uploads.slice(0, 64) : []) if (uploads.get(id)?.owner === uploadOwner(sender)) uploads.delete(id);
      return {};
    }
    case "observe": {
      const config = await settings();
      const items = Array.isArray(message.items) ? message.items.slice(0, MAX_BATCH).map(item => item && ({
        account: item.account, thread: item.thread, id: item.id, token: typeof item.token === "string" ? item.token.slice(0, 80) : undefined,
        removed: item.removed === true, text: item.removed ? undefined : item.text, truncated: item.truncated === true,
        kind:item.kind==='emoji'?'emoji':undefined,media:!item.removed&&Array.isArray(item.media)?item.media.slice(0,MAX_ASSETS):undefined,
        tombstoneId: validId(item.tombstoneId) ? item.tombstoneId : undefined, ...(item.removed ? {} : messageMeta(item)),
      })) : [];
      let mediaSaved=0,mediaFailed=0,totalBytes=0;const consumed=[];
      for(const item of items){
        if(!item?.media?.length)continue;
        const policy=await archive.capturePolicy(item,config);
        item.assets=[];
        for(const descriptor of item.media){
          // An upload that will not be used is released now rather than at its timeout.
          const release=()=>{if(descriptor.upload&&uploads.get(descriptor.upload)?.owner===uploadOwner(sender))uploads.delete(descriptor.upload);};
          if(descriptor.skip||!policy.allowed||policy.skipKinds.includes(descriptor.kind)||!wantedMedia(descriptor,config)){release();continue;}
          try{
            if(!validMediaDescriptor(descriptor,sender.origin||new URL(sender.url).origin)||descriptor.error)throw Error('errInvalidMedia');
            const limit=assetLimit(descriptor.kind,config,descriptor.subtype);
            let asset,urlKey=null;
            if(descriptor.upload){
              const upload=uploads.get(descriptor.upload);
              if(!upload||upload.owner!==uploadOwner(sender)||upload.received!==upload.bytes.byteLength||upload.bytes.byteLength>limit)throw Error('errInvalidMedia');
              const mime=detectedMime(upload.bytes,null,descriptor.kind);
              if(!mime)throw Error('errMediaType');
              asset={kind:descriptor.kind,mime,data:upload.bytes};consumed.push(descriptor.upload);
            }
            else{
              if(descriptor.url.startsWith('blob:'))throw Error('errInvalidMedia');
              // The same CDN file is never fetched twice for one message.
              urlKey=await mediaUrlKey(descriptor.url);
              if(urlKey&&policy.assets.some(entry=>entry.kind===descriptor.kind&&entry.position===(descriptor.position??0)&&entry.urlKey===urlKey))continue;
              asset=await readMedia(await fetch(descriptor.url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(descriptor.kind==='video'?30000:10000)}),descriptor.kind,limit);
            }
            if(asset.kind!=='video'){totalBytes+=asset.data.byteLength;if(totalBytes>MAX_MESSAGE_MEDIA_BYTES)throw Error('errMediaLarge');}
            item.assets.push({...asset,position:descriptor.position,subtype:descriptor.subtype,name:descriptor.name,urlKey});mediaSaved++;
          }catch{release();mediaFailed++;}
        }
      }
      const commit = async () => {
        const restored = await archive.ingest(items, config); await notifyStats();
        for (const id of consumed) uploads.delete(id);
        const matched=new Set(restored.map(item=>item.token));
        return { restored,mediaSaved,mediaFailed, unmatched:items.filter(item=>item?.removed&&!matched.has(item.token)).map(({account,thread,id,token})=>({account,thread,id,token})) };
      };
      try { return await commit(); }
      catch (error) {
        if (error.name !== "QuotaExceededError") throw error;
        const stats = await archive.stats();
        // Make space once, then retry. Never create an unbounded retry queue.
        await archive.maintain({ ...config, maxBytes: Math.floor(stats.bytes * 0.75), maxMessages: Math.floor(stats.count * 0.75) });
        return commit();
      }
    }
    case "status": {
      admin();
      // Reading through the queue keeps a startup migration ordered before this;
      // the cleanup itself yields between slices so captures are not held up.
      const current=await patient(configuration);
      return { ...current, stats: await archive.maintain(current.settings,Date.now(),false,patient), sourceBuild: SOURCE_BUILD };
    }
    case 'capturePolicy': return archive.capturePolicy(message,await settings());
    case 'purgeMedia': {
      admin();
      const result=await archive.purgeMedia(message.kind,message.days,message.includeRemoved,await settings());
      await broadcast({type:'archiveChanged'});await notifyStats();return result;
    }
    case "save": {
      admin();
      if(!message.settings||typeof message.settings!=='object'||Array.isArray(message.settings))throw Error('errInvalidSettings');
      const {config,settingsRevision,policyChanged}=await patient(async()=>{
        const previous=await configuration(),config=normalizeSettings({...previous.settings,...message.settings});
        const settingsRevision=Math.max(Date.now(),previous.settingsRevision+1);
        await chrome.storage.local.set({ settings: config,settingsRevision });
        await broadcast({ type: "configUpdate", settings: config,settingsRevision });
        return {config,settingsRevision,policyChanged:['maxBytes','maxMessages','retentionDays','cleanupRemoved','imageRetentionDays','voiceRetentionDays','videoRetentionDays','fileRetentionDays'].some(key=>config[key]!==previous.settings[key])};
      });
      let maintenanceError=null;
      if(policyChanged){
        try{await archive.maintain(config,Date.now(),true,patient);}catch(error){maintenanceError=error.message;}
        await broadcast({type:'archiveChanged'});
      }
      await notifyStats();
      return { settings: config,settingsRevision,maintenanceError, stats: await archive.stats() };
    }
    case "list": {
      admin();
      const before = Array.isArray(message.before) && message.before.length === 4 && typeof message.before[0] === "number"
        && message.before.slice(1).every(v => typeof v === "string" && v.length <= 200) ? message.before : null;
      const query = typeof message.query === "string" ? message.query.slice(0, 200) : "";
      return archive.list({ state: message.state || "removed", before, query });
    }
    case 'asset':return archive.assetChunk({account:message.account,thread:message.thread,id:message.id,index:message.index,offset:message.offset},{any:ownPage});
    case "clear": {
      admin();
      await archive.clear();
      await chrome.storage.local.set({ archiveEpoch: Date.now() });
      await broadcast({ type: "archiveCleared" });
      await notifyStats();
      return { stats: await archive.stats() };
    }
    case "vaultStatus": admin(); return archive.vaultStatus();
    case "vaultEnable": {
      admin();
      const status = await archive.vaultEnable(message.password);
      // Older records are sealed in the background even if the page closes now.
      setTimeout(() => sealRemaining().catch(console.error), 0);
      return status;
    }
    case "vaultUnlock": {
      admin();
      const status = await archive.vaultUnlock(message.password);
      await broadcast({ type: "archiveChanged" });
      return status;
    }
    case "vaultLock": {
      admin();
      const status = await archive.vaultLock();
      await broadcast({ type: "archiveChanged" });
      return status;
    }
    case "vaultDisable": admin(); return archive.vaultBeginDisable(message.password);
    case "vaultMigrate": {
      admin();
      const after = Array.isArray(message.after) && message.after.length === 3 && message.after.every(validId) ? message.after : null;
      const slice = await archive.vaultSlice(after);
      if (slice.done) { await notifyStats(); await broadcast({ type: "archiveChanged" }); }
      return { ...slice, vault: await archive.vaultStatus() };
    }
    case "archiveImported": {
      admin();
      await broadcast({ type: "archiveChanged" });
      await notifyStats();
      return { stats: await archive.stats() };
    }
    default: throw new Error("errUnsupported");
  }
}
// These only read, or take the queue themselves around the part that needs it.
// Reading a saved file must not wait behind captures (each can fetch media for
// seconds) or fail because the queue is full: a photo being shown is read in
// many pieces, and IndexedDB keeps each piece consistent on its own.
const OWN_QUEUEING = new Set(["config", "assetUpload", "assetUploadDiscard", "capturePolicy", "status", "save", "asset"]);
const RPC_TYPES = ["config", "observe", "status", "save", "list", "clear", "asset", "capturePolicy", "purgeMedia", "assetUpload", "assetUploadDiscard", "vaultStatus", "vaultEnable", "vaultUnlock", "vaultLock", "vaultDisable", "vaultMigrate", "archiveImported"];
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Notifications sent to other extension views are not RPC requests. Ignoring
  // them avoids an unrelated listener racing the intended response on Chrome.
  if (!RPC_TYPES.includes(message?.type)) return;
  // Reading preferences must not wait behind a large media transaction. The
  // document-start bridge must receive persisted settings even when busy.
  (OWN_QUEUEING.has(message.type)?dispatch(message,sender):exclusive(() => dispatch(message, sender))).then(value => respond({ ok: true, ...value }),
    error => respond({ ok: false, error: error.message, code: error.code, diagnostics: error.diagnostics }));
  return true;
});
async function initialize() {
  const existing = await chrome.storage.local.get(['settings','settingsRevision']);
  const normalized=normalizeSettings(existing.settings||DEFAULTS);
  if(JSON.stringify(existing.settings)!==JSON.stringify(normalized))await chrome.storage.local.set({settings:normalized,settingsRevision:Math.max(Date.now(),(existing.settingsRevision||0)+1)});
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.alarms.create("archive-cleanup", { periodInMinutes: 30 });
}
const startUp = () => exclusive(initialize).then(async () => { await archive.maintain(await settings(), Date.now(), false, patient); await sealRemaining(); }).catch(console.error);
chrome.runtime.onInstalled.addListener(startUp);
chrome.runtime.onStartup.addListener(startUp);
chrome.storage.onChanged?.addListener((changes,area)=>{
  if(area==='local'&&changes.settings?.newValue)configuration().then(current=>broadcast({type:'configUpdate',...current})).catch(console.error);
});
// Finishes sealing after the options page closed, or for anything written just
// before a password was set. Only ever moves records toward the sealed state.
async function sealRemaining() {
  // New captures are sealed as they are written, so a full pass is only needed
  // while an enable has not finished.
  let after = null;
  do { after = (await patient(() => archive.vaultStatus().then(status => status.enabled && !status.disabling && status.sealing ? archive.vaultSlice(after) : { next: null }))).next; } while (after);
}
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "archive-cleanup") (async () => {const before=await archive.stats();const after=await archive.maintain(await settings(),Date.now(),false,patient);if(after.mediaPurged!==before.mediaPurged||after.evicted!==before.evicted)await broadcast({type:'archiveChanged'});await notifyStats();await sealRemaining();})().catch(console.error);
});
