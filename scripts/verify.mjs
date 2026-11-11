import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";

const results=[];
async function run(label, file, env={}) {
  console.log(`\n[VERIFY] ${label}`);
  const started=Date.now();
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[file],{stdio:"inherit",env:{...process.env,...env}});
    child.on("error",reject);child.on("exit",resolve);
  });
  results.push({label,passed:code===0,durationMs:Date.now()-started});
  await mkdir("test-results",{recursive:true});
  await writeFile("test-results/verification.json",JSON.stringify({
    isolatedProfilesOnly:true,primaryFacebookUsed:false,
    facebookProductionTestIncluded:false,results,
  },null,2));
  if(code!==0)throw Error(`${label} failed (${code})`);
}
// Node's test runner must receive --test as an actual argument, not a shell glob.
const unit=spawn(process.execPath,["--test","tests/archive.test.js","tests/background.test.js","tests/protocol.test.js","tests/sender.test.js","tests/media.test.js","tests/i18n.test.js","tests/vault.test.js","tests/backup.test.js","tests/adapter.test.js","tests/review.test.js","tests/review2.test.js","tests/review3.test.js"],{stdio:"inherit"});
const unitCode=await new Promise((resolve,reject)=>{unit.on("exit",resolve);unit.on("error",reject);});
if(unitCode!==0)throw Error("Unit/regression tests failed");
await run("Build extension", "scripts/build.mjs");
const current=path.resolve("test-results/browser-current/chrome-win64/chrome.exe");
for(let round=1;round<=5;round++) {
  const env=round%2===0&&existsSync(current)?{PFF_TEST_BROWSER:current}:{};
  await run(`Browser integration round ${round}/5 (${env.PFF_TEST_BROWSER?"Chromium 156":"Chromium 141"})`,"tests/browser.mjs",env);
}
await run("Sustained writes, eviction and restart", "tests/stress.mjs", existsSync(current)?{PFF_TEST_BROWSER:current}:{});
await run("Bulk replacements, slow commits and delayed tombstones", "tests/bulk.mjs", existsSync(current)?{PFF_TEST_BROWSER:current}:{});
await run("Emoji, photo and voice persistence, playback and cleanup", "tests/media-browser.mjs", existsSync(current)?{PFF_TEST_BROWSER:current}:{});
await run("Storage policy, selective cleanup, gallery and unplayed voice", "tests/storage-browser.mjs", existsSync(current)?{PFF_TEST_BROWSER:current}:{});
await run("Recalled photos in place: album grid, retries, redraws and the zoom/switch viewer", "tests/viewer-browser.mjs", existsSync(current)?{PFF_TEST_BROWSER:current}:{});
await run("Preferences persistence, concurrent views, startup and new UI", "tests/settings-browser.mjs", existsSync(current)?{PFF_TEST_BROWSER:current}:{});
await run("Bilingual UI, persisted language and Pito branding", "tests/i18n-browser.mjs", existsSync(current)?{PFF_TEST_BROWSER:current}:{});
await run("Backups, password lock, sender details, new media kinds and retries", "tests/features-browser.mjs", existsSync(current)?{PFF_TEST_BROWSER:current}:{});
await run("Capture stays complete under scroll and observer limits", "tests/adapter-browser.mjs", existsSync(current)?{PFF_TEST_BROWSER:current}:{});
await run("Actual toolbar popup sizing and autosave", "tests/popup-action.mjs", existsSync(current)?{PFF_TEST_BROWSER:current}:{});
console.log("\n[VERIFY] All automated checks passed. Production Facebook QA remains a separate requirement.");
