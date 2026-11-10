import {decodeBase64,MAX_ASSET_BYTES,MAX_VIDEO_BYTES,MEDIA_KINDS} from './media.js';
import {tr} from './i18n.js';

const active=new Map(),pending=[];let running=0,activeBytes=0;
const MAX_ACTIVE=32*1024*1024;
const observer=new IntersectionObserver(entries=>{
  for(const {target,isIntersecting} of entries){
    const entry=active.get(target);if(!entry)continue;entry.visible=isIntersecting;
    // A video can be large, so it loads only after the user asks for it.
    if(isIntersecting){if(!entry.manual||entry.requested)enqueue(entry);}
    else if(target instanceof HTMLImageElement||target.paused)release(entry);
  }
  pump();
},{rootMargin:'100px'});
function release(entry){
  entry.generation++;entry.loading=false;
  if(entry.url){URL.revokeObjectURL(entry.url);entry.node.removeAttribute('src');activeBytes-=entry.asset.size;entry.url=null;}
}
function enqueue(entry){
  if(entry.url||entry.loading||pending.includes(entry)||!entry.valid()||pending.length>=64)return;
  pending.push(entry);pump();
}
async function readChunks(rpc,key,asset,current=()=>true){
  const chunks=[];let offset=0;
  while(offset<asset.size){
    if(!current())return null;
    const chunk=await rpc({type:'asset',...key,index:asset.index,offset});
    if(chunk.digest!==asset.digest||chunk.size!==asset.size||chunk.offset!==offset)throw Error('errMediaGone');
    const bytes=decodeBase64(chunk.data);if(!bytes.length||offset+bytes.length>asset.size)throw Error('errMediaGone');
    chunks.push(bytes);offset+=bytes.length;
  }
  return chunks;
}
function pump(){
  for(const [node,entry] of active)if(!node.isConnected||!entry.valid()){release(entry);observer.unobserve(node);active.delete(node);}
  while(running<2&&pending.length){
    const entry=pending[0];
    if(!entry.node.isConnected||!entry.valid()||!entry.visible){pending.shift();continue;}
    // A file larger than the display budget may still load alone.
    if(activeBytes&&activeBytes+entry.asset.size>MAX_ACTIVE)break;
    pending.shift();entry.loading=true;activeBytes+=entry.asset.size;
    const generation=entry.generation,asset=entry.asset;let committed=false;running++;
    (async()=>{
      const chunks=await readChunks(entry.rpc,entry.key,asset,()=>entry.generation===generation&&entry.valid());
      if(!chunks||entry.generation!==generation||!entry.valid())return;
      entry.url=URL.createObjectURL(new Blob(chunks,{type:asset.mime}));entry.node.src=entry.url;committed=true;
    })().catch(()=>{if(entry.generation===generation)entry.node.setAttribute('title',tr('mediaUnavailable',entry.language));}).finally(()=>{
      // The reservation becomes the live URL's budget once loading succeeds.
      if(!committed)activeBytes-=asset.size;
      if(entry.generation===generation)entry.loading=false;
      running--;pump();
    });
  }
}
const sizeLabel=bytes=>bytes>=1048576?`${(bytes/1048576).toFixed(1)} MiB`:`${Math.max(1,Math.round(bytes/1024))} KiB`;
function fileButton(container,key,asset,rpc,language){
  const button=document.createElement('button');button.type='button';button.setAttribute('data-pff-file','');
  const title=()=>tr('fileDownload',button.dataset.pffLanguage,{name:asset.name||tr('fileDefaultName',button.dataset.pffLanguage)});
  button.dataset.pffLanguage=language;button.textContent=`${asset.name||tr('fileDefaultName',language)} · ${sizeLabel(asset.size)}`;button.title=title();button.setAttribute('aria-label',title());
  button.style.cssText='display:block;font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:6px;cursor:pointer;padding:4px 10px;margin-top:4px;max-width:100%;overflow-wrap:anywhere;text-align:left';
  button.addEventListener('click',async event=>{
    event.preventDefault();event.stopPropagation();if(button.disabled)return;button.disabled=true;
    try{
      const chunks=await readChunks(rpc,key,asset),url=URL.createObjectURL(new Blob(chunks,{type:'application/octet-stream'})),link=document.createElement('a');
      link.href=url;link.download=asset.name||'file';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
    }catch{button.title=tr('mediaUnavailable',button.dataset.pffLanguage);}
    finally{button.disabled=false;}
  });
  container.append(button);
}
function mediaNode(asset,language){
  if(asset.kind==='image'){
    const node=document.createElement('img');node.alt=tr('imageAlt',language);node.loading='lazy';
    node.style.cssText='display:block;max-width:220px;max-height:260px;width:auto;height:auto;border-radius:inherit;object-fit:contain;margin-top:4px';return node;
  }
  if(asset.kind==='video'){
    const node=document.createElement('video');node.setAttribute('aria-label',tr('videoAria',language));
    node.style.cssText='display:block;width:240px;max-width:100%;min-height:120px;background:#000;border-radius:inherit;margin-top:4px';
    if(asset.subtype==='gif'){node.loop=true;node.muted=true;node.autoplay=true;node.playsInline=true;}
    else{node.controls=true;node.preload='none';node.title=tr('videoLoad',language);}
    return node;
  }
  const node=document.createElement('audio');node.controls=true;node.preload='metadata';node.setAttribute('aria-label',tr('voiceAria',language));
  node.style.cssText='display:block;width:240px;max-width:100%;margin-top:4px';return node;
}
export function archivedMedia(container,key,assets,rpc,valid=()=>container.isConnected,language='en'){
  const entries=[],images=assets.filter(a=>a.kind==='image');let imageAdded=false;
  for(const asset of assets){
    if(!MEDIA_KINDS.includes(asset.kind)||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>(asset.kind==='video'?MAX_VIDEO_BYTES:MAX_ASSET_BYTES))continue;
    if(asset.kind==='file'){fileButton(container,key,asset,rpc,language);continue;}
    if(asset.kind==='image'){if(imageAdded)continue;imageAdded=true;}
    const node=mediaNode(asset,language);
    const entry={node,key,asset,rpc,language,valid:()=>valid()&&node.isConnected,visible:false,generation:0,url:null,loading:false,manual:asset.kind==='video'&&asset.subtype!=='gif',requested:false};
    entries.push(entry);active.set(node,entry);container.append(node);observer.observe(node);
    if(asset.kind==='image'&&images.length>1){
      let index=0;const controls=document.createElement('span'),previous=document.createElement('button'),next=document.createElement('button'),label=document.createElement('span');
      controls.setAttribute('data-pff-gallery','');controls.style.cssText='display:flex;align-items:center;justify-content:center;gap:12px;margin:6px 0;font:inherit';
      label.setAttribute('aria-live','polite');
      for(const [button,text,key] of [[previous,'‹','previousImage'],[next,'›','nextImage']]){button.type='button';button.textContent=text;button.dataset.pffGalleryAction=key;button.setAttribute('aria-label',tr(key,language));button.style.cssText='font:inherit;color:inherit;background:transparent;border:1px solid currentColor;border-radius:6px;cursor:pointer;padding:2px 10px;min-width:32px;min-height:28px';}
      const update=()=>{label.textContent=`${index+1} / ${images.length}`;label.setAttribute('aria-label',tr('galleryPosition',entry.language,{index:index+1,count:images.length}));previous.disabled=index===0;next.disabled=index===images.length-1;};entry.updateLanguage=update;
      const move=delta=>event=>{event.preventDefault();event.stopPropagation();const changed=index+delta;if(changed<0||changed>=images.length)return;release(entry);index=changed;entry.asset=images[index];node.removeAttribute('title');update();enqueue(entry);};
      previous.addEventListener('click',move(-1));next.addEventListener('click',move(1));controls.append(previous,label,next);container.append(controls);update();
    }
    node.addEventListener('click',()=>{entry.visible=true;entry.requested=true;enqueue(entry);});
    node.addEventListener('ended',()=>{if(!entry.visible)release(entry);});
  }
  return ()=>{for(const entry of entries){release(entry);observer.unobserve(entry.node);active.delete(entry.node);}pump();};
}
export function sweepArchivedMedia(){pump();}
export function localizeArchivedMedia(container,language){
  for(const entry of active.values())if(container.contains(entry.node)){
    entry.language=language;
    if(entry.node instanceof HTMLImageElement)entry.node.alt=tr('imageAlt',language);
    else entry.node.setAttribute('aria-label',tr(entry.node instanceof HTMLVideoElement?'videoAria':'voiceAria',language));
    if(entry.node.hasAttribute('title'))entry.node.title=tr(entry.manual&&!entry.url?'videoLoad':'mediaUnavailable',language);
    entry.updateLanguage?.();
  }
  for(const button of container.querySelectorAll('[data-pff-gallery-action]'))button.setAttribute('aria-label',tr(button.dataset.pffGalleryAction,language));
  for(const button of container.querySelectorAll('[data-pff-file]'))button.dataset.pffLanguage=language;
}
