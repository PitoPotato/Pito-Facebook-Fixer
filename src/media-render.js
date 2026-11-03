import {decodeBase64,MAX_ASSET_BYTES} from './media.js';
import {tr} from './i18n.js';

const active=new Map(),pending=[];let running=0,activeBytes=0;
const MAX_ACTIVE=32*1024*1024;
const observer=new IntersectionObserver(entries=>{
  for(const {target,isIntersecting} of entries){
    const entry=active.get(target);if(!entry)continue;entry.visible=isIntersecting;
    if(isIntersecting)enqueue(entry);
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
function pump(){
  for(const [node,entry] of active)if(!node.isConnected||!entry.valid()){release(entry);observer.unobserve(node);active.delete(node);}
  while(running<2&&pending.length){
    const entry=pending[0];
    if(!entry.node.isConnected||!entry.valid()||!entry.visible){pending.shift();continue;}
    if(activeBytes+entry.asset.size>MAX_ACTIVE)break;
    pending.shift();entry.loading=true;activeBytes+=entry.asset.size;
    const generation=entry.generation,asset=entry.asset;let committed=false;running++;
    (async()=>{
      const chunks=[];let offset=0;
      while(offset<asset.size){
        if(entry.generation!==generation||!entry.valid())return;
        const chunk=await entry.rpc({type:'asset',...entry.key,index:asset.index,offset});
        if(chunk.digest!==asset.digest||chunk.size!==asset.size||chunk.offset!==offset)throw Error('Bản lưu đã thay đổi.');
        const bytes=decodeBase64(chunk.data);if(!bytes.length||offset+bytes.length>asset.size)throw Error('Dữ liệu bản lưu không đầy đủ.');
        chunks.push(bytes);offset+=bytes.length;
      }
      if(entry.generation!==generation||!entry.valid())return;
      entry.url=URL.createObjectURL(new Blob(chunks,{type:asset.mime}));entry.node.src=entry.url;committed=true;
    })().catch(()=>{if(entry.generation===generation)entry.node.setAttribute('title',tr('mediaUnavailable',entry.language));}).finally(()=>{
      // The reservation becomes the live URL's budget once loading succeeds.
      if(!committed)activeBytes-=asset.size;
      if(entry.generation===generation)entry.loading=false;
      running--;pump();
    });
  }
}
export function archivedMedia(container,key,assets,rpc,valid=()=>container.isConnected,language='en'){
  const entries=[],images=assets.filter(a=>a.kind==='image');let imageAdded=false;
  for(const asset of assets){
    if(!['image','voice'].includes(asset.kind)||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>MAX_ASSET_BYTES)continue;
    if(asset.kind==='image'){if(imageAdded)continue;imageAdded=true;}
    const node=document.createElement(asset.kind==='image'?'img':'audio');
    node.style.cssText=asset.kind==='image'?'display:block;max-width:220px;max-height:260px;width:auto;height:auto;border-radius:inherit;object-fit:contain;margin-top:4px':'display:block;width:240px;max-width:100%;margin-top:4px';
    if(asset.kind==='image'){node.alt=tr('imageAlt',language);node.loading='lazy';}
    else{node.controls=true;node.preload='metadata';node.setAttribute('aria-label',tr('voiceAria',language));}
    const entry={node,key,asset,rpc,language,valid:()=>valid()&&node.isConnected,visible:false,generation:0,url:null,loading:false};
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
    node.addEventListener('click',()=>{entry.visible=true;enqueue(entry);});
    node.addEventListener('ended',()=>{if(!entry.visible)release(entry);});
  }
  return ()=>{for(const entry of entries){release(entry);observer.unobserve(entry.node);active.delete(entry.node);}pump();};
}
export function sweepArchivedMedia(){pump();}
export function localizeArchivedMedia(container,language){
  for(const entry of active.values())if(container.contains(entry.node)){
    entry.language=language;
    if(entry.node instanceof HTMLImageElement)entry.node.alt=tr('imageAlt',language);else entry.node.setAttribute('aria-label',tr('voiceAria',language));
    if(entry.node.hasAttribute('title'))entry.node.title=tr('mediaUnavailable',language);
    entry.updateLanguage?.();
  }
  for(const button of container.querySelectorAll('[data-pff-gallery-action]'))button.setAttribute('aria-label',tr(button.dataset.pffGalleryAction,language));
}
