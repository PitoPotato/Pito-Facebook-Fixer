// Regressions for defects found in the second independent review of 0.3.0.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { Archive } from "../src/archive.js";
import { createBackup, restoreBackup } from "../src/backup.js";
import { DEFAULTS } from "../src/shared.js";

const VAULT = "vault password 1", BACKUP = "backup password 1";
const message = (id, extra = {}) => ({ account: "10001", thread: "20002", id, text: `Nội dung ${id}`, token: "pff-1", ...extra });
const raw = async db => (await db.rawBatch(null, 100)).rows;
const sharedKeys = () => { let value = null; return { get: async () => value, set: async next => { value = next; }, clear: async () => { value = null; } }; };
async function drain(db) { let after = null, slice; do { slice = await db.vaultSlice(after); after = slice.next; } while (after); return slice; }

test("an import racing a lock removal is prepared again instead of leaving sealed records without a lock", async () => {
  const name = `review2-${crypto.randomUUID()}`, keys = sharedKeys();
  const worker = new Archive(name, keys), page = new Archive(name, keys);
  await worker.ingest([message("mid.source")], DEFAULTS);
  const { blob } = await createBackup(worker, BACKUP);
  await worker.clear(); await worker.vaultEnable(VAULT);
  // The worker turns the lock off while the page is still sealing the import.
  const seal = page.sealRecord.bind(page); let raced = false;
  page.sealRecord = async (...args) => { const sealed = await seal(...args); if (!raced) { raced = true; await worker.vaultBeginDisable(VAULT); await drain(worker); } return sealed; };
  const result = await restoreBackup(page, new File([blob], "x"), BACKUP, DEFAULTS);
  assert.equal(raced, true); assert.equal(result.imported, 1);
  assert.equal((await worker.vaultStatus()).enabled, false);
  assert.ok((await raw(worker)).every(row => !row.seal && !row.metaBox), "nothing is left sealed without a lock");
  assert.equal((await worker.list({ state: "all" })).rows[0].text, "Nội dung mid.source");
});
test("an import racing a lock being turned on is prepared again and ends up sealed", async () => {
  const name = `review2-${crypto.randomUUID()}`, keys = sharedKeys();
  const worker = new Archive(name, keys), page = new Archive(name, keys);
  await worker.ingest([message("mid.source")], DEFAULTS);
  const { blob } = await createBackup(worker, BACKUP); await worker.clear();
  // The page takes its lock snapshot, then the lock is turned on and a full sealing pass
  // finishes before the page writes. The write must notice and seal its batch.
  const handle = page.vaultHandle.bind(page); let raced = false;
  page.vaultHandle = async (...args) => { const snapshot = await handle(...args); if (!raced) { raced = true; await worker.vaultEnable(VAULT); await drain(worker); } return snapshot; };
  await restoreBackup(page, new File([blob], "x"), BACKUP, DEFAULTS);
  assert.equal(raced, true); assert.equal((await worker.vaultStatus()).sealing, false);
  assert.ok((await raw(worker)).every(row => row.seal), "rows written after the lock was turned on are sealed");
});
test("one record that cannot be opened is reported, and never breaks the list, export or the lock", async () => {
  const db = new Archive(`review2-${crypto.randomUUID()}`);
  await db.vaultEnable(VAULT); await db.ingest([message("mid.good"), message("mid.bad")], DEFAULTS);
  const tx = (await db.open()).transaction("messages", "readwrite"), store = tx.objectStore("messages");
  const bad = await new Promise(resolve => { const r = store.get(["10001", "20002", "mid.bad"]); r.onsuccess = () => resolve(r.result); });
  bad.seal = { ...bad.seal, w: bad.seal.w.map(byte => byte ^ 1) }; store.put(bad); await new Promise(resolve => { tx.oncomplete = resolve; });
  const rows = (await db.list({ state: "all" })).rows;
  assert.equal(rows.find(row => row.id === "mid.good").text, "Nội dung mid.good"); assert.equal(rows.find(row => row.id === "mid.bad").damaged, true);
  const exported = await createBackup(db, BACKUP); assert.equal(exported.count, 1); assert.equal(exported.skipped, 1);
  const [restored] = await db.ingest([{ ...message("mid.bad"), removed: true, text: undefined }], DEFAULTS);
  assert.equal(restored.locked, true, "a damaged record is not written into a bubble as empty text");
  await db.vaultBeginDisable(VAULT); const last = await drain(db);
  assert.equal(last.failed, 1); assert.equal((await db.vaultStatus()).enabled, true, "the lock stays while a record cannot be opened");
  assert.equal((await db.list({ state: "all" })).rows.find(row => row.id === "mid.good").text, "Nội dung mid.good");
});
