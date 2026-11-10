import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { Archive } from "../src/archive.js";
import { createBackup, restoreBackup } from "../src/backup.js";
import { DEFAULTS, DAY } from "../src/shared.js";
import { decodeBase64 } from "../src/media.js";
import { deriveKey, vaultBytes } from "../src/vault.js";

const PASSWORD = "backup password 1";
const create = () => new Archive(`backup-${crypto.randomUUID()}`);
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(300000).fill(0).map((_, i) => i % 251)]);
const message = (id, extra = {}) => ({ account: "10001", thread: "20002", id, text: `Nội dung ${id}`, token: "pff-1", ...extra });
const remove = id => ({ ...message(id), removed: true, text: undefined });
async function filled() {
  const db = create();
  await db.ingest([message("mid.1", { senderName: "An", sentAt: 1800000000000, replyText: "Câu gốc", assets: [{ kind: "image", data: png, mime: "image/png", position: 0 }] })], DEFAULTS);
  await db.ingest([message("mid.1", { text: "Đã sửa" })], DEFAULTS);
  await db.ingest([message("mid.other", { account: "20003" })], DEFAULTS);
  await db.ingest([remove("mid.1")], DEFAULTS);
  return db;
}
const asFile = blob => new File([blob], "backup.pffbak");
async function fileBytes(blob) { return new Uint8Array(await blob.arrayBuffer()); }

