// Regressions for defects found in the third independent review of 0.3.0.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { Archive } from "../src/archive.js";
import { createBackup } from "../src/backup.js";
import { DEFAULTS } from "../src/shared.js";

const VAULT = "vault password 1";
const message = (id, extra = {}) => ({ account: "10001", thread: "20002", id, text: `Nội dung ${id}`, token: "pff-1", ...extra });
const png = size => { const bytes = new Uint8Array(size); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); return bytes; };
const sharedKeys = () => { let value = null; return { get: async () => value, set: async next => { value = next; }, clear: async () => { value = null; } }; };
async function drain(db) { let after = null, slice; do { slice = await db.vaultSlice(after); after = slice.next; } while (after); return slice; }
async function damage(db, id) {
  const tx = (await db.open()).transaction("messages", "readwrite"), store = tx.objectStore("messages");
  const row = await new Promise(resolve => { const r = store.get(["10001", "20002", id]); r.onsuccess = () => resolve(r.result); });
  row.seal = { ...row.seal, w: row.seal.w.map(byte => byte ^ 1) }; store.put(row); await new Promise(resolve => { tx.oncomplete = resolve; });
}
// Makes every Blob of exactly this size unreadable, as a browser can after a profile problem.
function unreadable(size, work) {
  const original = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = function () { return this.size === size ? Promise.reject(new DOMException("gone", "NotReadableError")) : original.call(this); };
  return work().finally(() => { Blob.prototype.arrayBuffer = original; });
}

test("two disable passes at once never remove the lock while a damaged record remains", async () => {
  const name = `review3-${crypto.randomUUID()}`, keys = sharedKeys(), a = new Archive(name, keys), b = new Archive(name, keys);
  await a.vaultEnable(VAULT);
  await a.ingest(Array.from({ length: 20 }, (_, i) => message(`mid.${String(i).padStart(2, "0")}`)), DEFAULTS);
  await damage(a, "mid.00");
  await a.vaultBeginDisable(VAULT);
  // Pass A starts and sees the damaged record; pass B starts over before A ends.
  let afterA = (await a.vaultSlice(null)).next;
  await drain(b);
  while (afterA) afterA = (await a.vaultSlice(afterA)).next;
  assert.equal((await a.vaultStatus(true)).enabled, true, "the lock must stay while a sealed record remains");
  assert.equal((await b.list({ state: "all" })).rows.find(row => row.id === "mid.00").damaged, true);
});
test("a record that cannot be sealed keeps sealing open and is counted, not silently left plain", async () => {
  const db = new Archive(`review3-${crypto.randomUUID()}`);
  await db.ingest([message("mid.ok"), message("mid.file", { assets: [{ kind: "image", data: png(4321), mime: "image/png", position: 0 }] })], DEFAULTS);
  await db.vaultEnable(VAULT);
  const last = await unreadable(4321, () => drain(db));
  assert.equal(last.failed, 1);
  const status = await db.vaultStatus();
  assert.equal(status.sealing, true); assert.equal(status.unsealed, 1);
  const exported = await unreadable(4321, () => createBackup(db, "backup password 1"));
  assert.equal(exported.count, 2, "the readable text of that message is still exported"); assert.equal(exported.missingFiles, 1);
  await db.purgeMedia("image", 0, true, DEFAULTS);
  const done = await drain(db);
  assert.equal(done.failed, 0); assert.equal((await db.vaultStatus()).sealing, false); assert.equal((await db.vaultStatus()).unsealed, 0);
});
test("export leaves out only an unreadable file of a sealed message; removing the lock stops instead of dropping it", async () => {
  const db = new Archive(`review3-${crypto.randomUUID()}`);
  await db.vaultEnable(VAULT);
  await db.ingest([message("mid.sealedfile", { assets: [{ kind: "image", data: png(5555), mime: "image/png", position: 0 }] })], DEFAULTS);
  const [row] = (await db.rawBatch(null, 5)).rows, cipherSize = row.assets[0].blob.size;
  const exported = await unreadable(cipherSize, () => createBackup(db, "backup password 1"));
  assert.equal(exported.count, 1, "the text is exported"); assert.equal(exported.missingFiles, 1); assert.equal(exported.skipped, 0);
  await db.vaultBeginDisable(VAULT);
  const last = await unreadable(cipherSize, () => drain(db));
  assert.equal(last.failed, 1); assert.equal((await db.vaultStatus()).enabled, true);
  const done = await drain(db);
  assert.equal(done.failed, 0); assert.equal((await db.vaultStatus()).enabled, false, "once readable, the lock comes off with the file intact");
  assert.equal((await db.rawBatch(null, 5)).rows[0].assets.length, 1);
});
