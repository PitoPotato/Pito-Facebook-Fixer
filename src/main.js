import { CHANNEL, DEFAULTS, MAX_BATCH, accountId } from "./shared.js";
import { installFocusGuard, installReloadGuard } from "./guards.js";
import { installMessageAdapter } from "./adapter.js";
import {installVoiceCapture,releaseVoicePayloads} from './media-dom.js';
import {readMedia,encodeBase64,MAX_MESSAGE_MEDIA_BYTES} from './media.js';

(() => {
  if (window.__pffInstalled) return;
  Object.defineProperty(window, "__pffInstalled", { value: true });
  // Hooks may be installed early, but no feature activates before hydration.
  let config = Object.fromEntries(Object.entries(DEFAULTS).map(([key,value])=>[key,typeof value==='boolean'?false:value])), configured = false, queue = [], flushTimer = null, inFlight = null, batchSerial = 0, captureController = null;
  const counters = { messagesObserved: 0, tombstonesObserved: 0, unidentifiedRows: 0,
    storyBlocked: 0, focusBlocked: 0, reloadSignalsBlocked: 0, navigationsBlocked: 0, queueDropped: 0,
    missingAccount: 0, missingMessageId: 0, missingThread: 0, missingText: 0, adapterErrors: 0, voiceAutoLoaded:0,voiceAutoFailed:0 };
  let statusTimer;
  let sentItems=[],policySerial=0;const policyRequests=new Map();
  const send = (type, data) => window.postMessage({ channel: CHANNEL, direction: "page", type, ...data }, location.origin);
  const count = name => {
    if (!(name in counters)) return;
    counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + 1);
    if (!statusTimer) statusTimer = setTimeout(() => { statusTimer = null; sendStatus(); }, 1000);
  };
  const sendStatus = () => send("status", { counters, configured, account: accountId(),settingsRevision });
  let settingsRevision=-1;
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
        if(asset.inline||asset.stored||!asset.url.startsWith('blob:'))continue;
        try{
          const loaded=await readMedia(await fetch(asset.url,{signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])}),asset.kind);
          total+=loaded.data.length;if(total>MAX_MESSAGE_MEDIA_BYTES)throw Error('Media limit');
          asset.inline={mime:loaded.mime,data:encodeBase64(loaded.data)};
        }catch{asset.error='unavailable';}
      }
    }
    if(inFlight===batchId&&config.archive){sentItems=items;send("observations", { batchId, items, account:accountId() });}
  }
  const adapter = installMessageAdapter(() => config, item => {
    // Backpressure: leave an unaccepted row dirty in the adapter. Never drop
    // earlier captures/removals to make room for a burst of new observations.
    if (queue.length >= 128) return false;
    queue.push(item); if (!flushTimer && !inFlight) flushTimer = setTimeout(flush, 0);
    return true;
  }, count);
  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.channel !== CHANNEL || data.direction !== "extension") return;
    if (data.type === "observationsAck" && data.batchId === inFlight) {
      releaseVoicePayloads(sentItems);sentItems=[];
      inFlight = null; if (queue.length && !flushTimer) flushTimer = setTimeout(flush, 0);
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
      if (!config.archive) { releaseVoicePayloads([...queue,...sentItems]);sentItems=[];queue = []; inFlight = null; captureController?.abort();adapter.reset(); }
      else if (firstConfiguration || !previousArchive || data.rescan) adapter.rescan();
      if (queue.length && !flushTimer) flushTimer = setTimeout(flush, 0);
      sendStatus();
    } else if (data.type === "resetArchive"||data.type==='refreshArchive') { queue = []; inFlight = null;releaseVoicePayloads(sentItems);sentItems=[];captureController?.abort();adapter.reset();if(data.type==='refreshArchive')adapter.rescan(); }
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
