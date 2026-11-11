import { MAX_TEXT, accountId, canonicalMessageId } from "./shared.js";

// Data-layer source for end-to-end encrypted Messenger chats.
//
// Messenger decrypts messages in a worker and hands each change to the page
// through one module, MAWBridgeUIEventHandler.handleEvents(ready, events).
// Every event is { tag, value }. This adapter only reads those events: the
// arguments, `this` and the return value reach Facebook unchanged, and any
// error here is swallowed. Measured on a test account (TODO 2.1):
// - "NewMsg" arrives before the row exists in the DOM, with the final message
//   ID, sender, timestamp and the text in Messenger's in-memory "vault" form,
//   which Messenger's own MAWVault.unvaultOrThrow turns back into text;
// - a recall is "DeleteMessages" with the original ID followed, in the same
//   batch, by a "NewMsg" of type "Revoked" with a new ID;
// - "MsgUpdated" carries an edit; Messenger's in-memory store (LS "messages")
//   still holds the text of a loaded message until its own delete handler runs.
const TARGET = "MAWBridgeUIEventHandler";
const TOKEN_BASE = 900000000;
// Chats that are not end-to-end encrypted (most groups) reach the page through
// Messenger's store procedures instead. Each is a function taking positional
// arguments; which position holds which field is read from the procedure's own
// source ("messageId:e[8]"), never assumed, so a reordering by Facebook is
// followed and an unreadable procedure is simply left alone. A recall there
// keeps the message ID and sets isUnsent.
const STORE_PROCEDURES = ["LSInsertMessage", "LSUpsertMessage", "LSDeleteThenInsertMessage"];
const STORE_FIELDS = ["messageId", "text", "senderId", "timestampMs", "isUnsent"];
const STORE_ID = /^mid\.\$[\w-]{6,200}$/;
const HOOK_ATTEMPTS = 400, FALLBACK_MS = 30000, MAX_KNOWN = 600;

const digits = value => typeof value === "string" && /^\d{1,40}$/.test(value) ? value : undefined;

