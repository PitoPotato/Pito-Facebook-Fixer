export const DAY = 86400000;
export const MiB = 1024 * 1024;
export const DEFAULTS = Object.freeze({
  archive: true, antiReload: true, focusGuard: true,
  blockStory: false, theme: 'system', language: 'en',
  maxBytes: 32 * MiB, maxMessages: 20000, retentionDays: 30,
  cleanupRemoved: true, imageRetentionDays: 0, voiceRetentionDays: 0, videoRetentionDays: 0, fileRetentionDays: 0, autoVoice: true,
  saveStickers: true, saveFiles: true, saveVideo: false, maxVideoMiB: 32, bridgeCapture: true,
});
export const CHANNEL = "pito-facebook-fixer:v1";
export const MAX_TEXT = 16000;
export const MAX_BATCH = 64;
export const HOSTS = new Set(["www.facebook.com", "web.facebook.com", "www.messenger.com", "messenger.com"]);
export function supportedURL(value) {
  try { const u = new URL(value); return u.protocol === "https:" && HOSTS.has(u.hostname); } catch { return false; }
}
export function normalizeSettings(value = {}) {
  const out = { ...DEFAULTS };
  for (const key of ["archive", "antiReload", "focusGuard", "blockStory", "cleanupRemoved", "autoVoice", "saveStickers", "saveFiles", "saveVideo", "bridgeCapture"]) {
    if (typeof value[key] === "boolean") out[key] = value[key];
  }
  const clamp = (v, fallback, min, max) => Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : fallback;
  out.maxBytes = clamp(value.maxBytes, out.maxBytes, 2 * MiB, 8192 * MiB);
  out.maxMessages = clamp(value.maxMessages, out.maxMessages, 100, 100000);
  for (const key of ['retentionDays', 'imageRetentionDays', 'voiceRetentionDays', 'videoRetentionDays', 'fileRetentionDays']) out[key] = clamp(value[key], out[key], 0, 3650);
  out.maxVideoMiB = clamp(value.maxVideoMiB, out.maxVideoMiB, 1, 64);
  out.blockStory=false; // Suspended while the feature is under development.
  if(['system','light','dark'].includes(value.theme))out.theme=value.theme;
  if(['en','vi'].includes(value.language))out.language=value.language;
  return out;
}
export const validId = value => typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\x00-\x1f]/.test(value);
const bounded = (value, max) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined;
// Sender and reply details are page-supplied. Every layer keeps only these
// bounded fields, and a missing field never erases one saved earlier.
export function messageMeta(item) {
  const sentAt = Number.isSafeInteger(item?.sentAt) && item.sentAt >= 1e12 && item.sentAt <= 4e12 ? item.sentAt : undefined;
  const senderId = typeof item?.senderId === "string" && /^\d{1,40}$/.test(item.senderId) ? item.senderId : undefined;
  return { senderId, sentAt, senderName: bounded(item?.senderName, 120), replyText: bounded(item?.replyText, 500), label: bounded(item?.label, 200) };
}
export function canonicalMessageId(value) {
  // Messenger first renders an optimistic numeric ID, then prefixes the same
  // globally unique sequence after server acknowledgement.
  const sequence = typeof value === "string" && value.match(/^(?:\d+@msgr\.)?(\d{16,})$/)?.[1];
  return sequence ? `msgr.${sequence}` : value;
}
export function accountId() {
  try {
    const cookie = document.cookie.match(/(?:^|;\s*)c_user=(\d+)/)?.[1];
    if (cookie) return cookie;
  } catch {}
  // This fallback runs in MAIN world. Cookies may be unavailable, while Meta
  // has already resolved the viewer in its own module registry.
  try {
    if (typeof window.require === "function") {
      const user = window.require("CurrentUser");
      const id = user?.getID?.();
      if (typeof id === "string" && /^[1-9]\d+$/.test(id)) return id;
    }
  } catch {}
  try {
    const data = typeof window.require === "function" ? window.require("CurrentUserInitialData") : null;
    const id = data?.USER_ID;
    if (typeof id === "string" && /^[1-9]\d+$/.test(id)) return id;
  } catch {}
  return null;
}
