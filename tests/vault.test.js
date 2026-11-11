import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { Archive } from "../src/archive.js";
import { DEFAULTS } from "../src/shared.js";
import { decodeBase64 } from "../src/media.js";

const PASSWORD = "correct horse battery";
const create = () => new Archive(`vault-${crypto.randomUUID()}`);
const message = (id = "mid.1", extra = {}) => ({ account: "10001", thread: "20002", id, text: "Bí mật tuyệt đối", token: "pff-1", ...extra });
const remove = (id = "mid.1") => ({ ...message(id), removed: true, text: undefined });
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(600000).fill(7)]);
const decoded = bytes => new TextDecoder().decode(bytes);
async function raw(db) { return (await db.rawBatch(null, 100)).rows; }
async function sealAll(db) { let after = null; do { after = (await db.vaultSlice(after)).next; } while (after); }

test("a new capture is sealed at rest; no plaintext, digest or names reach the database", async () => {
  const db = create(); await db.vaultEnable(PASSWORD);
  await db.ingest([message("mid.1", { senderName: "Người gửi bí mật", replyText: "Trích dẫn bí mật", assets: [{ kind: "file", data: png, name: "bao-cao-mat.pdf", position: 0 }] })], DEFAULTS);
  const [row] = await raw(db);
  assert.equal(decoded(row.data).includes("Bí mật"), false); assert.equal(row.digest, ""); assert.ok(row.seal.w.byteLength >= 256);
  assert.equal(row.meta, undefined); assert.equal(row.assets[0].name, undefined);
  const stored = decoded(new Uint8Array(await row.assets[0].blob.arrayBuffer()));
  // The whole 8-byte signature: three letters alone turn up by chance in 600 KB of ciphertext.
  assert.equal(stored.includes("PNG\r\n\x1a\n"), false);
  const rows = (await db.list({ state: "all" })).rows;
  assert.equal(rows[0].text, "Bí mật tuyệt đối"); assert.equal(rows[0].senderName, "Người gửi bí mật"); assert.equal(rows[0].replyText, "Trích dẫn bí mật"); assert.equal(rows[0].assets[0].name, "bao-cao-mat.pdf");
});
test("a locked archive keeps capturing, cannot be read, and restores after unlocking", async () => {
  const db = create(); await db.vaultEnable(PASSWORD); await db.vaultLock();
  await db.ingest([message("mid.locked", { assets: [{ kind: "image", data: png, mime: "image/png", position: 0 }] })], DEFAULTS);
  assert.equal((await db.stats()).count, 1);
  const [restored] = await db.ingest([remove("mid.locked")], DEFAULTS);
  assert.equal(restored.locked, true); assert.equal(restored.text, ""); assert.deepEqual(restored.assets, []);
  const listed = await db.list(); assert.equal(listed.locked, true); assert.equal(listed.rows[0].locked, true); assert.equal(listed.rows[0].text, "");
  await assert.rejects(() => db.assetChunk({ account: "10001", thread: "20002", id: "mid.locked", index: 0 }), /errLocked/);
  await assert.rejects(() => db.vaultUnlock("wrong password"), /errWrongPassword/);
  await db.vaultUnlock(PASSWORD);
  assert.equal((await db.listRemoved())[0].text, "Bí mật tuyệt đối");
  let offset = 0; const parts = [];
  for (let done = false; !done;) { const chunk = await db.assetChunk({ account: "10001", thread: "20002", id: "mid.locked", index: 0, offset }); const bytes = decodeBase64(chunk.data); parts.push(bytes); offset += bytes.length; done = chunk.done; }
  assert.equal(offset, png.length); assert.deepEqual(Uint8Array.from(parts.flatMap(part => [...part])), png);
});
test("while locked a sealed record is left alone; unlocked edits are detected through the sealed digest", async () => {
  const db = create(); await db.vaultEnable(PASSWORD);
  await db.ingest([message()], DEFAULTS);
  const firstBytes = (await db.stats()).bytes;
  await db.ingest([message()], DEFAULTS); assert.equal((await db.stats()).bytes, firstBytes, "repeat observation rewrites nothing");
  await db.vaultLock(); await db.ingest([message("mid.1", { text: "Sửa khi đang khóa" })], DEFAULTS);
  assert.equal((await db.stats()).bytes, firstBytes);
  await db.vaultUnlock(PASSWORD); await db.ingest([message("mid.1", { text: "Sửa khi đã mở" })], DEFAULTS);
  const [row] = (await db.list({ state: "all" })).rows;
  assert.equal(row.text, "Sửa khi đã mở"); assert.deepEqual(row.history.map(entry => entry.text), ["Bí mật tuyệt đối"]);
  assert.equal((await raw(db))[0].history[0].seal !== undefined, true);
});
test("enabling seals existing messages; disabling restores the same content and removes the lock", async () => {
  const db = create(), plainBytes = png.slice();
  await db.ingest([message("mid.old", { senderName: "An", assets: [{ kind: "image", data: plainBytes, mime: "image/png", position: 0 }] })], DEFAULTS);
  await db.ingest([message("mid.old", { text: "Bản sửa" })], DEFAULTS);
  const before = (await db.list({ state: "all" })).rows[0];
  await db.vaultEnable(PASSWORD); await sealAll(db);
  const [sealed] = await raw(db);
  assert.equal(decoded(sealed.data).includes("Bản sửa"), false); assert.ok(sealed.history[0].seal); assert.ok(sealed.assets[0].seal); assert.equal(sealed.meta, undefined);
  assert.equal((await db.stats()).bytes, sealed.bytes, "budget accounting follows the sealed size");
  assert.deepEqual((await db.list({ state: "all" })).rows[0].history.map(entry => entry.text), before.history.map(entry => entry.text));
  await assert.rejects(() => db.vaultBeginDisable("not the password"), /errWrongPassword/);
  await db.vaultBeginDisable(PASSWORD); await sealAll(db);
  assert.deepEqual(await db.vaultStatus(), { enabled: false, unlocked: false, disabling: false, sealing: false, unsealed: 0 });
  const [open] = await raw(db);
  assert.equal(open.seal, undefined); assert.equal(decoded(open.data), "Bản sửa"); assert.deepEqual(new Uint8Array(await open.assets[0].blob.arrayBuffer()), plainBytes);
  const after = (await db.list({ state: "all" })).rows[0];
  assert.equal(after.senderName, "An"); assert.deepEqual(after.history.map(entry => entry.text), before.history.map(entry => entry.text));
});
test("the unlocked key does not survive into a fresh session", async () => {
  const db = create(); await db.vaultEnable(PASSWORD); await db.ingest([message()], DEFAULTS);
  const reopened = new Archive(db.name);
  assert.deepEqual(await reopened.vaultStatus(), { enabled: true, unlocked: false, disabling: false, sealing: true, unsealed: 0 });
  assert.equal((await reopened.list({ state: "all" })).rows[0].locked, true);
  assert.equal((await reopened.vaultUnlock(PASSWORD)).unlocked, true);
  assert.equal((await reopened.list({ state: "all" })).rows[0].text, "Bí mật tuyệt đối");
});
test("weak passwords are refused and a lock cannot be replaced by enabling twice", async () => {
  const db = create();
  await assert.rejects(() => db.vaultEnable("short"), /errPasswordShort/);
  await db.vaultEnable(PASSWORD);
  await assert.rejects(() => db.vaultEnable("another password"), /errVaultEnabled/);
});
test("while the lock is being removed a sealed record is not half-rewritten by a new observation", async () => {
  const db = create(); await db.vaultEnable(PASSWORD); await db.ingest([message()], DEFAULTS);
  await db.vaultBeginDisable(PASSWORD);
  await db.ingest([message("mid.1", { text: "Tin thay đổi giữa chừng" })], DEFAULTS);
  await db.ingest([message("mid.2", { text: "Tin mới khi đang tắt khóa" })], DEFAULTS);
  const rows = await raw(db);
  assert.ok(rows.find(row => row.id === "mid.1").seal, "the sealed copy stays whole");
  assert.equal(rows.find(row => row.id === "mid.2").seal, undefined, "new captures are no longer sealed");
  await sealAll(db);
  assert.equal((await db.list({ state: "all" })).rows.find(row => row.id === "mid.1").text, "Bí mật tuyệt đối");
});
