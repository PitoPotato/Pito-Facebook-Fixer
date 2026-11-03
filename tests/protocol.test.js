import test from "node:test";
import assert from "node:assert/strict";
import { requestKind } from "../src/protocol.js";
import { normalizeSettings, supportedURL, MiB, canonicalMessageId } from "../src/shared.js";

test("optimistic and acknowledged Messenger IDs have the same canonical identity",()=>{
  const sequence="7523088985468546888";
  assert.equal(canonicalMessageId(sequence),canonicalMessageId("10001@msgr."+sequence));
  assert.equal(canonicalMessageId("mid.unchanged"),"mid.unchanged");
  assert.equal(canonicalMessageId("20002"),"20002");
});

test("story filter recognizes operation field, never message contents or foreign URLs", () => {
  const body = new URLSearchParams({ fb_api_req_friendly_name: "storiesUpdateSeenStateMutation" });
  assert.equal(requestKind("/api/graphql/", "POST", body), "story");
  assert.equal(requestKind("/api/graphql/", "GET", body), null);
  assert.equal(requestKind("https://evil.example/api/graphql/", "POST", body), null);
  assert.equal(requestKind("/api/graphql/", "POST", new URLSearchParams({ variables: "storiesUpdateSeenStateMutation" })), null);
});
test("scope and settings do not expand to other websites or unbounded storage", () => {
  assert.equal(supportedURL("https://www.facebook.com/messages"), true);
  assert.equal(supportedURL("https://www.facebook.com.evil.example/"), false);
  assert.equal(supportedURL("http://www.facebook.com/"), false);
  const config = normalizeSettings({ maxBytes: 1e20, maxMessages: Infinity, retentionDays: -1 });
  assert.equal(config.maxBytes, 8192 * MiB); assert.equal(config.maxMessages, 20000); assert.equal(config.retentionDays, 0);
});

test("removed chat privacy setting is ignored; chat read receipts are never classified for blocking", () => {
  assert.equal('blockSeen' in normalizeSettings({blockSeen:true}),false);
  for (const operation of ['MWMarkThreadReadMutation','MessengerMarkThreadReadMutation']) {
    assert.equal(requestKind('/api/graphql/','POST',new URLSearchParams({fb_api_req_friendly_name:operation})),null);
  }
  for(const endpoint of ['change_read_status','mark_seen']) {
    assert.equal(requestKind(`/ajax/mercury/${endpoint}.php`,'POST',''),null);
  }
});
