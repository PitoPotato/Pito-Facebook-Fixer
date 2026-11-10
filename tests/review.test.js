// Regressions for defects found by independent review of 0.3.0.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { Archive } from "../src/archive.js";
import { restoreBackup } from "../src/backup.js";
import { DEFAULTS } from "../src/shared.js";
import { decodeBase64 } from "../src/media.js";
import { deriveKey, vaultBytes } from "../src/vault.js";

const PASSWORD = "correct horse battery";
const create = () => new Archive(`review-${crypto.randomUUID()}`);
const message = (id = "mid.1", extra = {}) => ({ account: "10001", thread: "20002", id, text: "Bí mật tuyệt đối", token: "pff-1", ...extra });
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...Array(6000).fill(0).map((_, i) => i % 251)]);
const decoded = bytes => new TextDecoder().decode(bytes);
const raw = async db => (await db.rawBatch(null, 100)).rows;
async function sealAll(db) { let after = null; do { after = (await db.vaultSlice(after)).next; } while (after); }

test("an edit and a new photo arriving before migration reaches a record leave nothing plain and corrupt nothing", async () => {
  const db = create(), photo = png.slice(0, 5000), second = Uint8Array.from([...png.slice(0, 4000), 42]);
  await db.ingest([message("mid.mix", { text: "Bản gốc PLAINTEXT-SECRET", senderName: "An", assets: [{ kind: "image", data: photo, mime: "image/png", position: 0 }] })], DEFAULTS);
  await db.vaultEnable(PASSWORD);
  await db.ingest([message("mid.mix", { text: "Bản sửa trong lúc niêm phong", assets: [{ kind: "image", data: second, mime: "image/png", position: 1 }] })], DEFAULTS);
  await sealAll(db);
  const [row] = await raw(db);
  assert.ok(row.seal); assert.equal(row.meta, undefined);
  assert.ok(row.history.every(entry => entry.seal)); assert.ok(row.assets.every(asset => asset.seal));
  for (const asset of row.assets) assert.equal(decoded(new Uint8Array(await asset.blob.arrayBuffer())).includes("PNG"), false);
  assert.equal(decoded(row.history[0].data).includes("PLAINTEXT-SECRET"), false);
  const [listed] = (await db.list({ state: "all" })).rows;
  assert.equal(listed.text, "Bản sửa trong lúc niêm phong"); assert.deepEqual(listed.history.map(entry => entry.text), ["Bản gốc PLAINTEXT-SECRET"]); assert.equal(listed.senderName, "An");
  for (const [index, expected] of [photo, second].entries()) {
    const chunk = await db.assetChunk({ account: "10001", thread: "20002", id: "mid.mix", index, offset: 0 }, { any: true });
    assert.deepEqual(decodeBase64(chunk.data), expected, `photo ${index} stays intact`);
  }
  await db.vaultBeginDisable(PASSWORD); await sealAll(db);
  assert.equal((await db.vaultStatus()).enabled, false);
  const [open] = await raw(db); assert.deepEqual(new Uint8Array(await open.assets[1].blob.arrayBuffer()), second);
});
test("a record that is only partly sealed can still be opened, exported and unsealed", async () => {
  const db = create(); await db.vaultEnable(PASSWORD); const vault = await db.vaultHandle();
  await db.ingest([message("mid.part", { assets: [{ kind: "image", data: png.slice(0, 3000), mime: "image/png", position: 0 }] })], DEFAULTS);
  const [sealed] = await raw(db), half = await db.unsealRecord(sealed, vault);
  half.assets = sealed.assets; // plain text with a sealed photo, the shape the earlier build could leave
  assert.equal((await db.openRecord(half, vault)).text, "Bí mật tuyệt đối");
  const reopened = await db.unsealRecord(half, vault); assert.equal(reopened.assets[0].seal, undefined);
  assert.deepEqual(new Uint8Array(await reopened.assets[0].blob.arrayBuffer()), png.slice(0, 3000));
  assert.equal((await db.sealRecord(half, vault)).assets[0].seal, sealed.assets[0].seal, "an already sealed part is not sealed twice");
  assert.ok((await db.exportRecord(half, vault)).binaries[0].length === 3000);
});
test("a full sealing pass is recorded; clearing removes the lock for a forgotten password", async () => {
  const db = create();
  await db.ingest(Array.from({ length: 40 }, (_, i) => message(`mid.p${i}`)), DEFAULTS);
  await db.vaultEnable(PASSWORD); assert.equal((await db.vaultStatus()).sealing, true);
  await db.vaultSlice(null); assert.equal((await db.vaultStatus()).sealing, true, "a partial pass is not enough");
  await sealAll(db); assert.equal((await db.vaultStatus()).sealing, false);
  await db.vaultLock(); await db.clear();
  assert.deepEqual(await db.vaultStatus(), { enabled: false, unlocked: false, disabling: false, sealing: false, unsealed: 0 });
  await db.ingest([message("mid.after")], DEFAULTS); assert.equal((await raw(db))[0].seal, undefined);
});
test("under the lock, a duplicate in one batch is not an edit and later details are merged, not replaced", async () => {
  const db = create(); await db.vaultEnable(PASSWORD);
  await db.ingest([message("mid.dup"), message("mid.dup")], DEFAULTS);
  assert.deepEqual((await db.list({ state: "all" })).rows[0].history, []);
  await db.ingest([message("mid.dup", { senderName: "An", replyText: "Gốc", assets: [{ kind: "file", data: png.slice(0, 2000), name: "mot.bin", position: 0 }] })], DEFAULTS);
  await db.ingest([message("mid.dup", { assets: [{ kind: "file", data: png.slice(0, 2500), name: "hai.bin", position: 1 }] })], DEFAULTS);
  await db.ingest([message("mid.dup", { sentAt: 1800000000000 })], DEFAULTS);
  const [row] = (await db.list({ state: "all" })).rows;
  assert.equal(row.senderName, "An"); assert.equal(row.replyText, "Gốc"); assert.equal(row.sentAt, 1800000000000);
  assert.deepEqual(row.assets.map(asset => asset.name), ["mot.bin", "hai.bin"]); assert.deepEqual(row.history, []);
});
test("a v4 record without a digest re-observed under the lock is not treated as an edit", async () => {
  const db = create();
  await db.ingest([message("mid.v4")], DEFAULTS);
  const tx = (await db.open()).transaction("messages", "readwrite"), store = tx.objectStore("messages");
  const old = await new Promise(resolve => { const r = store.get(["10001", "20002", "mid.v4"]); r.onsuccess = () => resolve(r.result); });
  delete old.digest; store.put(old); await new Promise(resolve => { tx.oncomplete = resolve; });
  await db.vaultEnable(PASSWORD);
  await db.ingest([message("mid.v4")], DEFAULTS); await sealAll(db);
  assert.deepEqual((await db.list({ state: "all" })).rows[0].history, []);
});

