import { supportedURL } from "./shared.js";

const parse = value => { try { return typeof value === "string" && value ? new URL(value) : null; } catch { return null; } };
const ownOrigin = (url, id) => url?.protocol === "chrome-extension:" && url.hostname === id && !url.username && !url.password;
const originOf = value => {
  const url = parse(value);
  if (!url) return null;
  return `${url.protocol}//${url.host}`;
};

// Chrome authenticates sender.id and these URL/origin fields. Never take an
// origin, tab or extension ID supplied inside the message payload as authority.
export function classifySender(sender, extensionId) {
  if (!sender || sender.id !== extensionId) return { kind: null, reason: "extension_id" };
  const url = parse(sender.url), origin = parse(sender.origin);
  if (ownOrigin(url, extensionId) || (!sender.url && ownOrigin(origin, extensionId))) {
    if (sender.origin && !ownOrigin(origin, extensionId)) return { kind: null, reason: "extension_origin" };
    return { kind: "extension", reason: null };
  }
  if (!Number.isInteger(sender.tab?.id) || sender.tab.id < 0) return { kind: null, reason: "missing_tab" };
  // frameId is optional metadata. A legitimate content script in a supported
  // frame has the same authority regardless of whether this is 0, positive,
  // or absent. Page callers still only get config/observe, never admin APIs.
  if (sender.frameId != null && (!Number.isInteger(sender.frameId) || sender.frameId < 0)) {
    return { kind: null, reason: "invalid_frame" };
  }
  if (sender.url && !supportedURL(sender.url)) return { kind: null, reason: "document_url" };
  if (sender.origin && !supportedURL(sender.origin)) return { kind: null, reason: "document_origin" };
  if (!url && !origin) return { kind: null, reason: "missing_document_origin" };
  if (url && origin && url.origin !== origin.origin) return { kind: null, reason: "origin_mismatch" };
  return { kind: "page", reason: null };
}

export function senderDiagnostics(sender, extensionId, reason) {
  return {
    reason, extensionMatch: sender?.id === extensionId,
    hasTab: Number.isInteger(sender?.tab?.id), frameId: sender?.frameId ?? null,
    documentOrigin: originOf(sender?.url), senderOrigin: originOf(sender?.origin),
    // Deliberately omit paths, query parameters, titles, account and message data.
  };
}
