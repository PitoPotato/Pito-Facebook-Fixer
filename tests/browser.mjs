import assert from "node:assert/strict";
import { chromium } from "playwright";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const output = path.resolve("test-results"), profileRoot = path.join(output, "profiles");
const profile = path.join(profileRoot, crypto.randomUUID());
await mkdir(profile, { recursive: true });
const extension = path.resolve("dist");
const localBrowser = path.join(output,"browser","chrome-win","chrome.exe");
const executable = process.env.PFF_TEST_BROWSER || (existsSync(localBrowser) ? localBrowser : null);
const context = await chromium.launchPersistentContext(profile, { channel: "chromium", headless: true,
  ...(executable ? { executablePath: path.resolve(executable) } : {}),
  ignoreDefaultArgs: ["--disable-extensions"],
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 1280, height: 900 } });
context.setDefaultTimeout(10000);
console.log("Browser launched; waiting for extension worker…");
let failures = [];
context.on("weberror", event => failures.push(event.error().message));
const fixture = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Controlled Messenger fixture</title><style>
body{font:16px system-ui;margin:30px;background:#f4f7fb} [role=grid]{max-width:650px} [role=row]{background:white;border-radius:12px;padding:18px;margin-bottom:12px}
[contenteditable]{background:white;border:1px solid #aaa;min-height:44px;padding:8px;max-width:450px;margin:18px 0} button{padding:12px}
</style></head><body><h1>Controlled Messenger fixture</h1><div role="grid" data-thread-id="20002">
<div role="row" data-message-id="mid.persist"><span data-message-text>Xin chào, đây là bản lưu trước khi thu hồi.</span></div>
<div role="row" id="react-row"><span dir="auto">Tin từ mô hình React</span></div>
<div role="row" id="ambiguous"><span dir="auto">Không có ID; không được ghi.</span></div>
</div><div id="editor1" role="textbox" contenteditable="true" data-lexical-editor="true" aria-label="Tin nhắn A"></div>
<div id="editor2" role="textbox" contenteditable="true" data-lexical-editor="true" aria-label="Tin nhắn B"></div>
<button id="navigate">Điều hướng chủ động</button><script src="/fixture.js"></script></body></html>`;
const fixtureScript = `window.fixtureVisibilityCalls=0;document.addEventListener('visibilitychange',()=>window.fixtureVisibilityCalls++);
document.getElementById('react-row').__reactFiber$fixture={memoizedProps:{message:{messageId:'mid.react',threadKey:'20002',text:'Tin từ mô hình React'}},return:null};
document.getElementById('navigate').onclick=()=>history.pushState({},'', '/watch/');
window.fixtureLoaded=crypto.randomUUID();`;
// DOM structure observed on the actual Facebook popup: role=log, no grid or
// exposed thread attribute, sender heading and nested dir=auto text leaves.
const popupFixture = `<!doctype html><html lang="vi"><head><meta charset="utf-8"></head><body>
<div role="log" aria-label="Tin nhắn trong cuộc trò chuyện với Người thử">
 <div role="article"><div data-message-id="20002@msgr.987654321" data-scope="messages_table" aria-roledescription="tin nhắn" aria-label="At 00:42, You: Nội dung mới">
  <h2 dir="auto">Người thử</h2><div role="presentation"><span dir="auto"><div dir="auto">Nội dung mới</div></span></div>
  <div><span role="presentation"><span dir="auto">Sent</span></span></div>
 </div><button>Nhập, Tin nhắn do Người thử gửi lúc 00:42: Nội dung mới</button></div>
 <div role="article"><div data-message-id="mid.popup-group" data-scope="messages_table"><h2 dir="auto">Người thử</h2><span dir="auto"><div dir="auto">Tin nhóm không có thread ID</div></span></div></div>
 <div role="article"><div data-message-id="20002@msgrCUTOVER.20002@msgrCUTOVER" data-scope="messages_table"><span dir="auto">Thông báo mã hóa đầu cuối</span></div></div>
</div><script>window.require=(name)=>{if(name==='CurrentUser')return {getID:()=> '10001'};throw Error('not loaded');};</script>
</body></html>`;
let aliasRemoved=false;
const aliasFixture=()=>`<!doctype html><html><meta charset="utf-8"><body><div role="log"><div role="article"><div data-message-id="${aliasRemoved?'10001@msgr.7523087543034710280':'7523084539208512060'}" aria-label="At 01:12, You${aliasRemoved?'':': Alias payload from real E2EE regression'}"><h4 dir="auto">You sent</h4><div role="presentation"><span dir="auto"><div dir="auto">${aliasRemoved?'You deleted a message':'Alias payload from real E2EE regression'}</div></span></div><div><span role="presentation"><span dir="auto">Sent</span></span></div></div></div></div></body></html>`;
await context.route(/^https?:\/\//, async route => {
  const url = new URL(route.request().url());
  if (url.hostname !== "www.facebook.com") return route.abort();
  if (url.pathname === "/alias-fixture") return route.fulfill({contentType:"text/html",body:aliasFixture()});
  if (url.pathname === "/popup-fixture") return route.fulfill({ contentType: "text/html", body: popupFixture });
  if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "text/javascript", body: fixtureScript });
  if (route.request().resourceType() === "document") return route.fulfill({ contentType: "text/html", body: fixture });
  return route.fulfill({ contentType: "application/json", body: '{"fixture":true}' });
});
await context.addCookies([{ name: "c_user", value: "10001", domain: ".facebook.com", path: "/", secure: true, sameSite: "Lax" }]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(100); }
  throw Error(`Timed out: ${message}`);
}
try {
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).hostname;
  const ui = await context.newPage();
  ui.on("pageerror",error=>console.log("UI ERROR",error.message));
  await ui.goto(`chrome-extension://${id}/options.html`);
  await ui.waitForFunction(() => document.querySelector('#messageCount').textContent !== '—');
  const rpc = message => ui.evaluate(async message => {
    const result = await chrome.runtime.sendMessage(message); if (!result.ok) throw Error(result.error); return result;
  }, message);
  const initial = await rpc({ type: "status" }); assert.equal(initial.settings.maxBytes, 33554432);
  assert.equal('blockSeen' in initial.settings,false);
  assert.equal(await ui.locator('[name="blockSeen"]').count(),0);
  // Simulate settings left over from an older installation.
  await ui.evaluate(async()=>{const {settings}=await chrome.storage.local.get('settings');await chrome.storage.local.set({settings:{...settings,blockSeen:true,language:'vi'}});});
  console.log("PASS extension installs; worker and options can access IndexedDB");

  const page = await context.newPage(); await page.goto("https://www.facebook.com/messages/t/20002/");
  await until(async () => (await rpc({ type: "status" })).stats.count === 2, "capture stable DOM and React IDs");
  console.log("PASS content/main bridge captures stable DOM and React IDs and skips unknown rows");

  await page.locator('#editor1').click(); await page.keyboard.insertText("Đang gõ tiếng Việt");
  await page.evaluate(() => document.getElementById('editor2').focus());
  assert.equal(await page.evaluate(() => document.activeElement.id), "editor1");
  await page.evaluate(() => { document.getElementById('editor1').dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'ệ' })); document.getElementById('editor2').focus(); });
  assert.equal(await page.evaluate(() => document.activeElement.id), "editor1");
  await page.evaluate(() => document.getElementById('editor1').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'ệ' })));
  await page.locator('#editor2').click(); assert.equal(await page.evaluate(() => document.activeElement.id), "editor2");
  await page.keyboard.press("Shift+Tab"); assert.equal(await page.evaluate(() => document.activeElement.id), "editor1");
  console.log("PASS programmatic popup focus is blocked; explicit click, Tab and composition are preserved");

  await page.evaluate(() => { const row=document.querySelector('[data-message-id="mid.persist"]'); row.replaceChildren(document.createTextNode('Một người đã thu hồi một tin nhắn.')); });
  await page.waitForSelector('[data-message-id="mid.persist"]:is([data-pff-restored],:has([data-pff-restored]))');
  const cdp = await context.newCDPSession(page);
  const ax = await cdp.send("Accessibility.getFullAXTree");
  assert.ok(ax.nodes.some(node => node.name?.value.includes("Xin chào, đây là bản lưu trước khi thu hồi.")));
  assert.match(await page.locator("[data-pff-restored]").getAttribute("title"), /Đã thu hồi.*Bản lưu từ PitoFacebookFixer/);
  assert.equal(await page.locator("[data-pff-host],section,details").count(),0);
  const removed = await rpc({ type: "list" }); assert.equal(removed.rows[0].text, "Xin chào, đây là bản lưu trước khi thu hồi.");
  console.log("PASS tombstone restores the correct saved text inside the native bubble, with provenance in its tooltip");
  await page.reload();
  await page.evaluate(() => { const row=document.querySelector('[data-message-id="mid.persist"]'); row.setAttribute('data-is-unsent','true'); row.textContent='Someone unsent a message'; });
  await page.waitForSelector('[data-message-id="mid.persist"]:is([data-pff-restored],:has([data-pff-restored]))');
  console.log("PASS archive survives page reload and restores again");

  const story = await page.evaluate(async () => {
    try { await fetch('/api/graphql/', { method: 'POST', body: new URLSearchParams({fb_api_req_friendly_name:'storiesUpdateSeenStateMutation'}) }); return 'leaked'; }
    catch(error) { return error.name; }
  });
  assert.equal(story, "leaked"); // Story protection is suspended, including old enabled settings.
  assert.equal(await page.evaluate(()=>/\[native code\]/.test(fetch.toString())&&/\[native code\]/.test(XMLHttpRequest.prototype.send.toString())),true);
  const ordinary = await page.evaluate(async () => (await fetch('/api/graphql/', { method:'POST', body:new URLSearchParams({fb_api_req_friendly_name:'SendMessageMutation',variables:'storiesUpdateSeenStateMutation'}) })).json());
  assert.equal(ordinary.fixture, true);
  const xhr = await page.evaluate(() => new Promise(resolve => {
    const req = new XMLHttpRequest(); req.open('POST','/api/graphql/'); req.onabort=()=>resolve('aborted'); req.onload=()=>resolve('leaked');
    req.send(new URLSearchParams({fb_api_req_friendly_name:'storiesUpdateSeenStateMutation'}));
  })); assert.equal(xhr,"leaked");
  assert.equal(await page.evaluate(async () => {
    try { await fetch(new Request(location.origin+'/api/graphql/', {method:'POST',body:new URLSearchParams({fb_api_req_friendly_name:'storiesUpdateSeenStateMutation'})})); return 'leaked'; }
    catch(error) { return error.name; }
  }), 'leaked');
  console.log("PASS story fetch/XHR passes through while story protection is marked under development");
  const chatReads=await page.evaluate(async()=>{
    const results=[];
    for(const name of ['MWMarkThreadReadMutation','MessengerMarkThreadReadMutation']) {
      results.push((await fetch('/api/graphql/',{method:'POST',body:new URLSearchParams({fb_api_req_friendly_name:name})})).status);
    }
    for(const name of ['change_read_status','mark_seen'])results.push((await fetch(`/ajax/mercury/${name}.php`,{method:'POST'})).status);
    results.push(await new Promise(resolve=>{
      const xhr=new XMLHttpRequest();xhr.open('POST','/api/graphql/');xhr.onload=()=>resolve(xhr.status);xhr.onabort=()=>resolve('blocked');
      xhr.send(new URLSearchParams({fb_api_req_friendly_name:'MWMarkThreadReadMutation'}));
    }));
    return {results,nativeWebSocket:/\[native code\]/.test(WebSocket.prototype.send.toString())};
  });
  assert.deepEqual(chatReads,{results:[200,200,200,200,200],nativeWebSocket:true});
  console.log('PASS chat read receipts pass through fetch/XHR; WebSocket.send remains native despite legacy blockSeen=true');

  await page.goto("https://www.facebook.com/");
  await until(async()=>ui.evaluate(async()=>{
    const [tab]=await chrome.tabs.query({url:'https://www.facebook.com/'});if(!tab)return false;
    const status=await chrome.tabs.sendMessage(tab.id,{type:'tabStatus'});return status.configured&&status.appliedSettingsRevision===status.settingsRevision&&status.settings.antiReload;
  }),'feed has hydrated persisted preferences before guard assertions');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(await page.evaluate(() => window.fixtureVisibilityCalls), 0);
  const marker = await page.evaluate(() => window.fixtureLoaded);
  const reloadResult = await page.evaluate(async () => {
    try { const result=navigation.reload(); result.committed.catch(()=>{}); await result.finished; return "reloaded"; } catch(error) { return error.name; }
  });
  assert.equal(reloadResult,"AbortError"); assert.equal(await page.evaluate(() => window.fixtureLoaded), marker);
  await page.locator('#navigate').click(); assert.ok(page.url().endsWith("/watch/"));
  console.log("PASS Facebook-style lifecycle reload blocked; user navigation still works");

  const config = (await rpc({ type: "status" })).settings;
  const updated=await rpc({ type: "save", settings: { ...config, antiReload:false, blockStory:false, focusGuard:false } });
  await until(async()=>ui.evaluate(async revision=>{
    const tabs=await chrome.tabs.query({url:'https://www.facebook.com/*'});
    const statuses=await Promise.all(tabs.map(tab=>chrome.tabs.sendMessage(tab.id,{type:'tabStatus'})));
    return statuses.every(s=>s.appliedSettingsRevision===revision);
  },updated.settingsRevision),'all open tabs applied the saved preference revision');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(await page.evaluate(() => window.fixtureVisibilityCalls), 1);
  await page.locator('#editor1').click(); await page.keyboard.insertText("A");
  await page.evaluate(() => document.getElementById('editor2').focus()); assert.equal(await page.evaluate(() => document.activeElement.id), "editor2");
  assert.equal(await page.evaluate(async () => (await fetch('/api/graphql/',{method:'POST',body:new URLSearchParams({fb_api_req_friendly_name:'storiesUpdateSeenStateMutation'})})).status),200);
  console.log("PASS toggles apply to open tabs and restore normal behavior");

  await page.evaluate(() => {
    const row=document.createElement('div');row.setAttribute('role','row');row.setAttribute('data-message-id','mid.literal');
    const text=document.createElement('span');text.setAttribute('data-message-text','');text.textContent='You unsent a message';row.append(text);document.querySelector('[role=grid]').append(row);
  });
  await until(async () => (await rpc({type:'status'})).stats.count===3, 'literal tombstone wording remains normal content');
  await page.evaluate(() => {
    const row=document.querySelector('[data-message-id="mid.literal"]');row.setAttribute('data-is-unsent','true');row.textContent='Someone unsent a message';
  });
  await page.waitForSelector('[data-message-id="mid.literal"]:is([data-pff-restored],:has([data-pff-restored]))');
  console.log('PASS literal tombstone wording is saved as ordinary message text');

  await page.evaluate(() => {
    const row=document.createElement('div');row.setAttribute('role','row');row.setAttribute('data-message-id','mid.xss');
    const text=document.createElement('span');text.setAttribute('data-message-text','');text.textContent='<img src=x onerror="window.pffXss=true">';row.append(text);document.querySelector('[role=grid]').append(row);
  });
  await until(async () => (await rpc({type:'status'})).stats.count===4, 'capture HTML-looking message');
  await page.evaluate(() => {
    const row=document.querySelector('[data-message-id="mid.xss"]');row.setAttribute('data-is-unsent','true');row.textContent='Someone unsent a message';
  });
  await page.waitForSelector('[data-message-id="mid.xss"]:is([data-pff-restored],:has([data-pff-restored]))');
  assert.equal(await page.evaluate(()=>window.pffXss),undefined);
  const xssAX=await cdp.send('Accessibility.getFullAXTree');
  assert.ok(xssAX.nodes.some(node=>node.name?.value.includes('<img src=x onerror=')));
  console.log('PASS saved HTML-looking text is displayed as text and never executed');

  await context.clearCookies();
  const nativePopup=await context.newPage(); await nativePopup.goto('https://www.facebook.com/popup-fixture');
  await until(async () => (await rpc({type:'status'})).stats.count===6, 'realistic popup DOM and native viewer identity');
  await until(async () => await ui.locator('#messageCount').textContent()==='6', 'live storage count refresh');
  await nativePopup.evaluate(()=>{
    const row=document.querySelector('[data-message-id="20002@msgr.987654321"]');
    row.innerHTML='<h2 dir="auto">Người thử</h2><div class="native-bubble" style="border:1px solid #555;border-radius:18px;padding:8px 12px;max-width:190px;background:#242526;color:#b0b3b8;font:italic 14px/20px Segoe UI"><span dir="auto">Người thử đã <em>xóa một tin nhắn</em></span></div><button>Thao tác tin nhắn</button>';
    const bubble=row.querySelector('.native-bubble'), text=bubble.querySelector('[dir="auto"]');
    window.nativeOriginal={row,bubble,text,children:[...row.querySelectorAll('*')],textNode:text.firstChild,style:bubble.getAttribute('style')};
  });
  await nativePopup.waitForSelector('[data-message-id="20002@msgr.987654321"]:is([data-pff-restored],:has([data-pff-restored]))');
  assert.deepEqual(await nativePopup.evaluate(()=>{
    const {row,bubble,text,children,textNode,style}=window.nativeOriginal;
    return {sameElements:children.every((node,i)=>row.querySelectorAll('*')[i]===node)&&row.querySelectorAll('*').length===children.length,
      sameTextNode:text.firstChild===textNode, styleUnchanged:bubble.getAttribute('style')===style,
      text:text.textContent, noCard:!row.querySelector('[data-pff-host],section,details'), button:row.querySelector('button').textContent};
  }),{sameElements:true,sameTextNode:true,styleUnchanged:true,text:'Nội dung mới',noCard:true,button:'Thao tác tin nhắn'});
  await sleep(500);
  assert.equal((await rpc({type:'status'})).stats.count,6);
  assert.ok((await rpc({type:'list'})).rows.some(row=>row.text==='Nội dung mới'));
  assert.ok(!(await rpc({type:'list'})).rows.some(row=>row.text.includes('Người thử')));
  console.log('PASS native bubble elements, text nodes, styling and controls preserved; no extra card or archive write');
  await nativePopup.close();
  await context.addCookies([{ name: 'c_user', value: '10001', domain: '.facebook.com', path: '/', secure: true, sameSite: 'Lax' }]);

  const beforeAlias=(await rpc({type:'status'})).stats.count;
  const aliasPage=await context.newPage();await aliasPage.goto('https://www.facebook.com/alias-fixture');
  await until(async()=>(await rpc({type:'status'})).stats.count===beforeAlias+1,'optimistic numeric message capture');
  await aliasPage.evaluate(()=>document.querySelector('[data-message-id]').setAttribute('data-message-id','10001@msgr.7523084539208512060'));
  await sleep(500);assert.equal((await rpc({type:'status'})).stats.count,beforeAlias+1);
  await aliasPage.evaluate(()=>{const old=document.querySelector('[role="article"]');const replacement=document.createElement('div');replacement.setAttribute('role','article');replacement.innerHTML='<div data-message-id="10001@msgr.7523087543034710280" aria-label="At 01:12, You"><h4 dir="auto">You sent</h4><span dir="auto">You deleted a message</span><span role="presentation"><span dir="auto">Sent</span></span></div>';old.replaceWith(replacement);});
  await aliasPage.waitForSelector('[data-pff-restored]');
  assert.ok((await rpc({type:'list'})).rows.some(r=>r.text==='Alias payload from real E2EE regression'));
  aliasRemoved=true;await aliasPage.reload();await aliasPage.waitForSelector('[data-pff-restored]');
  await aliasPage.evaluate(()=>{const row=document.querySelector('[data-message-id]');row.querySelector('[data-pff-restored]').textContent='You deleted a message';const status=document.createElement('span');status.dir='auto';status.textContent='Sent';row.append(status);});
  await aliasPage.waitForSelector('[data-pff-restored]');
  await until(async()=>await aliasPage.locator('[data-pff-restored]').textContent()==='Alias payload from real E2EE regression','native text rewrite repaired');
  await aliasPage.evaluate(()=>{const row=document.querySelector('[data-message-id]');row.innerHTML='<h4 dir="auto">You sent</h4><span dir="auto">You deleted a message</span><span dir="auto">Sent</span>';});
  await until(async()=>await aliasPage.locator('[data-pff-restored]').textContent()==='Alias payload from real E2EE regression','native child remount repaired');
  console.log('PASS native text replacement is reinstated after Facebook rewrites its text');
  console.log('PASS optimistic ID deduplication, changed E2EE tombstone ID and persistent alias after reload');
  await aliasPage.close();
  aliasRemoved=false;
  const recycledPage=await context.newPage();await recycledPage.goto('https://www.facebook.com/alias-fixture');
  await recycledPage.waitForSelector('[data-pff-row]');
  await recycledPage.evaluate(()=>{const row=document.querySelector('[data-message-id]');row.setAttribute('data-message-id','10001@msgr.9999999999999999999');row.setAttribute('aria-label','At 03:40, Another sender');row.innerHTML='<span dir="auto">Another sender deleted a message</span>';});
  await sleep(600);assert.equal(await recycledPage.locator('[data-pff-restored]').count(),0);
  await recycledPage.close();
  console.log('PASS recycled row with different identity metadata never receives another message\'s saved text');

  await rpc({ type: "save", settings: { ...config, archive: false } });
  await until(async()=>await page.locator('[data-pff-restored]').count()===0,'native restoration removed when disabled');
  assert.equal(await page.locator('[data-message-id="mid.xss"]').textContent(),'Someone unsent a message');
  await page.evaluate(() => { const row=document.querySelector('[data-message-id="mid.persist"]'); row.setAttribute('data-is-unsent','true'); row.textContent='Someone unsent a message'; });
  await sleep(500); assert.equal(await page.locator('[data-pff-restored]').count(),0);
  await rpc({ type: "save", settings: { ...config, archive: true } });
  await page.waitForSelector('[data-pff-restored]');
  await rpc({ type: "clear" });
  await until(async()=>await page.locator('[data-pff-restored]').count()===0,'clear restores native tombstone');
  assert.equal(await page.locator('[data-message-id="mid.persist"]').textContent(),'Someone unsent a message');
  await rpc({ type: "save", settings: { ...config, archive: false } });
  await rpc({ type: "clear" }); assert.equal((await rpc({ type: "status" })).stats.count,0);
  await ui.reload(); await ui.waitForFunction(() => document.querySelector('#messageCount').textContent === '0');
  assert.equal(await ui.locator('[name=archive]').isChecked(),false);
  console.log("PASS disable, clear, settings persistence and private archive controls");

  await ui.screenshot({ path:path.join(output,"options.png"), fullPage:true });
  const popup=await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.setViewportSize({width:400,height:900}); await popup.screenshot({path:path.join(output,"popup.png"),fullPage:true});
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  await ui.setViewportSize({width:375,height:900}); assert.equal(await ui.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
  await ui.emulateMedia({reducedMotion:"reduce"});
  await ui.screenshot({path:path.join(output,"options-mobile.png"),fullPage:true});
  assert.deepEqual(failures,[]);
  console.log("PASS desktop/popup/mobile layout; no uncaught browser errors");
} finally {
  await context.close();
  if (path.resolve(profile).startsWith(path.resolve(profileRoot) + path.sep)) await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});
}