test("export, clear and import returns the same text, media, history, metadata and account separation", async () => {
  const db = await filled(), { blob, count } = await createBackup(db, PASSWORD);
  assert.equal(count, 2);
  const text = new TextDecoder("latin1").decode(await fileBytes(blob));
  assert.equal(text.includes("Đã sửa"), false); assert.equal(text.includes("IHDR"), false); assert.equal(text.includes("mid.1"), false);
  await db.clear();
  assert.deepEqual(await restoreBackup(db, asFile(blob), PASSWORD, DEFAULTS), { imported: 2, duplicates: 0, rejected: 0, expired: 0, invalid: 0 });
  const stats = await db.stats(); assert.equal(stats.count, 2); assert.equal(stats.removed, 1); assert.ok(stats.bytes >= png.length);
  const [row] = await db.listRemoved();
  assert.equal(row.text, "Đã sửa"); assert.equal(row.senderName, "An"); assert.equal(row.sentAt, 1800000000000); assert.equal(row.replyText, "Câu gốc");
  assert.deepEqual(row.history.map(entry => entry.text), ["Nội dung mid.1"]);
  const chunk = await db.assetChunk({ account: "10001", thread: "20002", id: "mid.1", index: 0, offset: 0 });
  assert.deepEqual(decodeBase64(chunk.data), png.subarray(0, 192 * 1024));
  assert.deepEqual(await db.ingest([remove("mid.other")], DEFAULTS), [], "another account's record stays with that account");
});
test("wrong password, foreign file, truncation and tampering import nothing", async () => {
  const db = await filled(), { blob } = await createBackup(db, PASSWORD), target = create();
  await assert.rejects(() => restoreBackup(target, asFile(blob), "not the right one", DEFAULTS), /errBackupPassword/);
  await assert.rejects(() => restoreBackup(target, new File(["hello world, not a backup"], "x"), PASSWORD, DEFAULTS), /errBackupFormat/);
  const cut = await blob.slice(0, blob.size - 40).arrayBuffer();
  await assert.rejects(() => restoreBackup(target, new File([cut], "x"), PASSWORD, DEFAULTS), /errBackup(Truncated|Corrupt)/);
  const bytes = await fileBytes(blob); bytes[bytes.length - 200] ^= 1;
  await assert.rejects(() => restoreBackup(target, new File([bytes], "x"), PASSWORD, DEFAULTS), /errBackupCorrupt|errBackupPassword/);
  assert.equal((await target.stats()).count, 0);
});
test("a whole-frame cut still fails because the final frame states the count", async () => {
  const db = await filled(), { blob } = await createBackup(db, PASSWORD), bytes = await fileBytes(blob);
  // Walk to the final frame and drop it; every remaining frame is authentic.
  let offset = 8, read = at => new DataView(bytes.buffer).getUint32(at), last = 0;
  offset += 4 + read(8);
  while (offset < bytes.length) { last = offset; offset += 16 + read(offset); }
  await assert.rejects(() => restoreBackup(create(), new File([bytes.slice(0, last)], "x"), PASSWORD, DEFAULTS), /errBackupTruncated/);
});
test("import never overwrites or evicts local records and reports what did not fit", async () => {
  const db = await filled(), { blob } = await createBackup(db, PASSWORD);
  await db.ingest([message("mid.other", { account: "20003", text: "Bản mới hơn trên máy" })], DEFAULTS);
  const result = await restoreBackup(db, asFile(blob), PASSWORD, DEFAULTS);
  assert.equal(result.duplicates, 2); assert.equal(result.imported, 0);
  assert.equal((await db.list({ state: "all" })).rows.find(row => row.account === "20003").text, "Bản mới hơn trên máy");
  const small = create(), config = { ...DEFAULTS, maxBytes: 4 * 1024 };
  await small.ingest([message("mid.local")], config);
  const limited = await restoreBackup(small, asFile(blob), PASSWORD, config);
  assert.equal(limited.rejected, 1); assert.equal(limited.imported, 1);
  assert.equal((await small.stats()).evicted, 0); assert.ok((await small.list({ state: "all" })).rows.some(row => row.id === "mid.local"));
});
test("records past the current retention are reported, not stored", async () => {
  const db = create(), now = Date.now();
  await db.ingest([message("mid.old")], DEFAULTS, now - 10 * DAY);
  const { blob } = await createBackup(db, PASSWORD), target = create();
  assert.equal((await restoreBackup(target, asFile(blob), PASSWORD, { ...DEFAULTS, retentionDays: 1 })).expired, 1);
  assert.equal((await target.stats()).count, 0);
});
test("a locked archive refuses export; a sealed archive exports and re-seals on import", async () => {
  const db = await filled();
  await db.vaultEnable("vault password 1");
  let after = null; do { after = (await db.vaultSlice(after)).next; } while (after);
  const { blob } = await createBackup(db, PASSWORD);
  await db.vaultLock();
  await assert.rejects(() => createBackup(db, PASSWORD), /errLocked/);
  await db.vaultUnlock("vault password 1"); await db.clear();
  assert.equal((await db.vaultStatus()).enabled, false, "clearing everything also removes the lock");
  await db.vaultEnable("vault password 2");
  await restoreBackup(db, asFile(blob), PASSWORD, DEFAULTS);
  const stored = (await db.rawBatch(null, 10)).rows.find(row => row.id === "mid.1");
  assert.ok(stored.seal); assert.equal((await db.listRemoved())[0].text, "Đã sửa");
});
test("unknown or malformed fields in an authenticated backup never reach the archive", async () => {
  const salt = vaultBytes.random(16), { u32, concat } = vaultBytes;
  const encode = value => new TextEncoder().encode(JSON.stringify(value));
  const header = encode({ format: 1, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 100000, salt: btoa(String.fromCharCode(...salt)) } });
  const key = await deriveKey(PASSWORD, salt, 100000), hash = new Uint8Array(await crypto.subtle.digest("SHA-256", header));
  const frame = async (index, json) => {
    const body = encode(json), iv = vaultBytes.random(12);
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: concat(hash, u32(index)) }, key, concat(u32(body.length), body)));
    return concat(u32(data.length), iv, data);
  };
  const good = { account: "10001", thread: "20002", id: "mid.crafted", text: "ok", capturedAt: Date.now(), removedAt: 0, assets: [], history: [], seal: { w: [1] }, digest: "x", bytes: 1, evil: "y", meta: { senderName: "A", injected: "z" } };
  const bad = { ...good, id: "mid.bad", account: "not-digits" };
  const file = new File([new TextEncoder().encode("PFFBAK1\n"), u32(header.length), header, await frame(0, good), await frame(1, bad), await frame(2, { end: true, count: 2 })], "x");
  const db = create(), result = await restoreBackup(db, file, PASSWORD, DEFAULTS);
  assert.equal(result.imported, 1); assert.equal(result.invalid, 1);
  const [row] = (await db.rawBatch(null, 5)).rows;
  assert.equal(row.seal, undefined); assert.equal(row.evil, undefined); assert.deepEqual(row.meta, { senderName: "A" });
  assert.equal((await db.list({ state: "all" })).rows[0].text, "ok");
});
