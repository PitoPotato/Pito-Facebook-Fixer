import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeSettings} from '../src/shared.js';
import {tr,localeFor,localizeError} from '../src/i18n.js';

test('English is the default for new and existing settings; language is restricted to en/vi',()=>{
  for(const language of [undefined,'auto','fr','',null])assert.equal(normalizeSettings({language}).language,'en');
  assert.equal(normalizeSettings({language:'vi'}).language,'vi');
  assert.equal(normalizeSettings({language:'en',theme:'dark',maxBytes:64*1024*1024}).theme,'dark');
});
test('every static and dynamic message has matching English/Vietnamese placeholders',async()=>{
  for(const name of ['static','messages']){
    const catalog=JSON.parse((await readFile(`src/locales/${name}.json`,'utf8')).replace(/^\uFEFF/,''));
    for(const [key,value] of Object.entries(catalog)){
      assert.ok(value.en?.trim(),`${key}: English missing`);assert.ok(value.vi?.trim(),`${key}: Vietnamese missing`);
      const placeholders=s=>[...s.matchAll(/\{(\w+)\}/g)].map(m=>m[1]).sort();assert.deepEqual(placeholders(value.en),placeholders(value.vi),key);
    }
  }
});
test('parameter interpolation and local error translation preserve technical details',()=>{
  assert.equal(tr('recallDetected','en',{date:'Jan 1'}),'Recall detected · Jan 1');
  assert.equal(tr('previousImage','vi'),'Ảnh trước');assert.equal(localeFor('vi'),'vi-VN');assert.equal(localeFor('en'),'en-US');
  assert.equal(localizeError('errBusy','en'),'The archive is busy. Please try again.');assert.equal(localizeError('errBusy','vi'),'Kho đang bận; thử lại sau.');
  assert.match(localizeError('errSource:document_url','en'),/could not be verified.*document_url/);assert.match(localizeError('errSource:document_url','vi'),/Không xác thực.*document_url/);
  assert.equal(localizeError('Some browser error','vi'),'Some browser error');
});
test('every error code raised in the source has a translation in both languages',async()=>{
  const {readdir}=await import('node:fs/promises');
  const catalog=JSON.parse(await readFile('src/locales/messages.json','utf8'));
  for(const file of await readdir('src')){
    if(!file.endsWith('.js'))continue;
    const code=await readFile(`src/${file}`,'utf8');
    assert.equal(/Error\(['"`][^'"`]*[À-ỹ]/u.test(code),false,`${file} raises a hardcoded Vietnamese error`);
    for(const [,key] of code.matchAll(/['"`](err[A-Z]\w+)['"`]/g))assert.ok(catalog[key]?.en&&catalog[key]?.vi,`${file}: ${key} has no translation`);
  }
});
