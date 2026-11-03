const STORY_MUTATIONS = new Set(["storiesUpdateSeenStateMutation", "StoriesUpdateSeenStateMutation"]);
export function requestKind(url, method, body, origin = "https://www.facebook.com") {
  let parsed;
  try { parsed = new URL(url, origin); } catch { return null; }
  if (parsed.origin !== origin || String(method).toUpperCase() !== "POST") return null;
  if (!/\/api\/graphql\/?$/.test(parsed.pathname)) return null;
  let name;
  if (typeof body === "string") name = new URLSearchParams(body).get("fb_api_req_friendly_name");
  else if (body instanceof URLSearchParams || (typeof FormData !== "undefined" && body instanceof FormData)) name = body.get("fb_api_req_friendly_name");
  if (STORY_MUTATIONS.has(name)) return "story";
  return null;
}
