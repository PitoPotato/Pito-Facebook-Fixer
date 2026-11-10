// Optional password lock for the archive.
//
// A random RSA pair lets the worker seal new captures while the archive is
// locked: only the public key is needed to write. The private key is wrapped by
// a passphrase-derived key and, once unlocked, lives only in session storage.
// Every text, media file and metadata box has its own AES-256-GCM key.
export const PBKDF2_ITERATIONS = 600000;
export const MIN_PASSWORD_LENGTH = 8;
const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' };
const encoder = new TextEncoder();
const random = length => crypto.getRandomValues(new Uint8Array(length));
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
const fromHex = value => Uint8Array.from(value.match(/../g) || [], pair => parseInt(pair, 16));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0; for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
};
const u32 = value => { const out = new Uint8Array(4); new DataView(out.buffer).setUint32(0, value); return out; };
const aes = (raw, usage) => crypto.subtle.importKey('raw', raw, 'AES-GCM', false, [usage]);

export function validPassword(value) { return typeof value === 'string' && value.length >= MIN_PASSWORD_LENGTH && value.length <= 1024; }
export async function deriveKey(passphrase, salt, iterations = PBKDF2_ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', encoder.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function createVaultRecord(passphrase) {
  const pair = await crypto.subtle.generateKey({ ...RSA, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['encrypt', 'decrypt']);
  const salt = random(16), iv = random(12), key = await deriveKey(passphrase, salt);
  const privateBytes = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  return {
    privateBytes,
    record: {
      version: 1, iterations: PBKDF2_ITERATIONS, salt, iv,
      wrapped: new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, privateBytes)),
      publicKey: new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)),
    },
  };
}
export async function unwrapVaultRecord(record, passphrase) {
  try {
    const key = await deriveKey(passphrase, record.salt, record.iterations);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: record.iv }, key, record.wrapped));
  } catch { throw Error('errWrongPassword'); }
}
export const importPublicKey = bytes => crypto.subtle.importKey('spki', bytes, RSA, false, ['encrypt']);
export const importPrivateKey = bytes => crypto.subtle.importKey('pkcs8', bytes, RSA, false, ['decrypt']);

async function wrapKey(publicKey, raw, digest) {
  return new Uint8Array(await crypto.subtle.encrypt(RSA, publicKey, concat(raw, digest ? fromHex(digest) : new Uint8Array())));
}
async function unwrapKey(privateKey, wrapped) {
  const out = new Uint8Array(await crypto.subtle.decrypt(RSA, privateKey, wrapped));
  return { raw: out.subarray(0, 32), digest: hex(out.subarray(32)) };
}
// The plaintext digest travels inside the RSA envelope, so equality between
// messages stays comparable when unlocked and is never stored in the clear.
export async function sealBytes(publicKey, bytes, digest = '') {
  const raw = random(32), iv = random(12), key = await aes(raw, 'encrypt');
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return { data, seal: { w: await wrapKey(publicKey, raw, digest), iv } };
}
export async function openBytes(privateKey, data, seal) {
  const { raw } = await unwrapKey(privateKey, seal.w), key = await aes(raw, 'decrypt');
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: seal.iv }, key, data));
}
export async function sealedDigest(privateKey, seal) { return (await unwrapKey(privateKey, seal.w)).digest; }
export async function sealJson(publicKey, value) { return sealBytes(publicKey, encoder.encode(JSON.stringify(value))); }
export async function openJson(privateKey, box) { return JSON.parse(new TextDecoder().decode(await openBytes(privateKey, box.data, box.seal))); }

// Media is sealed in fixed plaintext chunks so a single chunk can be served
// without decrypting the whole file.
export async function sealAsset(publicKey, bytes, digest, chunk) {
  const raw = random(32), key = await aes(raw, 'encrypt'), parts = [];
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += chunk, index++) {
    const iv = random(12), plain = bytes.subarray(offset, offset + chunk);
    parts.push(iv, new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: u32(index) }, key, plain)));
  }
  return { blob: new Blob(parts, { type: 'application/octet-stream' }), seal: { w: await wrapKey(publicKey, raw, digest), chunk }, plainSize: bytes.byteLength, digest: hex(random(16)) };
}
async function openSegment(key, blob, chunk, index) {
  const segment = chunk + 28, data = new Uint8Array(await blob.slice(index * segment, (index + 1) * segment).arrayBuffer());
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.subarray(0, 12), additionalData: u32(index) }, key, data.subarray(12)));
}
async function assetKey(privateKey, seal) { return aes((await unwrapKey(privateKey, seal.w)).raw, 'decrypt'); }
export async function openAssetChunk(privateKey, asset, offset) {
  const { chunk } = asset.seal;
  if (offset % chunk) throw Error('errInvalidMedia');
  return openSegment(await assetKey(privateKey, asset.seal), asset.blob, chunk, offset / chunk);
}
export async function openAsset(privateKey, asset) {
  const { chunk } = asset.seal, key = await assetKey(privateKey, asset.seal), out = new Uint8Array(asset.plainSize);
  for (let offset = 0, index = 0; offset < asset.plainSize; offset += chunk, index++) out.set(await openSegment(key, asset.blob, chunk, index), offset);
  return out;
}
export const vaultBytes = { concat, u32, random };
