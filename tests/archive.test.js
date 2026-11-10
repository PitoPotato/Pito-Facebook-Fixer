import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { Archive, MAX_EDIT_HISTORY, pack, unpack } from "../src/archive.js";
import { DEFAULTS, DAY } from "../src/shared.js";

const create = () => new Archive(`test-${crypto.randomUUID()}`);
const message = (id = "mid.1", extra = {}) => ({ account: "10001", thread: "20002", id, text: "Xin chào bạn", token: "pff-1", ...extra });
const remove = (id = "mid.1", extra = {}) => message(id, { removed: true, text: undefined, ...extra });

test("compresses long Unicode text losslessly and keeps short text cheap", async () => {
  const text = "Tiếng Việt 🐈 có dấu. ".repeat(300);
  const packed = await pack(text);
  assert.equal(packed.codec, "gzip"); assert.ok(packed.data.length < new TextEncoder().encode(text).length / 2);
  assert.equal(await unpack(packed), text);
  assert.equal((await pack("hi")).codec, "utf8");
});
test("only restores previously captured content; a removal never overwrites it", async () => {
  const db = create(), now = Date.now();
  assert.deepEqual(await db.ingest([remove()], DEFAULTS, now), []);
  await db.ingest([message()], DEFAULTS, now);
  const restored = await db.ingest([remove()], DEFAULTS, now + 1000);
  assert.equal(restored[0].text, "Xin chào bạn");
  await db.ingest([message("mid.1", { text: "replacement after unsend" })], DEFAULTS, now + 2000);
  assert.equal((await db.ingest([remove()], DEFAULTS, now + 3000))[0].text, "Xin chào bạn");
  const stats = await db.stats(); assert.equal(stats.count, 1); assert.equal(stats.removed, 1);
});
test("same ID in another account or thread cannot restore someone else's content", async () => {
  const db = create(); await db.ingest([message()], DEFAULTS);
  assert.deepEqual(await db.ingest([remove("mid.1", { account: "99999" }), remove("mid.1", { thread: "99999" })], DEFAULTS), []);
});
test("popup capture without a thread ID restores on the full page without duplicates", async () => {
  const db = create();
  await db.ingest([message("mid.popup", { thread: "by-message-id" })], DEFAULTS);
  await db.ingest([message("mid.popup", { thread: "20002" })], DEFAULTS);
  assert.equal((await db.stats()).count, 1);
  const rows = await db.ingest([remove("mid.popup", { thread: "20002" })], DEFAULTS);
  assert.equal(rows[0].text, "Xin chào bạn"); assert.equal(rows[0].thread, "20002");
  assert.deepEqual(await db.ingest([remove("mid.popup", { account: "55555", thread: "by-message-id" })], DEFAULTS), []);
});
test("changed tombstone IDs persist as bounded aliases and restore after reopening", async () => {
  const db=create(), now=Date.now();
  await db.ingest([message("msgr.1111111111111111",{thread:"by-message-id"})],DEFAULTS,now);
  await db.ingest([remove("msgr.1111111111111111",{thread:"by-message-id",tombstoneId:"msgr.2222222222222222"})],DEFAULTS,now+1);
  const reopened=new Archive(db.name);
  const rows=await reopened.ingest([remove("msgr.2222222222222222",{thread:"by-message-id"})],DEFAULTS,now+2);
  assert.equal(rows[0].text,"Xin chào bạn");assert.equal(rows[0].id,"msgr.2222222222222222");
  assert.equal((await reopened.stats()).count,1);assert.equal((await reopened.stats()).removed,1);
  assert.deepEqual(await reopened.ingest([remove("msgr.2222222222222222",{account:"99999",thread:"by-message-id"})],DEFAULTS,now+2),[]);
  await reopened.maintain({...DEFAULTS,retentionDays:1},now+DAY+1,true);
  assert.deepEqual(await reopened.ingest([remove("msgr.2222222222222222",{thread:"by-message-id"})],DEFAULTS,now+DAY+2),[]);
});
test("database v1 upgrade preserves the existing archive and adds the message index", async () => {
  const name = `upgrade-${crypto.randomUUID()}`;
  await new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("messages", { keyPath: ["account", "thread", "id"] });
      store.createIndex("capturedAt", "capturedAt"); store.createIndex("expiresAt", "expiresAt");
      store.createIndex("removedAt", ["removedAt", "account", "thread", "id"]);
      req.result.createObjectStore("meta");
      store.put({ account: "10001", thread: "by-message-id", id: "mid.old", data: new TextEncoder().encode("Bản cũ"), codec: "utf8",
        capturedAt: Date.now(), expiresAt: Date.now() + DAY, bytes: 600, removedAt: 0 });
      req.transaction.objectStore("meta").put({ count: 1, bytes: 600, removed: 0, evicted: 0, lastCleanup: 0 }, "stats");
    };
    req.onsuccess = () => { req.result.close(); resolve(); }; req.onerror = () => reject(req.error);
  });
  const db = new Archive(name);
  assert.equal((await db.ingest([remove("mid.old", { thread: "20002" })], DEFAULTS))[0].text, "Bản cũ");
  assert.equal((await db.stats()).count, 1);
});
test("revisiting does not extend retention, and expired text is never restored", async () => {
  const db = create(), now = Date.now(), config = { ...DEFAULTS, retentionDays: 1 };
  await db.ingest([message()], config, now);
  const bytes = (await db.stats()).bytes;
  await db.ingest([message()], config, now + DAY - 10);
  assert.equal((await db.stats()).bytes, bytes);
  assert.deepEqual(await db.ingest([remove()], config, now + DAY + 1), []);
  assert.equal((await db.stats()).count, 0);
});
test("edits show the newest text and keep a bounded history counted in the budget", async () => {
  const db = create(), now = Date.now(); await db.ingest([message()], DEFAULTS, now);
  const bytes = (await db.stats()).bytes;
  await db.ingest([message("mid.1", { text: "Đã sửa" })], DEFAULTS, now + 1);
  assert.equal((await db.stats()).count, 1); assert.ok((await db.stats()).bytes > bytes, "the older version counts toward the budget");
  await db.ingest([message("mid.1", { text: "Đã sửa" })], DEFAULTS, now + 2);
  for (let edit = 0; edit < MAX_EDIT_HISTORY + 3; edit++) await db.ingest([message("mid.1", { text: `Lần sửa ${edit}` })], DEFAULTS, now + 10 + edit);
  const [row] = (await db.list({ state: "all" })).rows;
  assert.equal(row.text, `Lần sửa ${MAX_EDIT_HISTORY + 2}`); assert.equal(row.history.length, MAX_EDIT_HISTORY);
  assert.equal(row.history.at(-1).text, `Lần sửa ${MAX_EDIT_HISTORY + 1}`); assert.ok(row.editedAt);
  const restored = (await db.ingest([remove()], DEFAULTS, now + 100))[0]; assert.equal(restored.text, `Lần sửa ${MAX_EDIT_HISTORY + 2}`);
  assert.equal((await db.listRemoved())[0].history.length, MAX_EDIT_HISTORY, "history survives a recall");
});
test("a rerender without its caption never replaces text that was saved", async () => {
  const db = create(), png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(40).fill(1)]), now = Date.now();
  await db.ingest([message("mid.1", { text: "Chú thích", assets: [{ kind: "image", data: png, mime: "image/png", position: 0 }] })], DEFAULTS, now);
  await db.ingest([message("mid.1", { text: "", assets: [{ kind: "image", data: png, mime: "image/png", position: 0 }] })], DEFAULTS, now + 1);
  const [row] = (await db.list({ state: "all" })).rows; assert.equal(row.text, "Chú thích"); assert.deepEqual(row.history, []);
});
test("sender, sent time and reply are saved, filled in later and never erased", async () => {
  const db = create(), now = Date.now();
  await db.ingest([message("mid.1", { senderName: "An" })], DEFAULTS, now);
  const bytes = (await db.stats()).bytes;
  await db.ingest([message("mid.1", { senderId: "777", sentAt: 1800000000000, replyText: "Câu gốc", label: "At 01:00, An" })], DEFAULTS, now + 1);
  assert.ok((await db.stats()).bytes > bytes);
  await db.ingest([message("mid.1", { senderName: undefined, senderId: undefined, sentAt: undefined })], DEFAULTS, now + 2);
  const [row] = (await db.list({ state: "all" })).rows;
  assert.equal(row.senderName, "An"); assert.equal(row.senderId, "777"); assert.equal(row.sentAt, 1800000000000); assert.equal(row.replyText, "Câu gốc");
});
test("when the archive is full, ordinary messages are evicted before older recalled ones", async () => {
  const db = create(), now = Date.now(), config = { ...DEFAULTS, maxMessages: 100, retentionDays: 0 };
  await db.ingest([message("mid.recalled")], config, now);
  await db.ingest([remove("mid.recalled")], config, now + 1);
  for (let batch = 0; batch < 3; batch++) await db.ingest(Array.from({ length: 50 }, (_, i) => message(`mid.${batch}.${i}`)), config, now + 10 + batch);
  const stats = await db.stats(); assert.ok(stats.evicted > 0); assert.ok(stats.count <= 100);
  assert.equal(stats.removed, 1); assert.equal((await db.listRemoved())[0].id, "mid.recalled");
});
test("recalled messages are evicted only after no ordinary message remains, when cleanup allows it", async () => {
  const db = create(), now = Date.now(), config = { ...DEFAULTS, maxMessages: 100, retentionDays: 0 };
  const items = Array.from({ length: 60 }, (_, i) => message(`mid.r.${String(i).padStart(2, "0")}`));
  await db.ingest(items, config, now); await db.ingest(items.map(item => ({ ...item, removed: true, text: undefined })), config, now + 1);
  await db.ingest(Array.from({ length: 50 }, (_, i) => message(`mid.n.${i}`)), config, now + 2);
  const tight = { ...config, maxMessages: 40 };
  await db.maintain(tight, now + 3, true);
  const stats = await db.stats(); assert.ok(stats.count <= 40); assert.equal(stats.count, stats.removed, "only recalled messages remain");
});
test("retention of a recalled message runs from its recall, including for records saved before this version", async () => {
  const db = create(), now = Date.now(), config = { ...DEFAULTS, retentionDays: 30 };
  await db.ingest([message()], config, now - 29 * DAY);
  await db.ingest([remove()], config, now);
  await db.maintain(config, now + 10 * DAY, true);
  assert.equal((await db.listRemoved().then(rows => rows[0].text)), "Xin chào bạn");
  await db.maintain(config, now + 30 * DAY, true);
  assert.equal((await db.stats()).count, 0);
});
test("list filters by state and pages through every message", async () => {
  const db = create(), now = Date.now(), items = Array.from({ length: 64 }, (_, i) => message(`mid.${String(i).padStart(3, "0")}`));
  await db.ingest(items, DEFAULTS, now); await db.ingest(items.slice(0, 5).map(item => ({ ...item, removed: true, text: undefined })), DEFAULTS, now + 1);
  await db.ingest([{ ...message("mid.063"), removed: true, vanished: true, text: undefined }], DEFAULTS, now + 2);
  assert.equal((await db.list({ state: "removed" })).rows.length, 5); assert.equal((await db.list({ state: "vanished" })).rows.length, 1);
  assert.equal((await db.list({ state: "vanished" })).rows[0].removal, "vanished");
  let cursor = null, ids = [];
  do { const page = await db.list({ state: "normal", before: cursor }); ids.push(...page.rows.map(row => row.id)); cursor = page.next; } while (cursor);
  assert.equal(ids.length, 58); assert.equal(new Set(ids).size, 58);
  assert.equal((await db.list({ state: "all" })).rows.length, 30);
  await assert.rejects(() => db.list({ state: "secret" }), /errInvalidRequest/);
});
test("search covers messages beyond the first page, including old edits and sender names", async () => {
  const db = create(), now = Date.now();
  await db.ingest([message("mid.needle", { text: "Bản đầu có từ KHÓA", senderName: "Nguyễn An" })], DEFAULTS, now);
  await db.ingest([message("mid.needle", { text: "Bản sau" })], DEFAULTS, now + 1);
  await db.ingest(Array.from({ length: 64 }, (_, i) => message(`mid.fill.${i}`, { text: "Không liên quan" })), DEFAULTS, now + 2);
  for (const query of ["từ khóa", "nguyễn an", "bản sau"]) {
    const result = await db.list({ state: "all", query }); assert.deepEqual(result.rows.map(row => row.id), ["mid.needle"], query); assert.equal(result.next, null);
  }
  assert.deepEqual((await db.list({ state: "all", query: "không tồn tại" })).rows, []);
});
test("a long search stops at its scan budget and can be continued", async () => {
  const db = create(), now = Date.now(), total = 4100;
  for (let batch = 0; batch * 64 < total; batch++) await db.ingest(Array.from({ length: 64 }, (_, i) => message(`mid.${batch}.${i}`, { text: "Đệm" })), { ...DEFAULTS, maxMessages: 100000 }, now + batch);
  await db.ingest([message("mid.oldest", { text: "Kim trong đống rơm" })], { ...DEFAULTS, maxMessages: 100000 }, now - 1000);
  const first = await db.list({ state: "all", query: "kim trong" });
  assert.deepEqual(first.rows, []); assert.equal(first.scanned, 4000); assert.ok(first.next);
  const second = await db.list({ state: "all", query: "kim trong", before: first.next });
  assert.deepEqual(second.rows.map(row => row.id), ["mid.oldest"]); assert.equal(second.next, null);
});
test("sustained writes stay under byte and count budgets; newer messages survive", async () => {
  const db = create(), config = { ...DEFAULTS, maxBytes: 24000, maxMessages: 25 }, now = Date.now();
  for (let round = 0; round < 60; round++) {
    const batch = Array.from({ length: 20 }, (_, i) => message(`mid.${round * 20 + i}`, { text: `Message ${round}-${i}` }));
    await db.ingest(batch, config, now + round * 1000);
    const stats = await db.stats(); assert.ok(stats.bytes <= config.maxBytes); assert.ok(stats.count <= config.maxMessages);
  }
  assert.ok((await db.stats()).evicted > 1100);
  assert.equal((await db.ingest([remove("mid.1199")], config, now + 61000))[0].text, "Message 59-19");
  assert.deepEqual(await db.ingest([remove("mid.0")], config, now + 61000), []);
});
test("byte budget evicts even when count limit has not been reached", async () => {
  const db = create(), config = { ...DEFAULTS, maxBytes: 2200 };
  await db.ingest(Array.from({ length: 10 }, (_, i) => message(`mid.${i}`)), config);
  assert.ok((await db.stats()).bytes <= 2200); assert.ok((await db.stats()).count < 10);
});
test("shortening retention cleans old removed and ordinary messages", async () => {
  const db = create(), now = Date.now();
  await db.ingest([message()], DEFAULTS, now - 2 * DAY);
  await db.ingest([remove()], DEFAULTS, now - DAY);
  await db.maintain({ ...DEFAULTS, retentionDays: 1 }, now, true);
  assert.equal((await db.stats()).count, 0); assert.equal((await db.stats()).removed, 0);
});
test("paging equal removal timestamps does not skip or duplicate messages", async () => {
  const db = create(), now = Date.now();
  const items = Array.from({ length: 64 }, (_, i) => message(`mid.${String(i).padStart(3, "0")}`));
  await db.ingest(items, DEFAULTS, now); await db.ingest(items.map(x => ({ ...x, removed: true })), DEFAULTS, now + 1);
  let cursor = null, ids = [];
  for (let i = 0; i < 3; i++) {
    const rows = await db.listRemoved(cursor); ids.push(...rows.map(r => r.id));
    const last = rows.at(-1); cursor = last && [last.removedAt, last.account, last.thread, last.id];
  }
  assert.equal(ids.length, 64); assert.equal(new Set(ids).size, 64);
});
test("disabled capture, invalid records and clear are respected", async () => {
  const db = create();
  await db.ingest([message()], { ...DEFAULTS, archive: false });
  await db.ingest([message(""), message("mid.bad", { account: "not-an-account" }), message("mid.huge", { text: "x".repeat(16001) })], DEFAULTS);
  assert.equal((await db.stats()).count, 0);
  await db.ingest([message()], DEFAULTS); await db.clear();
  assert.equal((await db.stats()).bytes, 0); assert.deepEqual(await db.ingest([remove()], DEFAULTS), []);
});

