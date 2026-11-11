import { CHANNEL, DEFAULTS, MAX_BATCH, accountId } from "./shared.js";
import { installFocusGuard, installReloadGuard } from "./guards.js";
import { installMessageAdapter } from "./adapter.js";
import { installBridgeAdapter } from "./bridge.js";
import {installVoiceCapture,releaseVoicePayloads} from './media-dom.js';
import {readBlobMedia,assetLimit,MAX_MESSAGE_MEDIA_BYTES} from './media.js';

// A failed commit keeps its messages. Retries are few, spaced out and capped so
// that a broken archive cannot grow memory or keep the page busy.
const RETRY_DELAYS = [5000, 20000, 60000], MAX_RETRY_ITEMS = 128, MAX_RETRY_BYTES = 64 * 1024 * 1024;
const retryKey = item => `${item.account}|${item.id}`;

(() => {
  if (window.__pffInstalled) return;
  Object.defineProperty(window, "__pffInstalled", { value: true });
  // Hooks may be installed early, but no feature activates before hydration.
  let config = Object.fromEntries(Object.entries(DEFAULTS).map(([key,value])=>[key,typeof value==='boolean'?false:value])), configured = false, queue = [], flushTimer = null, inFlight = null, batchSerial = 0, captureController = null;
  const counters = { messagesObserved: 0, tombstonesObserved: 0, unidentifiedRows: 0,
    storyBlocked: 0, focusBlocked: 0, reloadSignalsBlocked: 0, navigationsBlocked: 0, queueDropped: 0,
    missingAccount: 0, missingMessageId: 0, missingThread: 0, missingText: 0, adapterErrors: 0, voiceAutoLoaded:0,voiceAutoFailed:0,
    bridgeActive: 0, bridgeMessages: 0, bridgeRescued: 0, bridgeRecalls: 0, bridgeErrors: 0 };
  let statusTimer;
  let sentItems=[],policySerial=0,retryGroups=[],retryGeneration=0;const policyRequests=new Map();
  const send = (type, data) => window.postMessage({ channel: CHANNEL, direction: "page", type, ...data }, location.origin);
  const count = name => {
    if (!(name in counters)) return;
    counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + 1);
    if (!statusTimer) statusTimer = setTimeout(() => { statusTimer = null; sendStatus(); }, 1000);
  };
  const sendStatus = () => send("status", { counters, configured, account: accountId(),settingsRevision });
  let settingsRevision=-1;
  function cancelRetries(){retryGeneration++;retryGroups=[];}
  const retained=()=>retryGroups.reduce((sum,group)=>sum+group.items.length,0);
  const retainedBytes=()=>retryGroups.reduce((sum,group)=>sum+group.items.reduce((total,item)=>total+(item.media||[]).reduce((size,asset)=>size+(asset.blob?.size||0),0),0),0);
  function scheduleRetry(items){
    const keep=[],dropped=[];let bytes=retainedBytes();
    for(const item of items){
      item.retries=(item.retries||0)+1;
      if(item.retries>RETRY_DELAYS.length||retained()+keep.length>=MAX_RETRY_ITEMS){count('queueDropped');dropped.push(item);continue;}
      for(const asset of item.media||[]){
        delete asset.error; // the next attempt reads the media again
        if(asset.blob){if(bytes+asset.blob.size>MAX_RETRY_BYTES){delete asset.blob;asset.error='unavailable';}else bytes+=asset.blob.size;}
      }
      keep.push(item);
    }
    releaseVoicePayloads(dropped);
    // A dropped row is read again on its next change or scroll.
    for(const item of dropped)adapter.forget(item.token);
    if(!keep.length)return;
    const group={items:keep,keys:new Set(keep.map(retryKey))};
    // Anything later about the same message, a newer capture or a recall, waits
    // behind it and is committed after it, in order. Committed first, a recall
    // would find nothing, and an older capture replayed last would overwrite a
    // newer one. The archive's normal merge then keeps the fuller version.
    queue=queue.filter(item=>!(group.keys.has(retryKey(item))&&(group.items.push(item),true)));
    retryGroups.push(group);
    const generation=retryGeneration;
    setTimeout(()=>{
      if(generation!==retryGeneration)return;
      retryGroups=retryGroups.filter(other=>other!==group);
      if(!config.archive)return;
      queue.unshift(...group.items);if(!flushTimer&&!inFlight)flushTimer=setTimeout(flush,0);
    },RETRY_DELAYS[Math.max(...keep.map(item=>item.retries||1))-1]);
  }
  async function flush() {
    flushTimer = null;
    if (!configured || inFlight || !config.archive || !queue.length) return;
    inFlight = ++batchSerial;
    const controller=new AbortController();captureController=controller;
    const batchId=inFlight,firstMedia=queue.findIndex(item=>item.media?.length);
    const items=queue.splice(0,firstMedia===0?1:firstMedia>0?Math.min(firstMedia,MAX_BATCH):MAX_BATCH);
    for(const item of items){
      let total=0;
      for(const asset of item.media||[]){
        if(controller.signal.aborted)break;
        if(asset.blob||asset.stored||asset.error||!asset.url.startsWith('blob:'))continue;
        try{
          const loaded=await readBlobMedia(await fetch(asset.url,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])}),asset.kind,assetLimit(asset.kind,config,asset.subtype));
          if(asset.kind!=='video'){total+=loaded.blob.size;if(total>MAX_MESSAGE_MEDIA_BYTES)throw Error('errMediaLarge');}
          asset.blob=loaded.blob;
        }catch{asset.error='unavailable';}
      }
    }
    if(inFlight===batchId&&config.archive){sentItems=items;send("observations", { batchId, items, account:accountId() });}
  }
  const accept = item => {
    const group = retryGroups.find(candidate => candidate.keys.has(retryKey(item)));
    if (group) {
      if (group.items.length >= MAX_RETRY_ITEMS) return false;
      // Joining items share the retry byte budget; media over it is not held.
      let bytes = retainedBytes();
      for (const asset of item.media || []) if (asset.blob) { if (bytes + asset.blob.size > MAX_RETRY_BYTES) { delete asset.blob; asset.error = 'unavailable'; } else bytes += asset.blob.size; }
      group.items.push(item); return true;
    }
    // Backpressure: leave an unaccepted row dirty in the adapter. Never drop
    // earlier captures/removals to make room for a burst of new observations.
    if (queue.length >= 128) return false;
    queue.push(item); if (!flushTimer && !inFlight) flushTimer = setTimeout(flush, 0);
    return true;
  };
  const adapter = installMessageAdapter(() => config, accept, count);
  // Messenger can deliver decrypted messages before the settings arrive; hold a
  // bounded number until then instead of dropping them.
  let early = [];
  const bridgeOn = () => config.archive && config.bridgeCapture !== false;
  installBridgeAdapter(() => configured ? config : { archive: true, bridgeCapture: true }, item => {
    if (!configured) { if (early.length >= 256) return false; early.push(item); return true; }
    return bridgeOn() ? accept(item) : false;
  }, count);
  // A recall committed by the data source names the tombstone that replaces the
  // message; a row already showing it is read again so the saved copy appears.
  function recheck(batch) {
    for (const item of batch) {
      if (!item.recheck) continue;
      const row = document.querySelector(`[data-message-id="${CSS.escape(item.recheck)}"],[data-mid="${CSS.escape(item.recheck)}"]`);
      if (row) adapter.mediaChanged(row);
    }
  }
  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.channel !== CHANNEL || data.direction !== "extension") return;
    if (data.type === "observationsAck" && data.batchId === inFlight) {
      const batch=sentItems;sentItems=[];inFlight=null;
      if(data.failed===true)scheduleRetry(batch);else {releaseVoicePayloads(batch);recheck(batch);}
      if (queue.length && !flushTimer) flushTimer = setTimeout(flush, 0);
      return;
    }
    if(data.type==='voicePolicyResult'){const resolve=policyRequests.get(data.requestId);if(resolve){policyRequests.delete(data.requestId);resolve(data.allowed===true);}return;}
    if (data.type === "configure" && data.settings) {
      const revision=Number.isSafeInteger(data.settingsRevision)?data.settingsRevision:0;
      if(revision<settingsRevision)return;
      settingsRevision=revision;
      const firstConfiguration = !configured;
      const previousArchive = config.archive;
      for (const key of Object.keys(DEFAULTS)) if (typeof data.settings[key] === typeof DEFAULTS[key]) config[key] = data.settings[key];
      configured = true;
      const held = early; early = [];
      if (bridgeOn()) for (const item of held) accept(item);
      if (!config.archive) { releaseVoicePayloads([...queue,...sentItems]);sentItems=[];queue = []; inFlight = null; captureController?.abort();cancelRetries();adapter.reset(); }
      else if (firstConfiguration || !previousArchive || data.rescan) adapter.rescan();
      if (queue.length && !flushTimer) flushTimer = setTimeout(flush, 0);
      sendStatus();
    } else if (data.type === "resetArchive"||data.type==='refreshArchive') { queue = []; inFlight = null;releaseVoicePayloads(sentItems);sentItems=[];captureController?.abort();cancelRetries();adapter.reset();if(data.type==='refreshArchive')adapter.rescan(); }
    else if (data.type === "ping") send("ready", {});
  });
  // Module-based account identity can appear after the document-start scan.
  // Retry briefly, with a fixed upper bound rather than a permanent poller.
  let identityRetries = 0;
  const retryIdentity = () => {
    if (!config.archive) return;
    if (accountId()) { adapter.rescan(); sendStatus(); return; }
    if (++identityRetries < 10) setTimeout(retryIdentity, 1000);
  };
  document.addEventListener("DOMContentLoaded", retryIdentity, { once: true });
  installFocusGuard(() => config, count);
  installReloadGuard(() => config, count);
  installVoiceCapture(()=>config,row=>adapter.mediaChanged(row),item=>new Promise(resolve=>{
    const requestId=++policySerial;policyRequests.set(requestId,resolve);send('voicePolicy',{account:item.account,thread:item.thread,id:item.id,token:item.token,requestId});
    setTimeout(()=>{if(policyRequests.delete(requestId))resolve(false);},4000);
  }),count);

  // Story privacy is under development. Leave fetch/XHR completely native.
  send("ready", {});
})();