const frameKit = async () => {
  const salt = vaultBytes.random(16), { u32, concat } = vaultBytes;
  const encode = value => new TextEncoder().encode(JSON.stringify(value));
  const header = encode({ format: 1, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 100000, salt: btoa(String.fromCharCode(...salt)) } });
  const key = await deriveKey("backup password 1", salt, 100000), hash = new Uint8Array(await crypto.subtle.digest("SHA-256", header));
  const frame = async (index, json, binary = new Uint8Array()) => {
    const body = encode(json), iv = vaultBytes.random(12);
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: concat(hash, u32(index)) }, key, concat(u32(body.length), body, binary)));
    return concat(u32(sealed.length), iv, sealed);
  };
  return { frame, start: [new TextEncoder().encode("PFFBAK1\n"), u32(header.length), header] };
};
const hexDigest = async bytes => Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("hex");
test("asset fields in an authenticated backup are rebuilt from checked values only", async () => {
  const { frame, start } = await frameKit(), data = png.slice(0, 1000);
  const huge = new Uint8Array(9 * 1024 * 1024); huge.set(png.subarray(0, 8));
  const record = (id, asset) => ({ account: "10001", thread: "20002", id, text: "", capturedAt: Date.now(), removedAt: 0, history: [], assets: [asset] });
  const file = new File([...start,
    await frame(0, record("mid.fields", { kind: "image", size: data.length, digest: await hexDigest(data), position: "not-a-number", subtype: "<b>", extra: "x".repeat(1000), seal: { w: [1] }, urlKey: "nope" }), data),
    await frame(1, record("mid.huge", { kind: "image", size: huge.length, digest: await hexDigest(huge) }), huge),
    await frame(2, { end: true, count: 2 })], "x");
  const db = create(), result = await restoreBackup(db, file, "backup password 1", { ...DEFAULTS, maxBytes: 64 * 1024 * 1024 });
  assert.equal(result.imported, 1); assert.equal(result.invalid, 1, "an image over 8 MiB is refused");
  const [stored] = await raw(db), [asset] = stored.assets;
  assert.deepEqual(Object.keys(asset).sort(), ["blob", "capturedAt", "digest", "kind", "mime", "position"]); assert.equal(asset.position, 0);
});
test("a malformed header or frame is reported as a format problem, never as a raw exception", async () => {
  const { u32 } = vaultBytes, magic = new TextEncoder().encode("PFFBAK1\n");
  for (const header of ["{not json", JSON.stringify({ format: 1, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 100000, salt: "!!!" } }), JSON.stringify({ format: 1 })]) {
    const bytes = new TextEncoder().encode(header);
    await assert.rejects(() => restoreBackup(create(), new File([magic, u32(bytes.length), bytes], "x"), "backup password 1", DEFAULTS), /errBackupFormat/, header);
  }
  await assert.rejects(() => restoreBackup(create(), new File([magic, new Uint8Array([0, 0])], "x"), "backup password 1", DEFAULTS), /errBackupFormat/);
});
