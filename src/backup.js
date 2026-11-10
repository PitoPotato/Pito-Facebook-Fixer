// Password-encrypted archive backup. Nothing here touches the network.
//
// File: MAGIC | u32 header length | header JSON | frames
// Frame: u32 ciphertext length | 12-byte IV | AES-GCM ciphertext
// Plaintext of a frame: u32 JSON length | JSON | attachment bytes.
// Each frame authenticates its position and the header, and the last frame
// states the record count, so reordering or truncation is detected.
import { MAX_TEXT, validId } from "./shared.js";
import { MAX_ASSETS, MAX_ASSET_BYTES, MAX_VIDEO_BYTES, MEDIA_KINDS, cleanFileName, detectedMime } from "./media.js";
import { deriveKey, validPassword, vaultBytes, PBKDF2_ITERATIONS } from "./vault.js";
import { MAX_EDIT_HISTORY } from "./archive.js";

const MAGIC = new TextEncoder().encode("PFFBAK1\n");
const MAX_HEADER = 64 * 1024, MAX_FRAME = MAX_VIDEO_BYTES + 64 * 1024 * 1024, MAX_ITERATIONS = 5000000;
const { concat, u32, random } = vaultBytes;
const encode = value => new TextEncoder().encode(JSON.stringify(value));
const decode = bytes => JSON.parse(new TextDecoder().decode(bytes));
const base64 = bytes => btoa(String.fromCharCode(...bytes));
const unbase64 = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const readU32 = bytes => new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
const aad = (headerHash, index) => concat(headerHash, u32(index));

