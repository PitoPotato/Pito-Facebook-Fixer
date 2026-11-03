import { Archive } from "./archive.js";
import { DEFAULTS, MAX_BATCH, normalizeSettings, validId } from "./shared.js";
import { classifySender, senderDiagnostics } from "./sender.js";
import {MAX_ASSETS,MAX_MESSAGE_MEDIA_BYTES,validMediaDescriptor,decodeBase64,readMedia,detectedMime} from './media.js';

const archive = new Archive();
const SOURCE_BUILD = "0.2.0-i18n-brand-v1";
let chain = Promise.resolve(), pending = 0;
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
  if (pending >= 16) return Promise.reject(new Error("Kho đang bận; thử lại sau."));
  pending++;
  const result = chain.then(operation); chain = result.catch(() => {}).finally(() => pending--); return result;
};
async function dispatch(message, sender) {
  if (!message) throw new Error("Yêu cầu không hợp lệ.");
  const authorization = classifySender(sender, chrome.runtime.id);
  if (!authorization.kind) {
    const error = new Error(`Không xác thực được nguồn gửi (${authorization.reason}).`);
    error.code = "PFF_SOURCE_REJECTED";
    error.diagnostics = senderDiagnostics(sender, chrome.runtime.id, authorization.reason);
    throw error;
  }
  const ownPage = authorization.kind === "extension";
  switch (message.type) {
    case "config": return configuration();
    case "observe": {
      const config = await settings();
      const items = Array.isArray(message.items) ? message.items.slice(0, MAX_BATCH).map(item => item && ({
        account: item.account, thread: item.thread, id: item.id, token: typeof item.token === "string" ? item.token.slice(0, 80) : undefined,
        removed: item.removed === true, text: item.removed ? undefined : item.text, truncated: item.truncated === true,
        kind:item.kind==='emoji'?'emoji':undefined,media:!item.removed&&Array.isArray(item.media)?item.media.slice(0,MAX_ASSETS):undefined,
        tombstoneId: validId(item.tombstoneId) ? item.tombstoneId : undefined,
      })) : [];
      let mediaSaved=0,mediaFailed=0,totalBytes=0;
      for(const item of items){
        if(!item?.media?.length)continue;
        const policy=await archive.capturePolicy(item,config);
        item.assets=[];
        for(const descriptor of item.media){
          if(!policy.allowed||policy.skipKinds.includes(descriptor.kind))continue;
          try{
            if(!validMediaDescriptor(descriptor,sender.origin||new URL(sender.url).origin)||descriptor.error)throw Error('Unsupported media');
            let asset;
            if(descriptor.inline){
              const data=decodeBase64(descriptor.inline.data),mime=detectedMime(data,descriptor.inline.mime,descriptor.kind);
              if(!mime)throw Error('Invalid media content');asset={kind:descriptor.kind,mime,data};
            }
            else{
              if(descriptor.url.startsWith('blob:'))throw Error('Blob not captured');
              asset=await readMedia(await fetch(descriptor.url,{credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)}),descriptor.kind);
            }
            totalBytes+=asset.data.byteLength;if(totalBytes>MAX_MESSAGE_MEDIA_BYTES)throw Error('Batch media limit');
            item.assets.push({...asset,position:descriptor.position});mediaSaved++;
          }catch{mediaFailed++;}
        }
      }
      try {
        const restored = await archive.ingest(items, config);
        await notifyStats();
        const matched=new Set(restored.map(item=>item.token));
        return { restored,mediaSaved,mediaFailed, unmatched:items.filter(item=>item?.removed&&!matched.has(item.token)).map(({account,thread,id,token})=>({account,thread,id,token})) };
      }
      catch (error) {
        if (error.name !== "QuotaExceededError") throw error;
        const stats = await archive.stats();
        // Make space once, then retry. Never create an unbounded retry queue.
        await archive.maintain({ ...config, maxBytes: Math.floor(stats.bytes * 0.75), maxMessages: Math.floor(stats.count * 0.75) });
        const restored = await archive.ingest(items, config); await notifyStats();
        const matched=new Set(restored.map(item=>item.token));
        return { restored,mediaSaved,mediaFailed, unmatched:items.filter(item=>item?.removed&&!matched.has(item.token)).map(({account,thread,id,token})=>({account,thread,id,token})) };
      }
    }
    case "status": {
      if (!ownPage) throw new Error("Chỉ dùng trong extension.");
      const current=await configuration();
      return { ...current, stats: await archive.maintain(current.settings), sourceBuild: SOURCE_BUILD };
    }
    case 'capturePolicy': return archive.capturePolicy(message,await settings());
    case 'purgeMedia': {
      if(!ownPage)throw new Error('Chỉ dùng trong extension.');
      const result=await archive.purgeMedia(message.kind,message.days,message.includeRemoved,await settings());
      await broadcast({type:'archiveChanged'});await notifyStats();return result;
    }
    case "save": {
      if (!ownPage) throw new Error("Chỉ dùng trong extension.");
      if(!message.settings||typeof message.settings!=='object'||Array.isArray(message.settings))throw Error('Cài đặt không hợp lệ.');
      const previous=await configuration(),config=normalizeSettings({...previous.settings,...message.settings});
      const settingsRevision=Math.max(Date.now(),previous.settingsRevision+1);
      await chrome.storage.local.set({ settings: config,settingsRevision });
      await broadcast({ type: "configUpdate", settings: config,settingsRevision });
      let maintenanceError=null;
      const policyChanged=['maxBytes','maxMessages','retentionDays','cleanupRemoved','imageRetentionDays','voiceRetentionDays'].some(key=>config[key]!==previous.settings[key]);
      if(policyChanged){
        try{await archive.maintain(config,Date.now(),true);}catch(error){maintenanceError=error.message;}
        await broadcast({type:'archiveChanged'});
      }
      await notifyStats();
      return { settings: config,settingsRevision,maintenanceError, stats: await archive.stats() };
    }
    case "list": {
      if (!ownPage) throw new Error("Chỉ dùng trong extension.");
      const before = Array.isArray(message.before) && message.before.length === 4 && typeof message.before[0] === "number"
        && message.before.slice(1).every(v => typeof v === "string" && v.length <= 200) ? message.before : null;
      return { rows: await archive.listRemoved(before) };
    }
    case 'asset':return archive.assetChunk({account:message.account,thread:message.thread,id:message.id,index:message.index,offset:message.offset});
    case "clear": {
      if (!ownPage) throw new Error("Chỉ dùng trong extension.");
      await archive.clear();
      await chrome.storage.local.set({ archiveEpoch: Date.now() });
      await broadcast({ type: "archiveCleared" });
      await notifyStats();
      return { stats: await archive.stats() };
    }
    default: throw new Error("Yêu cầu không được hỗ trợ.");
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  // Notifications sent to other extension views are not RPC requests. Ignoring
  // them avoids an unrelated listener racing the intended response on Chrome.
  if (!["config", "observe", "status", "save", "list", "clear","asset","capturePolicy","purgeMedia"].includes(message?.type)) return;
  // Reading preferences must not wait behind a large media transaction. The
  // document-start bridge must receive persisted settings even when busy.
  (message.type==='config'?dispatch(message,sender):exclusive(() => dispatch(message, sender))).then(value => respond({ ok: true, ...value }),
    error => respond({ ok: false, error: error.message, code: error.code, diagnostics: error.diagnostics }));
  return true;
});
async function initialize() {
  const existing = await chrome.storage.local.get(['settings','settingsRevision']);
  const normalized=normalizeSettings(existing.settings||DEFAULTS);
  if(JSON.stringify(existing.settings)!==JSON.stringify(normalized))await chrome.storage.local.set({settings:normalized,settingsRevision:Math.max(Date.now(),(existing.settingsRevision||0)+1)});
  await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  await chrome.alarms.create("archive-cleanup", { periodInMinutes: 30 });
  await archive.maintain(await settings());
}
chrome.runtime.onInstalled.addListener(() => { exclusive(initialize).catch(console.error); });
chrome.runtime.onStartup.addListener(() => { exclusive(initialize).catch(console.error); });
chrome.storage.onChanged?.addListener((changes,area)=>{
  if(area==='local'&&changes.settings?.newValue)configuration().then(current=>broadcast({type:'configUpdate',...current})).catch(console.error);
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "archive-cleanup") exclusive(async () => {const before=await archive.stats();const after=await archive.maintain(await settings());if(after.mediaPurged!==before.mediaPurged||after.evicted!==before.evicted)await broadcast({type:'archiveChanged'});await notifyStats();}).catch(console.error);
});
