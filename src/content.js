import { CHANNEL, MAX_BATCH, accountId, validId } from "./shared.js";
import { validObservation } from "./archive.js";
import { nativeMessageId, tombstoneBubble } from "./adapter.js";
import {archivedMedia,sweepArchivedMedia,localizeArchivedMedia} from './media-render.js';
import {tr,localeFor} from './i18n.js';

(() => {
  let settings = null, settingsRevision=-1, queue = [], busy = false, stopped = false, generation = 0, pageAccount = null;
  const currentAccount = () => accountId() || pageAccount;
  let restoredCache = new WeakMap(), missingCache = new WeakMap(), redrawTimer = null, redrawSweep = null, repeatRedrawSweep = false;
  const redrawRows = new Set();
  const status = { connected: false, configured: false, savedBatches: 0, restored: 0, dropped: 0,mediaSaved:0,mediaFailed:0,error: null, errorCode: null, sourceDiagnostics: null, counters: {} };
  const post = (type, data = {}) => window.postMessage({ channel: CHANNEL, direction: "extension", type, ...data }, location.origin);
  async function rpc(message) {
    const result = await chrome.runtime.sendMessage(message);
    if (!result?.ok) {
      const error = Error(result?.error || "Không nhận được phản hồi từ kho tin nhắn.");
      error.code = result?.code; error.diagnostics = result?.diagnostics; throw error;
    }
    return result;
  }
  function configure(rescan = false) { if (settings) post("configure", { settings, settingsRevision,rescan }); }
  function acceptConfiguration(message){
    const revision=Number.isSafeInteger(message.settingsRevision)?message.settingsRevision:0;
    if(!message.settings||revision<settingsRevision)return;
    const wasEnabled=settings?.archive,wasAutoVoice=settings?.autoVoice,oldLanguage=settings?.language;settings=message.settings;settingsRevision=revision;
    if(!settings.archive){generation++;queue=[];removeOverlays();}
    configure(!wasEnabled&&settings.archive||!wasAutoVoice&&settings.autoVoice);
    if(settings.archive&&oldLanguage!==settings.language)for(const row of document.querySelectorAll('[data-pff-row]')){
      const saved=restoredCache.get(row);
      if(saved&&saved.nativeId===nativeMessageId(row)&&saved.item.account===currentAccount()&&patchApplied(saved))localizePatch(saved);
    }
  }
  function localizePatch(saved){
    const language=settings?.language||'en',note=tr('restorationNote',language)+(saved.item.truncated?tr('truncatedSuffix',language):'');
    const {target,attributes,nodes,media}=saved.patch;
    const values={title:`${note}\n${tr('savedAt',language,{date:new Date(saved.item.capturedAt).toLocaleString(localeFor(language))})}`,'aria-description':note};
    for(const [key,written] of Object.entries(values)){attributes[key].written=written;target.setAttribute(key,written);}
    if(saved.item.mediaPurged)for(let index=0;index<nodes.length;index++){nodes[index].written=index?'':tr('mediaPurged',language);nodes[index].node.data=nodes[index].written;}
    if(media)localizeArchivedMedia(media,language);
  }
  function patchApplied(saved) {
    return !!saved.patch && saved.patch.target.isConnected && saved.patch.nodes.every(({node, written}) =>
      saved.patch.target.contains(node) && node.data === written)&&(!saved.patch.media||saved.patch.media.parentElement===saved.patch.target);
  }
  function undoPatch(saved) {
    if (!saved?.patch) return;
    const {target, nodes, attributes} = saved.patch;
    saved.patch.dispose?.();saved.patch.media?.remove();
    for (const {node, original, written} of nodes) {
      if (target.contains(node) && node.data === written) node.data = original;
    }
    for (const [name, {original, written}] of Object.entries(attributes)) {
      if (target.getAttribute(name) !== written) continue;
      if (original === null) target.removeAttribute(name); else target.setAttribute(name, original);
    }
  }
  function removeOverlays() {
    redrawRows.clear(); redrawSweep = null; repeatRedrawSweep = false;
    for (const target of document.querySelectorAll('[data-pff-restored]')) {
      const row = target.closest('[data-pff-row]');
      undoPatch(row && restoredCache.get(row));
    }
    restoredCache = new WeakMap(); missingCache = new WeakMap();
  }
  function restore(item) {
    if (!settings?.archive || item.account !== currentAccount() || !/^pff-\d+$/.test(item.token)) return;
    const row = document.querySelector(`[data-pff-row="${item.token}"]`);
    if (!row || row.getAttribute("data-pff-key") !== JSON.stringify([item.account, item.thread, item.id])) return;
    missingCache.delete(row);
    const previous = restoredCache.get(row);
    if (previous && previous.nativeId === nativeMessageId(row) && patchApplied(previous)&&previous.item.account===item.account&&
      previous.item.text===item.text&&JSON.stringify((previous.item.assets||[]).map(a=>a.digest))===JSON.stringify((item.assets||[]).map(a=>a.digest))){
      // Alias/token refreshes still identify the same native message. Rebind
      // the lookup key without replacing a playing audio element or its URL.
      previous.item=item;return;
    }
    undoPatch(previous);
    const nativeId = nativeMessageId(row);
    // Keep the verified archive result even if Facebook hasn't mounted the
    // tombstone text yet. The DOM observer retries when its text arrives.
    restoredCache.set(row, {item, nativeId, patch:null});
    const target = tombstoneBubble(row);
    if (!target) return;
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) nodes.push({node:walker.currentNode, original:walker.currentNode.data, written:nodes.length ? "" : item.mediaPurged?tr('mediaPurged',settings.language):item.text});
    if (!nodes.length) return;
    const note = tr('restorationNote',settings.language) + (item.truncated ? tr('truncatedSuffix',settings.language) : "");
    const attributes = {};
    for (const [name, written] of Object.entries({
      "data-pff-restored": nativeId,
      "title": `${note}\n${tr('savedAt',settings.language,{date:new Date(item.capturedAt).toLocaleString(localeFor(settings.language))})}`,
      "aria-description": note,
    })) attributes[name] = {original:target.getAttribute(name), written};
    if(item.kind==='emoji')attributes.style={original:target.getAttribute('style'),written:`${target.getAttribute('style')||''};font-size:32px;line-height:1.25`};
    // Preserve Facebook's elements, classes, style and React-owned text nodes.
    // Only text data changes, so the native bubble remains the message bubble.
    const saved={item,nativeId,patch:{target,nodes,attributes}};
    restoredCache.set(row,saved);
    for (const [name, value] of Object.entries(attributes)) target.setAttribute(name, value.written);
    for (const {node, written} of nodes) node.data = written;
    if(item.assets?.length){
      const media=document.createElement('span');media.setAttribute('data-pff-media','');target.append(media);saved.patch.media=media;
      const key={account:item.account,thread:item.thread,id:item.id};
      saved.patch.dispose=archivedMedia(media,key,item.assets,rpc,()=>settings?.archive&&currentAccount()===saved.item.account&&
        row.isConnected&&nativeMessageId(row)===nativeId&&restoredCache.get(row)===saved,settings.language);
    }
    status.restored++;
  }
  const redrawObserver = new MutationObserver(mutations => {
    sweepArchivedMedia();
    if (!settings?.archive) return;
    for (const mutation of mutations) {
      const element = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
      const row = element?.closest('[data-pff-row]');
      if (!row || !restoredCache.has(row)) continue;
      const saved = restoredCache.get(row);
      if (saved.nativeId === nativeMessageId(row) && patchApplied(saved)) continue;
      if (redrawRows.size < 64) redrawRows.add(row);
      else if (!redrawSweep) redrawSweep = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
      else repeatRedrawSweep = true;
    }
    if (!redrawRows.size || redrawTimer) return;
    redrawTimer = setTimeout(redraw, 0);
  });
  function redraw() {
      redrawTimer = null;
      const rows = [...redrawRows]; redrawRows.clear();
      for (const row of rows) {
        const saved = restoredCache.get(row);
        if (!row.isConnected || !saved || !settings?.archive) continue;
        if (nativeMessageId(row) !== saved.nativeId) {
          undoPatch(saved); restoredCache.delete(row); continue;
        }
        restore(saved.item);
      }
      while (redrawSweep && redrawRows.size < 64) {
        const row = redrawSweep.nextNode();
        if (!row) {
          redrawSweep = repeatRedrawSweep ? document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT) : null;
          repeatRedrawSweep = false;
        } else if (restoredCache.has(row) && !patchApplied(restoredCache.get(row))) redrawRows.add(row);
      }
      if (redrawRows.size || redrawSweep) redrawTimer = setTimeout(redraw, 0);
  }
  const watchRedraw = () => redrawObserver.observe(document.documentElement, { childList: true, characterData: true, subtree: true,
    attributes:true, attributeFilter:["data-message-id", "data-mid", "id"] });
  if (document.documentElement) watchRedraw(); else document.addEventListener("DOMContentLoaded", watchRedraw, { once: true });
  async function drain() {
    if (busy || stopped || !settings?.archive) return;
    busy = true;
    try {
      while (queue.length && !stopped && settings.archive) {
        const job = queue.shift(), batch = job.items, epoch = job.generation;
        let response;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { response = await rpc({ type: "observe", items: batch }); break; }
          catch (error) {
            status.error = error.message;
            status.errorCode = error.code || null; status.sourceDiagnostics = error.diagnostics || null;
            if (/context invalidated|receiving end does not exist/i.test(error.message)) { stopped = true; queue = []; break; }
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 750 * (attempt + 1)));
          }
        }
        if (!response) { status.dropped += batch.length; post("observationsAck", {batchId:job.batchId}); continue; }
        status.savedBatches++; status.error = null; status.errorCode = null; status.sourceDiagnostics = null;
        status.mediaSaved+=response.mediaSaved||0;status.mediaFailed+=response.mediaFailed||0;
        if (epoch === generation) {
          for (const item of response.unmatched || []) {
            if(item.account!==currentAccount()||!/^pff-\d+$/.test(item.token))continue;
            const row=document.querySelector(`[data-pff-row="${item.token}"]`);
            if(row?.getAttribute('data-pff-key')===JSON.stringify([item.account,item.thread,item.id]))missingCache.set(row,{nativeId:nativeMessageId(row),key:row.getAttribute('data-pff-key')});
          }
          for (const item of response.restored || []) restore(item);
        }
        post("observationsAck", {batchId:job.batchId});
      }
    } finally { busy = false; }
  }
  window.addEventListener("message", event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.channel !== CHANNEL || data.direction !== "page") return;
    if (["status", "observations"].includes(data.type) && typeof data.account === "string" && /^[1-9]\d{0,199}$/.test(data.account)) {
      if (pageAccount && pageAccount !== data.account) { generation++; queue = []; removeOverlays(); }
      pageAccount = data.account;
    }
    if (data.type === "ready") { status.connected = true; configure(); }
    if(data.type==='voicePolicy'&&settings?.archive&&data.account===currentAccount()&&Number.isSafeInteger(data.requestId)){
      const row=typeof data.token==='string'&&/^pff-\d+$/.test(data.token)?document.querySelector(`[data-pff-row="${data.token}"]`):null;
      if(row?.getAttribute('data-pff-key')!==JSON.stringify([data.account,data.thread,data.id]))return;
      rpc({type:'capturePolicy',account:data.account,thread:data.thread,id:data.id}).then(result=>post('voicePolicyResult',{requestId:data.requestId,allowed:result.allowed&&!result.skipKinds.includes('voice')})).catch(()=>post('voicePolicyResult',{requestId:data.requestId,allowed:false}));
    }
    if (data.type === "status") {
      status.connected = true; status.configured = data.configured === true;
      status.appliedSettingsRevision=Number.isSafeInteger(data.settingsRevision)?data.settingsRevision:-1;
      const clean = {};
      for (const key of ["messagesObserved", "tombstonesObserved", "unidentifiedRows", "storyBlocked", "focusBlocked", "reloadSignalsBlocked", "navigationsBlocked", "queueDropped", "missingAccount", "missingMessageId", "missingThread", "missingText", "adapterErrors", "voiceAutoLoaded", "voiceAutoFailed"]) {
        clean[key] = Number.isSafeInteger(data.counters?.[key]) ? data.counters[key] : 0;
      }
      status.counters = clean;
    }
    if (data.type === "observations" && settings?.archive && Array.isArray(data.items)) {
      if (!Number.isSafeInteger(data.batchId) || data.batchId < 1) return;
      const account = currentAccount();
      const items = [];
      for (const item of data.items.slice(0, MAX_BATCH)) {
        if (!validObservation(item) || item.account !== account || !validId(item.token) || !/^pff-\d+$/.test(item.token)) continue;
        items.push({ account: item.account, thread: item.thread, id: item.id, token: item.token,
          removed: item.removed === true, text: item.removed ? undefined : item.text, truncated: item.truncated === true,
          kind:item.kind==='emoji'?'emoji':undefined,media:item.removed?undefined:item.media,
          tombstoneId: validId(item.tombstoneId) ? item.tombstoneId : undefined });
      }
      // MAIN sends the next batch only after this one commits. An extra slot
      // permits an archive reset/reconfigure while an old request is finishing.
      if (queue.length >= 2) return;
      queue.push({batchId:data.batchId, items, generation});
      drain();
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message.type === "tabStatus") {
      const visible={restored:0,waitingForDom:0,unmatched:0};
      for(const row of document.querySelectorAll('[data-pff-row]')){
        const saved=restoredCache.get(row),missing=missingCache.get(row);
        if(saved&&saved.nativeId===nativeMessageId(row)&&saved.item.account===currentAccount()){
          if(patchApplied(saved))visible.restored++;else visible.waitingForDom++;
        }else if(missing&&missing.nativeId===nativeMessageId(row)&&missing.key===row.getAttribute('data-pff-key')&&tombstoneBubble(row))visible.unmatched++;
      }
      respond({ ...status, visible, settingsRevision,settings:settings?{...settings}:null,accountDetected: !!currentAccount(), archiveEnabled: settings?.archive === true }); return;
    }
    if (message.type === "configUpdate") {
      acceptConfiguration(message);respond({ ok: true });
    }
    if (message.type === "archiveCleared") {
      generation++; queue = []; removeOverlays(); post("resetArchive"); respond({ ok: true });
    }
    if(message.type==='archiveChanged'){
      generation++;queue=[];removeOverlays();post('refreshArchive');respond({ok:true});
    }
  });
  async function loadConfiguration(){
    for(let attempt=0;attempt<5;attempt++){
      try{const result=await rpc({type:'config'});acceptConfiguration(result);status.error=null;post('ping');return;}
      catch(error){status.error=error.message;status.errorCode=error.code||null;status.sourceDiagnostics=error.diagnostics||null;if(attempt<4)await new Promise(resolve=>setTimeout(resolve,250*2**attempt));}
    }
  }
  loadConfiguration();
})();
