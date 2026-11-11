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
const HOOK_ATTEMPTS = 400, FALLBACK_MS = 30000;

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
    if (!/^msgr\.\d{16,}$/.test(id)) return null;
    return { account, thread: "by-message-id", id, nativeId: fields.nativeId, token: `pff-${TOKEN_BASE + ++serial}`, media: [], source: "bridge", ...fields };
  }
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
  function recall(originalId, tombstoneId, saved) {
    (async () => {
      const row = await saved;
      if (!enabled()) return;
      if (row?.text?.trim()) {
        const item = observation({ nativeId: originalId, removed: false, text: row.text.slice(0, MAX_TEXT), truncated: row.text.length > MAX_TEXT,
          senderId: row.senderId, sentAt: row.sentAt, replyText: row.replyText?.slice(0, 500) });
        if (item && emit(item) !== false) count("bridgeRescued");
      }
      const removal = observation({ nativeId: originalId, removed: true, tombstoneId: tombstoneId ? canonicalMessageId(tombstoneId) : undefined, recheck: tombstoneId || undefined });
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
        const list = revoked.get(value.chatJid) || []; list.push(value.msgId); revoked.set(value.chatJid, list);
      } else if ((event.tag === "NewMsg" || event.tag === "MsgUpdated") && typeof value.msgId === "string" && "content" in value) capture(value);
    }
    for (const [chat, list] of deletions) {
      const replacements = revoked.get(chat) || [];
      if (!replacements.length) continue;
      // One deletion and one replacement in a batch is an exact pair; anything
      // else is still a recall of each ID, without guessing which tombstone is whose.
      for (const entry of list) recall(entry.id, list.length === 1 && replacements.length === 1 ? replacements[0] : null, entry.saved);
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
  function hook() {
    if (state.hooked) return true;
    if (typeof window.require !== "function" || typeof window.__d !== "function" || ++attempts > HOOK_ATTEMPTS) return false;
    const map = required("__debug")?.modulesMap;
    if (!map || typeof map !== "object") return false;
    state.hooked = true;
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
  return { state };
}
