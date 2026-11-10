import { MAX_TEXT, accountId, canonicalMessageId } from "./shared.js";
import {textWithEmoji,emojiOnly} from './media.js';
import {collectMedia,voiceRow,requestVoicePreload} from './media-dom.js';

export const ROW_SELECTOR = '[data-message-id],[data-mid],[id^="mid."],[role="row"]';
const scalar = value => {
  if (typeof value === "string" && value.length <= 200) return value;
  if (typeof value === "bigint" || (typeof value === "number" && Number.isSafeInteger(value))) return String(value);
  // Meta uses I64 tuples for thread keys; let its own converter interpret them.
  if (Array.isArray(value) && value.length === 2 && value.every(Number.isInteger)) {
    try { const out = window.require?.("I64")?.to_string?.(value); if (/^\d+$/.test(out)) return out; } catch {}
  }
  return null;
};
const fromURL = value => {
  try {
    if (!value) return null;
    const url = new URL(value, location.origin);
    if (url.origin !== location.origin) return null;
    return url.searchParams.get("thread_id") || url.pathname.match(/\/(?:messages\/(?:e2ee\/)?)?t\/([^/]+)/)?.[1] || null;
  }
  catch { return null; }
};
function modelFromReact(row) {
  let message = null, thread = null;
  // Only inspect known message/thread props. No whole React-tree crawl or cache.
  let fiber = row[Object.keys(row).find(key => key.startsWith("__reactFiber$") || key.startsWith("__reactInternalInstance$"))];
  for (let hops = 0; fiber && hops < 16; hops++, fiber = fiber.return) {
    const props = fiber.memoizedProps;
    if (!props || typeof props !== "object") continue;
    thread ||= scalar(props.threadKey ?? props.threadId ?? props.threadID ?? props.thread?.threadKey ?? props.thread?.id);
    for (const candidate of [props.message, props.messageData, props.message?.message, props]) {
      if (!candidate || typeof candidate !== "object") continue;
      const id = scalar(candidate.messageId ?? candidate.message_id ?? candidate.messageID);
      if (id) {
        message ||= { ...pickMessage(candidate), id };
        thread ||= scalar(candidate.threadKey ?? candidate.threadId ?? candidate.thread_id);
      }
    }
    if (message && thread) break;
  }
  return { message, thread };
}
const timestampOf = value => {
  const out = Number(scalar(value));
  return Number.isSafeInteger(out) && out >= 1e12 && out <= 4e12 ? out : undefined;
};
function pickMessage(value) {
  const text = typeof value.text === "string" ? value.text :
    typeof value.body === "string" ? value.body : typeof value.text?.text === "string" ? value.text.text : null;
  const reply = value.replySnippet ?? value.reply_snippet;
  return { text, removed: value.isUnsent === true || value.is_unsent === true || value.isUnsentMessage === true ||
    value.message_unsendability_status === "deny_tombstone_message",
    senderId: scalar(value.senderId ?? value.sender_id ?? value.senderID ?? value.authorId ?? value.author_id) || undefined,
    sentAt: timestampOf(value.timestampMs ?? value.timestamp_ms ?? value.timestamp),
    replyText: typeof reply === "string" ? reply : undefined };
}
// English and Vietnamese wordings were checked on Facebook. The others follow
// published translations and are UNVERIFIED until tested on a live account; they
// are kept to the specific "unsent" phrasing so ordinary sentences don't match.
const TOMBSTONES = [
  /^(?:you|.+?) (?:unsent|removed|deleted) a message\.?$/i,
  /^(?:bạn|.+?) đã (?:thu hồi|xóa|xoá) (?:một )?tin nhắn\.?$/i,
  /^(?:anulaste|.+? anuló) el envío de un mensaje\.?$/i,
  /^(?:vous avez|.+? a) retiré un message\.?$/i,
  /^(?:du hast|.+? hat) eine nachricht (?:zurückgerufen|zurückgezogen)\.?$/i,
  /^(?:hai|.+? ha) annullato l['’]invio di un messaggio\.?$/i,
  /^(?:você|.+?) cancelou o envio de uma mensagem\.?$/i,
  /^(?:anda|.+?) membatalkan pengiriman pesan\.?$/i,
];
export function tombstone(text) {
  const normalized = text.replace(/\s+/g, " ").trim();
  return TOMBSTONES.some(pattern => pattern.test(normalized));
}
export function nativeMessageId(row) {
  return canonicalMessageId(row.getAttribute("data-message-id") || row.getAttribute("data-mid") || row.id);
}
export function restoredBubble(row) {
  return row.matches('[data-pff-restored]') ? row : row.querySelector('[data-pff-restored]');
}
export function tombstoneBubble(row) {
  const excluded = 'button,[role="button"],a,[contenteditable="true"],blockquote,[role="heading"],h1,h2,h3,h4,h5,h6';
  const leaves = [...row.querySelectorAll('[dir="auto"],[data-message-text]')].filter(node =>
    !node.querySelector('[dir="auto"],[data-message-text]') && !node.closest(excluded) && tombstone(node.textContent || ""));
  // Change the existing text holder only; never replace the whole message row
  // (which can also contain controls, sender names and delivery status).
  if (leaves.length === 1) return leaves[0];
  if (!row.children.length && tombstone(row.textContent || "")) return row;
  return null;
}
function messageLeaves(row) {
  return [...row.querySelectorAll('[dir="auto"]')].filter(node =>
    !node.querySelector('[dir="auto"]') &&
    !node.closest('[role="button"],button,a,[contenteditable="true"],blockquote,[role="heading"],h1,h2,h3,h4,h5,h6,[data-pff-host],[data-pff-restored]'));
}
export function describeRow(row, skipped = () => {}, options = {}) {
  if (!row.isConnected || row.closest('[data-pff-host]')) return null;
  const fail = reason => { skipped(reason); return null; };
  const account = accountId(); if (!account) return fail("missingAccount");
  const { message, thread: reactThread } = modelFromReact(row);
  const nativeId = row.getAttribute("data-message-id") || row.getAttribute("data-mid") ||
    (row.id.startsWith("mid.") ? row.id : null) || message?.id;
  if (!nativeId || nativeId.length > 200) return fail("missingMessageId");
  if (/@msgrCUTOVER\./.test(nativeId)) return null; // Encryption notice, not a user message.
  const id = canonicalMessageId(nativeId);
  const restored = restoredBubble(row);
  // Our replacement text must never be mistaken for a new Facebook message.
  // A recycled row is ignored until the isolated renderer removes its patch.
  if (restored && restored.getAttribute('data-pff-restored') !== id) return null;
  // A message identity is required. Text/position are never used as keys.
  const container = row.closest('[data-thread-id],[data-thread-key],[role="log"],[role="dialog"],[role="grid"]');
  const thread = id.startsWith("msgr.") ? "by-message-id" : row.getAttribute("data-thread-id") || container?.getAttribute("data-thread-id") ||
    container?.getAttribute("data-thread-key") || reactThread ||
    nativeId.match(/^(\d+)@msgr\./)?.[1] ||
    fromURL(container?.querySelector('a[href*="/t/"],a[href*="thread_id="]')?.getAttribute("href")) || fromURL(location.href) ||
    (/^mid\./.test(id) ? "by-message-id" : null);
  // Facebook message IDs are globally unique. A popup without an exposed
  // thread key can still be keyed by its actual message ID, never its title.
  if (!thread || thread.length > 200) return fail("missingThread");
  const explicitNode=row.querySelector('[data-message-text]');
  const explicitText = explicitNode?textWithEmoji(explicitNode):undefined;
  const leaves = messageLeaves(row);
  const normalized = value => value.replace(/\s+/g, " ").trim();
  const accessibleLabel = normalized(row.getAttribute("aria-label") || "");
  // Real Messenger rows also contain delivery status (e.g. "Sent") and reply
  // previews. Facebook's row label names the actual payload after the sender.
  // Select the matching leaf, keeping the original whitespace for storage.
  const labelledLeaves = leaves.filter(node => {
    const content = normalized(textWithEmoji(node));
    return content && accessibleLabel.endsWith(`: ${content}`);
  });
  const labelledTexts = [...new Set(labelledLeaves.map(textWithEmoji))];
  const labelledText = labelledTexts.length === 1 ? labelledTexts[0] : undefined;
  let text = restored ? undefined : message?.text || explicitText || labelledText;
  const leafText = leaves.length === 1 ? textWithEmoji(leaves[0]) : null;
  // textContent, not innerText: reading innerText forces a layout on every row.
  const rowText = () => leaves.map(node => node.textContent || "").find(tombstone) || leafText || row.textContent || "";
  // Known message content wins over tombstone wording: a person can literally
  // send "You unsent a message" as an ordinary message.
  const hasKnownContent = typeof text === "string" && text.length > 0;
  const removed = !!restored || message?.removed || row.getAttribute("data-is-unsent") === "true" || (!hasKnownContent && tombstone(rowText()));
  if (!removed && text == null) {
    // Conservative DOM fallback: a single text bubble, no quote/reply ambiguity.
    if (leaves.length === 1) text = leafText;
  }
  const media=removed?[]:collectMedia(row,options);
  if((media.length||(!message?.text&&!explicitText&&!labelledText))&&/^(?:sent|delivered|seen|đã gửi|đã nhận|đã xem|\d{1,2}:\d{2})$/i.test(text||''))text='';
  if(!removed&&voiceRow(row))text=''; // Never archive a timer or delivery state as the voice body.
  const waitingVoice=!removed&&voiceRow(row)&&!media.length;
  if (!removed && (typeof text !== "string" || !text.trim())&&!media.length&&!waitingVoice) return fail("missingText");
  const payload = typeof text === "string" ? normalized(text) : "";
  const identityStamp = payload && accessibleLabel.endsWith(`: ${payload}`) ? accessibleLabel.slice(0, -payload.length - 2) : accessibleLabel;
  const details = removed ? {} : {
    senderId: message?.senderId, sentAt: message?.sentAt, label: identityStamp || undefined,
    senderName: normalized(row.querySelector('h1,h2,h3,h4,h5,h6,[role="heading"]')?.textContent || '').slice(0, 120) || undefined,
    replyText: message?.replyText || normalized(row.querySelector('blockquote')?.textContent || '').slice(0, 500) || undefined,
  };
  return { account, thread, id, nativeId, identityStamp, removed: !!removed, text: removed ? undefined : (text||'').slice(0, MAX_TEXT),
    media,waitingVoice,kind:!media.length&&emojiOnly(text)?'emoji':undefined,truncated: !removed && (text||'').length > MAX_TEXT, ...details };
}

const SCROLL_QUIET_MS = 120, SCROLL_MAX_WAIT_MS = 400, MAX_SCOPES = 64, SCOPE_PRUNE_MS = 30000;
const SCOPE_SELECTOR = '[data-thread-id],[data-thread-key],[role="log"],[role="dialog"],[role="grid"]';
const DETAIL_OPTIONS = { subtree: true, characterData: true, attributes: true, attributeFilter: ["src", "srcset", "alt"] };
// The identity attributes of a row. If these and its DOM are unchanged, reading
// the row again cannot give a different answer.
const rowKey = row => [row.getAttribute("data-message-id"), row.getAttribute("data-mid"), row.id, row.getAttribute("aria-label"), row.getAttribute("data-is-unsent")].join("\u0000");
// React gives a host element a new props object whenever it renders it again,
// including when a virtualized list reuses the node for another message.
// The key carries a per-page random suffix; find it once, then read it directly.
let knownFiberKey = null;
const fiberKey = row => {
  if (knownFiberKey && knownFiberKey in row) return knownFiberKey;
  const key = Object.keys(row).find(name => name.startsWith("__reactFiber$") || name.startsWith("__reactInternalInstance$"));
  if (key) knownFiberKey = key;
  return key || null;
};
// React DOM refreshes __reactProps$ on every commit, while the fiber pointer of a
// node can lag one commit behind (double buffering), so prefer the props key.
let knownPropsKey = null;
const rowProps = row => {
  if (!knownPropsKey || !(knownPropsKey in row)) {
    const key = Object.keys(row).find(name => name.startsWith("__reactProps$"));
    if (key) knownPropsKey = key;
    else { const fiber = fiberKey(row); return fiber ? row[fiber]?.memoizedProps ?? null : null; }
  }
  return row[knownPropsKey] ?? null;
};

export function installMessageAdapter(config, emit, count) {
  const pending = new Set(), scopes = new Set(), scrollTargets = new Set();
  let timer = null, serial = 0, seen = new WeakMap(), failed = new WeakMap(), dirty = new WeakSet(), anchors = new WeakMap(),
    snapshots = new WeakMap(), replacements = new WeakMap(), scrollEpoch = 0, sweep = null, repeatSweep = false,
    scrollTimer = null, scrollDeadline = 0, scrollOverflow = false, wideDetail = false, lastScopePrune = 0;
  const rowWalker = root => document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode:node => node.matches(ROW_SELECTOR) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP,
  });
  const markDirty = row => { for (let node = row; node; node = node.parentElement?.closest(ROW_SELECTOR)) dirty.add(node); };
  function requestSweep() {
    if (!sweep) sweep = rowWalker(document); else repeatSweep = true;
  }
  function flushScroll() {
    scrollTimer = null;
    const targets = [...scrollTargets], everything = scrollOverflow; scrollTargets.clear(); scrollOverflow = false;
    if (!config().archive) return;
    if (everything) scan(document, true);
    else for (const target of targets) if (target.isConnected) scan(target, true);
  }
  document.addEventListener("scroll", event => {
    // The epoch must move immediately: it guards row recycling during a scroll.
    scrollEpoch++;
    if (!config().archive || !(event.target instanceof Element)) return;
    if (scrollTargets.size < 8) scrollTargets.add(event.target); else scrollOverflow = true;
    const now = performance.now();
    if (scrollTimer === null) scrollDeadline = now + SCROLL_MAX_WAIT_MS; else clearTimeout(scrollTimer);
    scrollTimer = setTimeout(flushScroll, Math.max(0, Math.min(SCROLL_QUIET_MS, scrollDeadline - now)));
  }, { capture: true, passive: true });
  const queue = row => {
    const accepted = pending.has(row) || pending.size < 256;
    if (accepted) pending.add(row); else requestSweep();
    if (!timer) timer = setTimeout(process, 120);
    return accepted;
  };
  // A scroll only needs to re-read a row whose DOM or identity changed. An
  // unchanged row just renews the epoch that keeps its recall matchable.
  function queueScrolled(row) {
    const key = rowKey(row), known = seen.get(row);
    if (!dirty.has(row)) {
      if (known && known.key === key && known.props === rowProps(row) && !known.waitingVoice) {
        const snapshot = snapshots.get(row);
        if (snapshot) { snapshot.scrollEpoch = scrollEpoch; anchors.set(row.closest('[role="article"]') || row, snapshot); }
        return true;
      }
      if (failed.get(row) === key) return true;
    }
    return queue(row);
  }
  function watchEverywhere() {
    handle(detail.takeRecords()); detail.disconnect(); scopes.clear(); wideDetail = true;
    detail.observe(document.documentElement, DETAIL_OPTIONS);
  }
  function pruneScopes() {
    lastScopePrune = performance.now();
    if ([...scopes].every(scope => scope.isConnected)) return;
    handle(detail.takeRecords()); detail.disconnect();
    for (const scope of [...scopes]) if (scope.isConnected) detail.observe(scope, DETAIL_OPTIONS); else scopes.delete(scope);
  }
  // Text and image changes are noisy across a Facebook page, so they are only
  // watched around rows that exist. Structure is still watched everywhere.
  function watchScope(row) {
    if (wideDetail) return;
    const scope = row.closest(SCOPE_SELECTOR) || row.parentElement || row;
    if (scopes.has(scope)) return;
    if (scopes.size >= MAX_SCOPES) { pruneScopes(); if (scopes.size >= MAX_SCOPES) { watchEverywhere(); return; } }
    scopes.add(scope); detail.observe(scope, DETAIL_OPTIONS);
  }
  function process() {
    timer = null;
    if (!config().archive) { pending.clear(); return; }
    const rows = [...pending]; pending.clear();
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (!row.isConnected) continue;
      watchScope(row);
      dirty.delete(row);
      let item;
      try { item = describeRow(row, count, config()); } catch { count("adapterErrors"); continue; }
      if (!item) { failed.set(row, rowKey(row)); count("unidentifiedRows"); continue; }
      failed.delete(row);
      const anchor = row.closest('[role="article"]') || row;
      const replacement = replacements.get(row);
      const prior = replacement?.expiresAt > Date.now() ? replacement : anchors.get(anchor);
      if (item.removed && prior && item.id !== prior.id && item.account === prior.account &&
          item.identityStamp && item.identityStamp === prior.identityStamp &&
          ((prior.verifiedReplacement && replacement === prior) || (prior.scrollEpoch === scrollEpoch &&
          (prior.row === row || (!prior.row.isConnected && anchor.querySelectorAll('[data-message-id]').length === 1))))) {
        item.tombstoneId = item.id; item.id = prior.id; item.thread = prior.thread;
        anchors.set(anchor, {row,id:item.id,account:item.account,thread:item.thread,identityStamp:item.identityStamp,scrollEpoch});
      }
      if (!item.removed) {
        const snapshot={ row, id: item.id, account: item.account, thread: item.thread, identityStamp: item.identityStamp, scrollEpoch };
        anchors.set(anchor,snapshot);snapshots.set(row,snapshot);
      }
      const fingerprint = JSON.stringify([item.account, item.thread, item.id, item.removed, item.text, item.tombstoneId,item.media.map(m=>[m.kind,m.sourceId,m.position,m.subtype]),item.kind,item.senderId,item.sentAt,item.senderName,item.replyText]);
      const previous = seen.get(row), key = rowKey(row);
      if (previous?.fingerprint === fingerprint) { previous.key = key; previous.props = rowProps(row); previous.waitingVoice = !!item.waitingVoice; if(item.waitingVoice)requestVoicePreload(row,{...item,token:row.getAttribute('data-pff-row')});replacements.delete(row); continue; }
      const token = `pff-${++serial}`;
      if (!item.waitingVoice&&emit({ ...item, token }) === false) {
        for (const waiting of rows.slice(index)) pending.add(waiting);
        break;
      }
      replacements.delete(row);
      for (const host of row.querySelectorAll('[data-pff-host]')) host.remove();
      row.setAttribute("data-pff-row", token);
      row.setAttribute("data-pff-key", JSON.stringify([item.account, item.thread, item.id]));
      if(item.waitingVoice)requestVoicePreload(row,{...item,token});
      seen.set(row, { fingerprint, key, props: rowProps(row), waitingVoice: !!item.waitingVoice });
      count(item.removed ? "tombstonesObserved" : "messagesObserved");
    }
    // Resume a bounded DOM walk when a burst exceeds the retained row set.
    // Keep a cursor, rather than restarting at the first 256 rows or dropping
    // the rest of a long initial scan.
    while (sweep && pending.size < 256) {
      const row = sweep.nextNode();
      if (row) pending.add(row);
      else { sweep = repeatSweep ? rowWalker(document) : null; repeatSweep = false; }
    }
    if ((pending.size || sweep) && !timer) timer = setTimeout(process, 120);
  }
  const scan = (root, scrolled = false) => {
    if (!(root instanceof Element || root instanceof Document)) return;
    if (root instanceof Element) {
      if (root.closest('[data-pff-host],[data-pff-media]')) return;
      const closest = root.closest(ROW_SELECTOR); if (closest) (scrolled ? queueScrolled : queue)(closest);
    }
    // Bound retained nodes even on a busy feed or very long conversation.
    for (const row of root.querySelectorAll(ROW_SELECTOR)) if (!(scrolled ? queueScrolled : queue)(row)) break;
  };
  function handle(mutations) {
    if (!config().archive || !mutations.length) return;
    if (performance.now() - lastScopePrune > SCOPE_PRUNE_MS && scopes.size) pruneScopes();
    const changedParents=new Map(), slots=new Map(), addedByMutation=new Map();let slotCount=0;
    const rowsIn=node=>node instanceof Element?[...(node.matches(ROW_SELECTOR)?[node]:[]),...node.querySelectorAll(ROW_SELECTOR)]:[];
    for(const mutation of mutations){
      if(mutation.type!=="childList"||mutation.target.parentElement?.closest('[data-pff-host]'))continue;
      // React can replace several articles in one observer callback. Keep
      // each atomic remove+add pair instead of merging all pairs by parent.
      const removedRows=[...mutation.removedNodes].flatMap(rowsIn);
      const addedRows=[...mutation.addedNodes].flatMap(rowsIn);addedByMutation.set(mutation,addedRows);
      const old=removedRows.map(row=>snapshots.get(row)).filter(Boolean);
      if(old.length===1&&removedRows.length===1&&addedRows.length===1&&old[0].scrollEpoch===scrollEpoch){
        replacements.set(addedRows[0],{...old[0],verifiedReplacement:true,expiresAt:Date.now()+8000});
      }
      // React's actual mobile-update path emits removeChild and insertBefore
      // separately. Identify a replacement by the same parent AND the exact
      // previous/next sibling objects recorded by both mutations. This is not
      // a search by row index, message text or timestamp. Ambiguous slots and
      // whole-container replacements are deliberately excluded.
      if((mutation.previousSibling||mutation.nextSibling)&&removedRows.length<=1&&addedRows.length<=1&&slotCount<256){
        let byPrevious=slots.get(mutation.target);
        if(!byPrevious&&slots.size<128){byPrevious=new Map();slots.set(mutation.target,byPrevious);}
        if(byPrevious){
          let byNext=byPrevious.get(mutation.previousSibling);
          if(!byNext){byNext=new Map();byPrevious.set(mutation.previousSibling,byNext);}
          let slot=byNext.get(mutation.nextSibling);
          if(!slot){slot={removed:new Set(),added:new Set()};byNext.set(mutation.nextSibling,slot);slotCount++;}
          for(const snapshot of old)if(slot.removed.size<2)slot.removed.add(snapshot);
          for(const row of addedRows)if(slot.added.size<2)slot.added.add(row);
        }
      }
      let group=changedParents.get(mutation.target);
      if(!group){if(changedParents.size>=128)continue;group={removed:new Set(),added:new Set()};changedParents.set(mutation.target,group);}
      for(const row of removedRows){
        const snapshot=snapshots.get(row);if(snapshot&&group.removed.size<2)group.removed.add(snapshot);
      }
      for(const row of addedRows)if(group.added.size<2)group.added.add(row);
    }
    for(const byPrevious of slots.values())for(const byNext of byPrevious.values())for(const slot of byNext.values()){
      if(slot.removed.size!==1||slot.added.size!==1)continue;
      const prior=[...slot.removed][0],row=[...slot.added][0];
      if(prior.scrollEpoch===scrollEpoch)replacements.set(row,{...prior,verifiedReplacement:true,expiresAt:Date.now()+8000});
    }
    for(const group of changedParents.values()){
      // Pair only a direct, unique DOM replacement under the same parent in
      // the same commit, never a timestamp search across the conversation.
      if(group.removed.size!==1||group.added.size!==1)continue;
      const prior=[...group.removed][0],row=[...group.added][0];
      if(prior.scrollEpoch===scrollEpoch)replacements.set(row,{...prior,verifiedReplacement:true,expiresAt:Date.now()+8000});
    }
    const visited = new Set();
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
      // Many mutations share one parent during a React commit; check it once.
      if (target && !visited.has(target)) {
        visited.add(target);
        if (!target.closest('[data-pff-host],[data-pff-media]')) {
          const row = target.closest(ROW_SELECTOR);
          if (row) { markDirty(row); queue(row); }
        }
      }
      // Rows inside added nodes were already found above; queue them without a second search.
      for (const row of addedByMutation.get(mutation) || []) { if (row.closest('[data-pff-host],[data-pff-media]')) continue; if (!queue(row)) break; }
    }
  }
  const structure = new MutationObserver(handle), detail = new MutationObserver(handle);
  const start = () => {
    structure.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-message-id", "data-mid", "data-is-unsent"] });
    scan(document);
  };
  if (document.documentElement) start(); else document.addEventListener("DOMContentLoaded", start, { once: true });
  return { mediaChanged(row){seen.delete(row);queue(row);},
    forget(token){if(typeof token!=='string'||!/^pff-\d+$/.test(token))return;const row=document.querySelector(`[data-pff-row="${token}"]`);if(row){seen.delete(row);failed.delete(row);dirty.add(row);}},rescan() { seen = new WeakMap(); failed = new WeakMap(); scan(document); }, reset() { seen = new WeakMap(); failed = new WeakMap(); dirty = new WeakSet(); anchors = new WeakMap();snapshots=new WeakMap();replacements=new WeakMap();pending.clear();sweep=null;repeatSweep=false; } };
}