export function installBridgeAdapter(config, emit, count) {
  let serial = 0, wrappedOnce = false, attempts = 0;
  const state = { hooked: false, patchedAt: null };
  const enabled = () => config().archive && config().bridgeCapture !== false;
  const required = name => { try { return window.require(name); } catch { return null; } };
  function unvault(value) {
    if (typeof value !== "string" || !value) return null;
    const vault = required("MAWVault");
    try { return vault?.isVaulted?.(value) ? vault.unvaultOrThrow(value) : value; } catch { return null; }
  }
  function observation(fields) {
    const account = accountId();
    if (!account || typeof fields.nativeId !== "string") return null;
    const id = canonicalMessageId(fields.nativeId);
    if (!/^msgr\.\d{16,}$/.test(id) && !STORE_ID.test(id)) return null;
    return { account, thread: "by-message-id", id, nativeId: fields.nativeId, token: `pff-${TOKEN_BASE + ++serial}`, media: [], source: "bridge", ...fields };
  }
  // Sender and send time of recent messages of any kind, by canonical ID. The
  // DOM source has neither for a photo or voice note; a recall batch with
  // several messages is paired through the send time kept here.
  const known = new Map();
  function remember(value) {
    if (typeof value.msgId !== "string") return;
    const id = canonicalMessageId(value.msgId), ts = Number(value.ts), order = Number(value.sortOrderMs);
    if (!/^msgr\.\d{16,}$/.test(id)) return;
    known.delete(id);
    known.set(id, { senderId: digits(value.sender), sentAt: Number.isSafeInteger(ts) && ts > 1e9 && ts < 4e9 ? ts * 1000 : undefined, order: Number.isSafeInteger(order) ? order : undefined });
    if (known.size > MAX_KNOWN) known.delete(known.keys().next().value);
  }
  const details = id => { const entry = enabled() && known.get(id); return entry ? { senderId: entry.senderId, sentAt: entry.sentAt } : null; };
  function capture(value) {
    const text = unvault(value.content);
    if (typeof text !== "string" || !text.trim()) return;
    const ts = Number(value.ts);
    const item = observation({ nativeId: value.msgId, removed: false, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT,
      senderId: digits(value.sender), sentAt: Number.isSafeInteger(ts) && ts > 1e9 && ts < 4e9 ? ts * 1000 : undefined,
      replyText: typeof value.replyContent === "string" ? unvault(value.replyContent)?.slice(0, 500) : undefined });
    if (item && emit(item) !== false) count("bridgeMessages");
  }
  // Messenger's in-memory database, resolved once so a read can start
  // synchronously, before Facebook's own delete handler runs.
  let database = null;
  function loadDatabase() {
    if (database) return database;
    try {
      const value = required("LSDatabaseSingleton")?.LSDatabaseSingleton;
      if (value && typeof value.then === "function") value.then(db => { database = db; }, () => {});
      else if (value) database = value;
    } catch {}
    return database;
  }
  // Reads Messenger's in-memory row for a message that is about to be deleted.
  function rescue(nativeId) {
    try {
      const db = loadDatabase(), ReQL = required("ReQL"), table = db?.tables?.messages;
      if (!ReQL || !table) return Promise.resolve(null);
      return ReQL.firstAsync(ReQL.fromTableAscending(table).filter(r => r.messageId === nativeId)).then(row => readRow(row), () => null);
    } catch { return Promise.resolve(null); }
  }
  function readRow(row) {
    try {
      if (!row || row.isUnsent === true) return null;
      const text = unvault(row.text), I64 = required("I64");
      const number = value => { try { return Array.isArray(value) ? I64?.to_string(value) : typeof value === "string" ? value : undefined; } catch { return undefined; } };
      const sent = Number(number(row.timestampMs));
      return { text, senderId: digits(number(row.senderId)), sentAt: Number.isSafeInteger(sent) && sent > 1e12 && sent < 4e12 ? sent : undefined,
        replyText: unvault(row.replyMessageText) || undefined };
    } catch { return null; }
  }
  function recall(originalId, tombstoneId, saved, sameRow = false) {
    (async () => {
      const row = await saved;
      if (!enabled()) return;
      if (row?.text?.trim()) {
        const item = observation({ nativeId: originalId, removed: false, text: row.text.slice(0, MAX_TEXT), truncated: row.text.length > MAX_TEXT,
          senderId: row.senderId, sentAt: row.sentAt, replyText: row.replyText?.slice(0, 500) });
        if (item && emit(item) !== false) count("bridgeRescued");
      }
      const removal = observation({ nativeId: originalId, removed: true, tombstoneId: tombstoneId ? canonicalMessageId(tombstoneId) : undefined, recheck: tombstoneId || (sameRow ? originalId : undefined) });
      if (removal && emit(removal) !== false) count("bridgeRecalls");
    })().catch(() => count("bridgeErrors"));
  }
  // Another wrapper around this one (a second tool, a re-assignment) must not
  // make the same batch count twice.
  const seenBatches = new WeakSet();
  function observe(events) {
    if (!Array.isArray(events) || seenBatches.has(events) || !enabled()) return;
    seenBatches.add(events);
    // Deletions are paired with the "Revoked" message that replaces them in the
    // same batch. A deletion without one (delete for me, expiry) is not a recall.
    const deletions = new Map();
    for (const event of events) {
      if (event?.tag !== "DeleteMessages") continue;
      const chat = event.value?.threadJid;
      for (const message of event.value?.messages || []) {
        if (typeof message?.msgId !== "string") continue;
        const list = deletions.get(chat) || []; if (!list.some(entry => entry.id === message.msgId)) list.push({ id: message.msgId, saved: rescue(message.msgId) }); deletions.set(chat, list);
      }
    }
    const revoked = new Map();
    for (const event of events) {
      const value = event?.value;
      if (!value || typeof value !== "object") continue;
      if (event.tag === "NewMsg" && value.type_ === "Revoked") {
        const ts = Number(value.ts), order = Number(value.sortOrderMs);
        const list = revoked.get(value.chatJid) || []; list.push({ id: value.msgId, sentAt: Number.isSafeInteger(ts) ? ts * 1000 : undefined, order: Number.isSafeInteger(order) ? order : undefined }); revoked.set(value.chatJid, list);
        continue;
      }
      if (event.tag === "NewMsg") remember(value);
      if ((event.tag === "NewMsg" || event.tag === "MsgUpdated") && typeof value.msgId === "string" && "content" in value) capture(value);
    }
    for (const [chat, list] of deletions) {
      const replacements = revoked.get(chat) || [];
      if (!replacements.length) continue;
      // One deletion and one replacement in a batch is an exact pair. With more,
      // a replacement keeps its original's send time: pair the ones where exactly
      // one deletion and one replacement share it. Anything else is still a
      // recall of each ID, without guessing which tombstone is whose.
      const same = (seen, item) => !!seen && (seen.order !== undefined && item.order !== undefined ? seen.order === item.order : seen.sentAt !== undefined && seen.sentAt === item.sentAt);
      const seenFor = entry => known.get(canonicalMessageId(entry.id));
      for (const entry of list) {
        let tombstone = null;
        if (list.length === 1 && replacements.length === 1) tombstone = replacements[0].id;
        else {
          const matches = replacements.filter(item => same(seenFor(entry), item));
          if (matches.length === 1 && list.filter(other => same(seenFor(other), matches[0])).length === 1) tombstone = matches[0].id;
        }
        recall(entry.id, tombstone, entry.saved);
      }
    }
  }
  function wrap(original) {
    if (typeof original !== "function" || original.__pffBridge) return original;
    loadDatabase();
    const wrapped = function () {
      try { observe(arguments[1]); } catch { count("bridgeErrors"); }
      return original.apply(this, arguments);
    };
    Object.defineProperty(wrapped, "length", { value: original.length });
    wrapped.__pffBridge = true;
    if (!wrappedOnce) { wrappedOnce = true; state.patchedAt = Math.round(performance.now()); count("bridgeActive"); }
    return wrapped;
  }
  // handleEvents is assigned by the module's factory onto the exports object
  // the module system creates for it; both may be replaced, so both are watched.
  function trapExports(exports) {
    if (!exports || typeof exports !== "object" || exports.__pffTrapped) return;
    try {
      Object.defineProperty(exports, "__pffTrapped", { value: true });
      if (typeof exports.handleEvents === "function") { exports.handleEvents = wrap(exports.handleEvents); return; }
      let value;
      Object.defineProperty(exports, "handleEvents", { configurable: true, enumerable: true, get: () => value, set: next => { value = wrap(next); } });
    } catch {}
  }
  function attach(record) {
    if (!record || typeof record !== "object" || record.__pffAttached) return;
    try {
      Object.defineProperty(record, "__pffAttached", { value: true });
      let exports = record.exports; trapExports(exports);
      Object.defineProperty(record, "exports", { configurable: true, enumerable: true, get: () => exports, set: next => { exports = next; trapExports(next); } });
    } catch {}
  }
  // ---- Store procedures (chats that are not end-to-end encrypted) ----
  const layouts = new WeakMap(), storeSeen = new Map();
  let storeOnce = false;
  function layoutOf(procedure) {
    if (layouts.has(procedure)) return layouts.get(procedure);
    let layout = null;
    try {
      const source = Function.prototype.toString.call(procedure), name = source.match(/var (\w+)=arguments/)?.[1];
      if (name && source.length < 60000) {
        const found = {};
        for (const match of source.matchAll(new RegExp("(\\w+):" + name + "\\[(\\d+)\\]", "g"))) if (!(match[1] in found)) found[match[1]] = Number(match[2]);
        if (STORE_FIELDS.every(field => Number.isInteger(found[field]))) layout = found;
      }
    } catch {}
    if (!layout) count("storeUnreadable");
    layouts.set(procedure, layout);
    return layout;
  }
  function mark(id, value) { storeSeen.delete(id); storeSeen.set(id, value); if (storeSeen.size > MAX_KNOWN) storeSeen.delete(storeSeen.keys().next().value); }
  function observeStore(procedure, args) {
    if (!enabled()) return;
    const layout = layoutOf(procedure);
    if (!layout) return;
    const id = args[layout.messageId];
    if (typeof id !== "string" || !STORE_ID.test(id)) return;
    const I64 = required("I64"), number = value => { try { return Array.isArray(value) ? I64?.to_string(value) : typeof value === "string" ? value : undefined; } catch { return undefined; } };
    if (args[layout.isUnsent] === true) {
      if (storeSeen.get(id) === true) return;
      // Started before Messenger replaces its row, like the encrypted path.
      const saved = storeSeen.has(id) ? Promise.resolve(null) : rescue(id);
      mark(id, true);
      recall(id, null, saved, true);
      return;
    }
    const text = unvault(args[layout.text]);
    if (typeof text !== "string" || !text.trim() || storeSeen.get(id) === text) return;
    const sent = Number(number(args[layout.timestampMs])), sender = digits(number(args[layout.senderId]));
    const sentAt = Number.isSafeInteger(sent) && sent > 1e12 && sent < 4e12 ? sent : undefined;
    known.delete(id); known.set(id, { senderId: sender, sentAt }); if (known.size > MAX_KNOWN) known.delete(known.keys().next().value);
    const reply = Number.isInteger(layout.replyMessageText) ? args[layout.replyMessageText] : undefined;
    const item = observation({ nativeId: id, removed: false, text: text.slice(0, MAX_TEXT), truncated: text.length > MAX_TEXT, senderId: sender, sentAt,
      replyText: typeof reply === "string" && reply ? reply.slice(0, 500) : undefined });
    if (item && emit(item) !== false) { mark(id, text); count("bridgeMessages"); }
  }
  function wrapProcedure(procedure) {
    if (typeof procedure !== "function" || procedure.__pffStore) return procedure;
    const wrapped = function () {
      try { observeStore(procedure, arguments); } catch { count("bridgeErrors"); }
      return procedure.apply(this, arguments);
    };
    Object.defineProperty(wrapped, "length", { value: procedure.length });
    wrapped.toString = () => Function.prototype.toString.call(procedure);
    wrapped.__pffStore = true;
    if (!storeOnce) { storeOnce = true; count("storeActive"); }
    return wrapped;
  }
  function attachProcedure(record) {
    if (!record || typeof record !== "object" || record.__pffStoreAttached) return;
    try {
      Object.defineProperty(record, "__pffStoreAttached", { value: true });
      for (const key of ["exports", "defaultExport"]) {
        let value = wrapProcedure(record[key]);
        Object.defineProperty(record, key, { configurable: true, enumerable: true, get: () => value, set: next => { value = wrapProcedure(next); } });
      }
    } catch {}
  }
  function watchProcedure(map, name) {
    try {
      if (map[name]) { attachProcedure(map[name]); return; }
      let record;
      Object.defineProperty(map, name, { configurable: true, enumerable: true, get: () => record, set: next => { record = next; attachProcedure(next); } });
    } catch {}
  }
  function hook() {
    if (state.hooked) return true;
    if (typeof window.require !== "function" || typeof window.__d !== "function" || ++attempts > HOOK_ATTEMPTS) return false;
    const map = required("__debug")?.modulesMap;
    if (!map || typeof map !== "object") return false;
    state.hooked = true;
    for (const name of STORE_PROCEDURES) watchProcedure(map, name);
    if (map[TARGET]) attach(map[TARGET]);
    else {
      let record;
      try { Object.defineProperty(map, TARGET, { configurable: true, enumerable: true, get: () => record, set: next => { record = next; attach(next); } }); } catch {}
    }
    loadDatabase();
    return true;
  }
  // The module registry appears with Messenger's first scripts. Look after each
  // parser insertion and on a short timer, and stop as soon as it is found.
  if (!hook()) {
    const observer = new MutationObserver(() => { if (hook()) stop(); });
    const timer = setInterval(() => { if (hook() || attempts > HOOK_ATTEMPTS) stop(); }, 25);
    const stop = () => { observer.disconnect(); clearInterval(timer); };
    observer.observe(document, { childList: true, subtree: true });
  }
  // Last resort if the module record was replaced wholesale: patch it once it settles.
  const fallback = setInterval(() => {
    try {
      const exports = required("__debug")?.modulesMap?.[TARGET]?.exports;
      if (exports && typeof exports.handleEvents === "function" && !exports.handleEvents.__pffBridge) exports.handleEvents = wrap(exports.handleEvents);
    } catch {}
  }, 500);
  setTimeout(() => clearInterval(fallback), FALLBACK_MS);
  return { state, details };
}
