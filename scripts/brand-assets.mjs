import {chromium} from 'playwright';
import {readFile,mkdir,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';

// Deterministic SVG → PNG export; no personal browser/profile or network.
const svg=await readFile('extension/icons/logo.svg','utf8');
const browser=await chromium.launch({executablePath:path.resolve('test-results/browser-current/chrome-win64/chrome.exe'),headless:true});
try{
 const page=await browser.newPage({viewport:{width:640,height:640},deviceScaleFactor:1});await page.route(/^https?:\/\//,r=>r.abort());
 await page.setContent(`<style>body{margin:0;background:transparent}svg{display:block}</style>${svg}`);
 for(const size of [16,24,32,48,128,256,512]){
  await page.locator('svg').evaluate((node,size)=>{node.style.width=`${size}px`;node.style.height=`${size}px`;},size);
  await page.locator('svg').screenshot({path:`extension/icons/icon-${size}.png`,omitBackground:true});
 }
 const output=path.resolve('release/brand');await mkdir(output,{recursive:true});await writeFile(path.join(output,'pitofacebookfixer-logo.svg'),svg);
 for(const size of [16,24,32,48,128,256,512])await copyFile(`extension/icons/icon-${size}.png`,path.join(output,`pitofacebookfixer-${size}.png`));
 await copyFile('docs/brand-guidelines.md',path.join(output,'brand-guidelines.md'));
 await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;background:#fff;color:#313630;font:16px 'Segoe UI',sans-serif;padding:48px}header{display:flex;align-items:center;gap:24px}svg{width:128px;height:128px;display:block}h1{font-size:28px;letter-spacing:-.7px;margin:0}p{font-size:13px;color:#666;margin:8px 0 0}.sizes{display:flex;align-items:center;gap:25px;margin-top:48px;padding-top:30px;border-top:1px solid #e8e8e8}.sizes svg{width:var(--size);height:var(--size)}.swatches{display:flex;gap:12px;margin-top:40px}.swatches span{width:34px;height:34px;border-radius:50%;background:var(--color);border:1px solid #ddd}</style><header>${svg}<div><h1>PitoFacebookFixer</h1><p>P monogram · conversation · local memory</p></div></header><div class="sizes">${[16,24,32,48,64].map(size=>`<div style="--size:${size}px">${svg}</div>`).join('')}</div><div class="swatches"><span style="--color:#F4F1E8"></span><span style="--color:#F2D477"></span><span style="--color:#313630"></span></div>`);
 await page.setViewportSize({width:720,height:420});await page.screenshot({path:path.join(output,'logo-preview.png')});
 console.log('Exported SVG, 16–512 px PNG icons and a white-background brand preview.');
}finally{await browser.close();}