async function sealFrame(key, headerHash, index, json, binaries) {
  const body = encode(json), plain = concat(u32(body.length), body, ...binaries), iv = random(12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(headerHash, index) }, key, plain));
  return new Blob([u32(data.length), iv, data]);
}
export async function createBackup(archive, passphrase, { onProgress = () => {} } = {}) {
  if (!validPassword(passphrase)) throw Error("errPasswordShort");
  const vault = await archive.vaultHandle(true), salt = random(16);
  const header = encode({ format: 1, kdf: { name: "PBKDF2", hash: "SHA-256", iterations: PBKDF2_ITERATIONS, salt: base64(salt) }, createdAt: Date.now() });
  const key = await deriveKey(passphrase, salt), headerHash = new Uint8Array(await crypto.subtle.digest("SHA-256", header));
  // Blob parts stay out of the JS heap, so a large archive is not held in RAM.
  const parts = [MAGIC, u32(header.length), header];
  let index = 0, count = 0, skipped = 0, missingFiles = 0, after = null;
  do {
    const batch = await archive.rawBatch(after, 8); after = batch.next;
    for (const record of batch.rows) {
      let exported;
      try { exported = await archive.exportRecord(record, vault); }
      catch (error) { if (error.message === "errLocked") throw error; skipped++; continue; }
      missingFiles += exported.missingFiles || 0;
      parts.push(await sealFrame(key, headerHash, index++, exported.json, exported.binaries)); onProgress(++count);
    }
  } while (after);
  parts.push(await sealFrame(key, headerHash, index, { end: true, count }, []));
  return { blob: new Blob(parts, { type: "application/octet-stream" }), count, skipped, missingFiles };
}
const slice = async (file, start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());
async function openHeader(file, passphrase) {
  const magic = await slice(file, 0, MAGIC.length);
  if (magic.length !== MAGIC.length || magic.some((value, index) => value !== MAGIC[index])) throw Error("errBackupFormat");
  const lengthBytes = await slice(file, MAGIC.length, MAGIC.length + 4);
  if (lengthBytes.length !== 4) throw Error("errBackupFormat");
  const length = readU32(lengthBytes);
  if (length <= 0 || length > MAX_HEADER) throw Error("errBackupFormat");
  const bytes = await slice(file, MAGIC.length + 4, MAGIC.length + 4 + length);
  if (bytes.length !== length) throw Error("errBackupFormat");
  let header, salt;
  try { header = decode(bytes); salt = unbase64(header.kdf.salt); } catch { throw Error("errBackupFormat"); }
  const iterations = header?.kdf?.iterations;
  if (header?.format !== 1 || header.kdf.name !== "PBKDF2" || header.kdf.hash !== "SHA-256" || !Number.isSafeInteger(iterations) || iterations < 100000 || iterations > MAX_ITERATIONS || salt.length < 16) throw Error("errBackupFormat");
  return { key: await deriveKey(passphrase, salt, iterations), headerHash: new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), offset: MAGIC.length + 4 + length };
}
async function* frames(file, opened) {
  let offset = opened.offset, index = 0;
  while (offset < file.size) {
    const head = await slice(file, offset, offset + 16);
    if (head.length !== 16) throw Error("errBackupTruncated");
    const length = readU32(head);
    if (length < 16 || length > MAX_FRAME) throw Error("errBackupFormat");
    const data = await slice(file, offset + 16, offset + 16 + length);
    if (data.length !== length) throw Error("errBackupTruncated");
    let plain;
    try { plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: head.subarray(4), additionalData: aad(opened.headerHash, index) }, opened.key, data)); }
    catch { throw Error(index ? "errBackupCorrupt" : "errBackupPassword"); }
    if (plain.length < 4) throw Error("errBackupCorrupt");
    const jsonLength = readU32(plain);
    let json;
    try { json = decode(plain.subarray(4, 4 + jsonLength)); } catch { throw Error("errBackupCorrupt"); }
    yield { json, payload: plain.subarray(4 + jsonLength) };
    offset += 16 + length; index++;
  }
}
const numberField = value => value === undefined || (Number.isSafeInteger(value) && value >= 0);
const stringField = (value, max) => value === undefined || (typeof value === "string" && value.length <= max);
async function validEntry({ json, payload }) {
  if (!json || !validId(json.account) || !/^\d+$/.test(json.account) || !validId(json.thread) || !validId(json.id)) return null;
  if (typeof json.text !== "string" || json.text.length > MAX_TEXT || !Number.isSafeInteger(json.capturedAt) || json.capturedAt <= 0 || !numberField(json.removedAt)) return null;
  if (!numberField(json.editedAt) || !numberField(json.sentAt) || !stringField(json.senderId, 40)) return null;
  if (!Array.isArray(json.assets) || json.assets.length > MAX_ASSETS || !Array.isArray(json.history) || json.history.length > 16) return null;
  if (json.history.some(entry => typeof entry?.text !== "string" || entry.text.length > MAX_TEXT || !numberField(entry.at))) return null;
  const meta = json.meta;
  if (meta !== undefined && (typeof meta !== "object" || meta === null || !stringField(meta.senderName, 120) || !stringField(meta.replyText, 500) || !stringField(meta.label, 200))) return null;
  let offset = 0; const binaries = [], assets = [];
  for (const asset of json.assets) {
    const limit = asset?.kind === "video" && asset.subtype !== "gif" ? MAX_VIDEO_BYTES : MAX_ASSET_BYTES;
    if (!MEDIA_KINDS.includes(asset?.kind) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > limit || offset + asset.size > payload.length) return null;
    const data = payload.slice(offset, offset + asset.size); offset += asset.size;
    if (typeof asset.digest !== "string" || hex(new Uint8Array(await crypto.subtle.digest("SHA-256", data))) !== asset.digest) return null;
    const mime = detectedMime(data, null, asset.kind);
    if (!mime) return null;
    // Only known fields, each checked, become part of the stored asset.
    const safeName = asset.kind === "file" ? cleanFileName(asset.name) : undefined;
    assets.push({ kind: asset.kind, mime, digest: asset.digest,
      position: Number.isInteger(asset.position) && asset.position >= 0 && asset.position < MAX_ASSETS ? asset.position : assets.length,
      capturedAt: Number.isSafeInteger(asset.capturedAt) && asset.capturedAt > 0 ? asset.capturedAt : json.capturedAt,
      ...(["gif", "sticker"].includes(asset.subtype) ? { subtype: asset.subtype } : {}), ...(safeName ? { name: safeName } : {}),
      ...(typeof asset.urlKey === "string" && /^[0-9a-f]{32}$/.test(asset.urlKey) ? { urlKey: asset.urlKey } : {}) });
    binaries.push(data);
  }
  if (offset !== payload.length) return null;
  // Rebuild the record from known fields only. A backup can come from anywhere,
  // and an unknown field such as `seal` must never reach the archive.
  const aliases = Array.isArray(json.aliases) ? json.aliases.filter(validId).slice(-4) : [];
  const purgedKinds = Array.isArray(json.purgedKinds) ? json.purgedKinds.filter(kind => MEDIA_KINDS.includes(kind)) : [];
  const details = meta ? Object.fromEntries(["senderName", "replyText", "label"].filter(key => meta[key]).map(key => [key, meta[key]])) : {};
  return { binaries, json: {
    account: json.account, thread: json.thread, id: json.id, text: json.text, capturedAt: json.capturedAt, removedAt: json.removedAt || 0,
    truncated: json.truncated === true, assets, history: json.history.slice(-MAX_EDIT_HISTORY).map(entry => ({ text: entry.text, at: entry.at })),
    ...(json.kind === "emoji" ? { kind: "emoji" } : {}), ...(json.removal === "vanished" ? { removal: "vanished" } : {}),
    ...(json.editedAt ? { editedAt: json.editedAt } : {}), ...(json.sentAt ? { sentAt: json.sentAt } : {}), ...(json.senderId ? { senderId: json.senderId } : {}),
    ...(Object.keys(details).length ? { meta: details } : {}), ...(purgedKinds.length ? { purgedKinds } : {}),
    ...(aliases.length ? { aliases, aliasKeys: aliases.map(id => JSON.stringify([json.account, id])) } : {}),
  } };
}
export async function restoreBackup(archive, file, passphrase, settings, { onProgress = () => {} } = {}) {
  if (!validPassword(passphrase)) throw Error("errPasswordShort");
  const opened = await openHeader(file, passphrase);
  // Verify the entire file before the first write: a truncated or tampered
  // backup must not leave a half-imported archive behind.
  let seen = 0, ended = false;
  for await (const frame of frames(file, opened)) {
    if (ended) throw Error("errBackupCorrupt");
    if (frame.json?.end === true) { if (frame.json.count !== seen) throw Error("errBackupCorrupt"); ended = true; } else seen++;
  }
  if (!ended) throw Error("errBackupTruncated");
  const result = { imported: 0, duplicates: 0, rejected: 0, expired: 0, invalid: 0 };
  let batch = [], batchBytes = 0, done = 0;
  const flush = async () => {
    if (!batch.length) return;
    const outcome = await archive.importRecords(batch, settings);
    for (const key of Object.keys(outcome)) result[key] += outcome[key];
    batch = []; batchBytes = 0;
  };
  for await (const frame of frames(file, opened)) {
    if (frame.json?.end === true) break;
    const entry = await validEntry(frame);
    if (entry) { batch.push(entry); batchBytes += frame.payload.length; } else result.invalid++;
    onProgress(++done, seen);
    if (batch.length >= 16 || batchBytes >= 32 * 1024 * 1024) await flush();
  }
  await flush();
  return result;
}