test('protected recalled records survive age, lowered budget and quota-style pruning; new captures stop',async()=>{
  const db=create(),now=Date.now(),config={...DEFAULTS,cleanupRemoved:false,retentionDays:1};
  await db.ingest([message()],config,now-2*DAY);
  await db.ingest([remove()],config,now-2*DAY+1);
  const protectedBytes=(await db.stats()).removedBytes;assert.ok(protectedBytes>0);
  const tiny={...config,maxBytes:protectedBytes-1};
  await db.maintain(tiny,now,true);
  await db.ingest([message('mid.new')],tiny,now);
  const stats=await db.stats();assert.equal(stats.count,1);assert.equal(stats.removed,1);assert.equal(stats.capacityBlocked,true);assert.equal(stats.rejected,1);
  assert.equal((await db.ingest([remove()],tiny,now))[0].text,'Xin chào bạn');
  assert.equal((await db.listRemoved()).length,1);
  await db.maintain(config,now,true);assert.equal((await db.stats()).capacityBlocked,false);
  await db.ingest([message('mid.new')],config,now);assert.equal((await db.stats()).count,2);
  await db.maintain({...config,cleanupRemoved:true},now,true);assert.equal((await db.stats()).removed,0);
});

test('zero retention has no age expiry but continues to obey byte and count budgets',async()=>{
  const db=create(),now=Date.now(),config={...DEFAULTS,retentionDays:0,maxMessages:2};
  await db.ingest([message()],config,now-5000*DAY);
  assert.equal((await db.ingest([remove()],config,now))[0].text,'Xin chào bạn');
  await db.ingest([message('mid.2'),message('mid.3')],config,now);
  assert.ok((await db.stats()).count<=2);
});

test("cleanup works in bounded slices and rewrites only records that changed", async () => {
  const db = create(), now = Date.now();
  for (let batch = 0; batch < 5; batch++) await db.ingest(Array.from({ length: 64 }, (_, i) => message(`mid.${batch}.${i}`)), DEFAULTS, now);
  const first = await db.maintainSlice(DEFAULTS, now);
  assert.equal(first.processed, 256); assert.equal(first.written, 0, "nothing changed, so nothing is rewritten"); assert.ok(first.next);
  const second = await db.maintainSlice(DEFAULTS, now, first.next);
  assert.equal(second.processed, 64); assert.equal(second.next, null);
  const changed = await db.maintainSlice({ ...DEFAULTS, retentionDays: 10 }, now);
  assert.equal(changed.written, 256);
  let scheduled = 0;
  await db.maintain({ ...DEFAULTS, retentionDays: 11 }, now, true, work => { scheduled++; return work(); });
  assert.ok(scheduled >= 3, "each slice and the final prune go through the caller's queue");
  const before = await db.stats();
  await db.maintain({ ...DEFAULTS, retentionDays: 11 }, now, true);
  assert.equal((await db.stats()).bytes, before.bytes, "an idle cleanup does not change accounting");
});
