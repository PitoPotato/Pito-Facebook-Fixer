import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { Archive, pack, unpack } from "../src/archive.js";
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
test("edits replace text without accumulating old versions", async () => {
  const db = create(); await db.ingest([message()], DEFAULTS);
  await db.ingest([message("mid.1", { text: "Đã sửa" })], DEFAULTS);
  assert.equal((await db.ingest([remove()], DEFAULTS))[0].text, "Đã sửa");
  assert.equal((await db.stats()).count, 1);
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
