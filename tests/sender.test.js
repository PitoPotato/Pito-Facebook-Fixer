import test from "node:test";
import assert from "node:assert/strict";
import { classifySender, senderDiagnostics } from "../src/sender.js";

const id = "abcdefghijklmnopabcdefghijklmnop";
const page = extra => ({ id, url: "https://www.facebook.com/messages/t/20002/", origin: "https://www.facebook.com",
  tab: { id: 7, url: "https://www.facebook.com/" }, frameId: 0, ...extra });

test("supported content scripts are accepted with zero, positive or optional frameId", () => {
  for (const frameId of [0, 1, 24, undefined, null]) assert.equal(classifySender(page({frameId}),id).kind,"page");
});
test("authenticated document origin is usable when optional sender URL is absent", () => {
  assert.equal(classifySender(page({url:undefined}),id).kind,"page");
  assert.equal(classifySender(page({origin:undefined}),id).kind,"page");
  assert.equal(classifySender(page({origin:undefined,url:undefined}),id).kind,null);
});
test("a permitted main tab cannot disguise a foreign or opaque document", () => {
  for (const extra of [
    {url:"https://evil.example/"}, {origin:"https://evil.example"}, {origin:"null"},
    {url:"about:blank"}, {url:"https://www.facebook.com.evil.example/"},
    {url:"http://www.facebook.com/",origin:"http://www.facebook.com"},
    {url:"https://web.facebook.com/",origin:"https://www.facebook.com"},
  ]) assert.equal(classifySender(page(extra),id).kind,null);
});
test("other extensions, missing tabs and invalid frame metadata are rejected", () => {
  for (const extra of [{id:"other"},{tab:undefined},{tab:{id:-1}},{frameId:-1},{frameId:"0"}]) {
    assert.equal(classifySender(page(extra),id).kind,null);
  }
});
test("extension UI origin is authoritative even with unrelated tab metadata", () => {
  assert.equal(classifySender({id,url:`chrome-extension://${id}/popup.html`,origin:`chrome-extension://${id}`,tab:{url:"https://www.facebook.com/"}},id).kind,"extension");
  assert.equal(classifySender({id,origin:`chrome-extension://${id}`},id).kind,"extension");
  assert.equal(classifySender({id,url:`chrome-extension://${id}.evil/options.html`},id).kind,null);
  assert.equal(classifySender({id,url:`chrome-extension://${id}/options.html`,origin:"https://www.facebook.com"},id).kind,null);
});
test("source diagnostics omit account, URL paths, query strings and messages", () => {
  const result = senderDiagnostics(page({url:"https://www.facebook.com/messages/t/private-thread?token=secret"}),id,"example");
  const text = JSON.stringify(result);
  assert.equal(result.documentOrigin,"https://www.facebook.com");
  for (const secret of ["private-thread","token","secret","20002"]) assert.ok(!text.includes(secret));
});
