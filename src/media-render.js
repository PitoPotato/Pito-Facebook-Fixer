import {decodeBase64,MAX_ASSET_BYTES,MAX_VIDEO_BYTES,MEDIA_KINDS} from './media.js';
import {tr} from './i18n.js';
import {createElement as lucide,ZoomIn,ZoomOut,Download,X,ChevronLeft,ChevronRight,Maximize2,ImageOff} from 'lucide';

// ---------------------------------------------------------------------------
// Loading
//
// A stored file is read from the worker in 192 KiB pieces. One record per file
// is shared by every element that shows it: a bubble Facebook redraws, a tile
// scrolled back into view and the photo viewer all reuse the same load or the
// same object URL instead of starting again from the first piece.
// ---------------------------------------------------------------------------
const SPARE_BYTES=24*1024*1024,LIVE_BYTES=64*1024*1024,IDLE_GRACE_MS=3000,ERROR_RETRY_MS=4000,RETRY_DELAYS=[300,1000,3000];
const PERMANENT=new Set(['errMediaGone','errInvalidMedia','errInvalidMediaData','errLocked','errExtensionOnly','errUnsupported']);
const records=new Map(),waiting=[],slots=new Set(),controllers=new Set();
let running=0,inflightBytes=0,epoch=0,trimTimer=null,viewer=null;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const now=()=>performance.now();
// A busy worker or a message lost while the worker restarts is temporary. A
// file that is gone, a locked archive or a dead extension context is not.
const transient=error=>{const message=String(error?.message||'');return !PERMANENT.has(message)&&!/^errSource|context invalidated/i.test(message);};

export async function readChunks(rpc,key,asset,current=()=>true){
  const chunks=[];let offset=0;
  while(offset<asset.size){
    if(!current())return null;
    let chunk;
    for(let attempt=0;;attempt++){
      try{chunk=await rpc({type:'asset',...key,index:asset.index,offset});break;}
      catch(error){
        if(!transient(error)||attempt>=RETRY_DELAYS.length)throw error;
        await sleep(RETRY_DELAYS[attempt]);if(!current())return null;
      }
    }
    if(chunk.digest!==asset.digest||chunk.size!==asset.size||chunk.offset!==offset)throw Error('errMediaGone');
    const bytes=decodeBase64(chunk.data);if(!bytes.length||offset+bytes.length>asset.size)throw Error('errMediaGone');
    chunks.push(bytes);offset+=bytes.length;
  }
  return chunks;
}
function recordFor(key,asset,rpc){
  const id=JSON.stringify([key.account,key.thread,key.id,asset.index,asset.digest,asset.size]);
  let record=records.get(id);
  if(!record){record={id,key,asset,rpc,url:null,state:'idle',refs:0,idleAt:0,usedAt:now(),failedAt:0,listeners:new Set()};records.set(id,record);}
  return record;
}
// Kept loading for a moment after its last element went away, so a redrawn
// bubble picks the load up where it was.
const wanted=record=>record.refs>0||now()-record.idleAt<IDLE_GRACE_MS;
function notify(record){for(const listener of [...record.listeners])listener();}
function load(record,urgent=false){
  if(record.state==='ready'||record.state==='loading')return;
  if(record.state==='queued'){if(!urgent)return;waiting.splice(waiting.indexOf(record),1);}
  record.state='queued';if(urgent)waiting.unshift(record);else waiting.push(record);
  notify(record);pump();
}
function liveBytes(){let total=0;for(const record of records.values())if(record.url&&record.refs>0)total+=record.asset.size;return total;}
function pump(){
  while(running<2&&waiting.length){
    const record=waiting[0];
    if(!wanted(record)||records.get(record.id)!==record){waiting.shift();record.state='idle';notify(record);continue;}
    // A file larger than the display budget may still load alone.
    const busy=liveBytes()+inflightBytes;if(busy&&busy+record.asset.size>LIVE_BYTES)break;
    waiting.shift();run(record);
  }
}
async function run(record){
  const started=epoch,size=record.asset.size;running++;inflightBytes+=size;record.state='loading';notify(record);
  try{
    const chunks=await readChunks(record.rpc,record.key,record.asset,()=>epoch===started&&wanted(record));
    if(epoch!==started)return;
    if(!chunks){record.state='idle';return;}
    record.url=URL.createObjectURL(new Blob(chunks,{type:record.asset.mime}));record.state='ready';record.usedAt=now();
  }catch{if(epoch===started){record.state='error';record.failedAt=now();}}
  finally{running--;inflightBytes-=size;if(epoch===started)notify(record);scheduleTrim();pump();}
}
function hold(record){record.refs++;record.usedAt=now();}
// What it no longer shows frees display budget for a file that is waiting.
function release(record){if(record.refs>0&&--record.refs===0){record.idleAt=record.usedAt=now();scheduleTrim();pump();}}
function scheduleTrim(){if(!trimTimer)trimTimer=setTimeout(trim,IDLE_GRACE_MS+100);}
// Object URLs no element shows stay for a quick return, within a byte budget,
// most recently used first.
function trim(){
  trimTimer=null;let spare=0;
  for(const record of [...records.values()].filter(r=>!r.refs).sort((a,b)=>b.usedAt-a.usedAt)){
    if(record.url){
      spare+=record.asset.size;if(spare<=SPARE_BYTES)continue;
      URL.revokeObjectURL(record.url);record.url=null;record.state='idle';notify(record);
    }
    if(!record.listeners.size&&record.state!=='loading'&&record.state!=='queued')records.delete(record.id);
  }
  pump();
}
// One element showing one stored file.
class Slot{
  constructor(record,node,{valid=()=>true,onState=()=>{},manual=false,urgent=false}={}){
    Object.assign(this,{record,node,valid,onState,manual,urgent,held:false,requested:false});
    this.update=()=>this.paint();record.listeners.add(this.update);slots.add(this);
  }
  want(){
    if(!this.held){this.held=true;hold(this.record);}
    const record=this.record;
    if(record.state==='idle'||record.state==='error'&&now()-record.failedAt>ERROR_RETRY_MS)load(record,this.urgent);
    else if(this.urgent&&record.state==='queued')load(record,true);
    this.paint();
  }
  unwant(){if(this.held){this.held=false;release(this.record);}this.paint();}
  retry(){if(this.record.state==='error')this.record.state='idle';this.want();}
  get state(){const r=this.record;return this.held&&r.url?'ready':r.state==='error'?'error':this.held||r.state==='loading'?'loading':'idle';}
  paint(){
    const url=this.held?this.record.url:null,node=this.node;
    if(url){if(node.getAttribute('src')!==url)node.src=url;}
    else if(node.hasAttribute('src')&&!(node instanceof HTMLMediaElement&&!node.paused))node.removeAttribute('src');
    this.onState(this.state);
  }
  dispose(){
    if(this.disposed)return;this.disposed=true;
    observer.unobserve(this.target||this.node);this.unwant();this.record.listeners.delete(this.update);slots.delete(this);scheduleTrim();
  }
}
const observed=new WeakMap();
const observer=new IntersectionObserver(entries=>{
  for(const {target,isIntersecting} of entries){
    const slot=observed.get(target);if(!slot||slot.disposed)continue;
    slot.visible=isIntersecting;
    // A video can be large, so it loads only after the user asks for it.
    if(isIntersecting){if(!slot.manual||slot.requested)slot.want();}
    else if(!(slot.node instanceof HTMLMediaElement)||slot.node.paused)slot.unwant();
  }
},{rootMargin:'200px'});
function watch(slot,target=slot.node){slot.target=target;observed.set(target,slot);observer.observe(target);}

// ---------------------------------------------------------------------------
// Shared look. Everything is drawn in a shadow root so Facebook's styles and
// observers never touch it, and it never counts as part of a message.
// ---------------------------------------------------------------------------
const BUBBLE_CSS=`
:host{display:block;max-width:100%;margin-top:4px;font-style:normal;white-space:normal;text-align:start;line-height:1.3}
*{box-sizing:border-box}
button{font:inherit;color:inherit}
/* A fixed intrinsic width: Facebook's bubbles shrink to fit their content. */
.album{display:grid;grid-template-columns:repeat(var(--columns),minmax(0,1fr));gap:2px;width:var(--width);max-width:100%;border-radius:12px;overflow:hidden}
.album.single{display:block;width:auto;max-width:min(260px,100%)}
.tile{position:relative;display:block;width:100%;aspect-ratio:1;margin:0;padding:0;border:0;border-radius:0;background:rgba(128,128,128,.16);cursor:zoom-in;overflow:hidden;-webkit-tap-highlight-color:transparent}
.single .tile{width:200px;max-width:100%;aspect-ratio:4/3;border-radius:12px}
.single .tile.sized{aspect-ratio:auto}
.sticker .tile{width:120px;aspect-ratio:1;background:transparent;border-radius:8px}
.tile img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .18s ease;user-select:none;-webkit-user-drag:none}
.single .tile img,.sticker .tile img{object-fit:contain}
.tile[data-state=ready] img{opacity:1}
.veil{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:6px;font-size:12px;text-align:center;pointer-events:none}
.tile[data-state=loading] .veil{background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.22) 50%,transparent 70%) 0 0/250% 100%;animation:shimmer 1.2s linear infinite}
.tile[data-state=error]{cursor:pointer}
.tile[data-state=error] .veil{background:rgba(128,128,128,.22)}
.veil svg{width:20px;height:20px}
.veil .label{display:none;max-width:100%;overflow-wrap:anywhere}
.tile[data-state=error] .veil .label{display:block}
.tile:not([data-state=error]) .veil svg{display:none}
.more{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.62);color:#fff;font-size:24px;font-weight:700;letter-spacing:.02em}
.badge{position:absolute;top:6px;right:6px;display:flex;width:26px;height:26px;align-items:center;justify-content:center;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;opacity:0;transition:opacity .15s ease;pointer-events:none}
.badge svg{width:14px;height:14px}
.tile[data-state=ready]:hover .badge,.tile[data-state=ready]:focus-visible .badge{opacity:1}
.tile:hover::after{content:"";position:absolute;inset:0;background:rgba(255,255,255,.08);pointer-events:none}
.tile:focus-visible{outline:2px solid #7c6cf0;outline-offset:-2px}
.single .tile:focus-visible,.sticker .tile:focus-visible{outline-offset:2px}
video,audio{display:block;max-width:100%;margin-top:4px}
video{width:240px;min-height:120px;background:#000;border-radius:12px}
audio{width:240px}
.album+video,.album+audio,.album+button{margin-top:6px}
.file{display:block;max-width:100%;margin-top:4px;padding:6px 10px;border:1px solid currentColor;border-radius:8px;background:transparent;cursor:pointer;text-align:left;overflow-wrap:anywhere}
.file:disabled{opacity:.6;cursor:progress}
@keyframes shimmer{to{background-position:-150% 0}}
@media (prefers-reduced-motion:reduce){.tile img,.badge{transition:none}.tile[data-state=loading] .veil{animation:none}}
`;
const VIEWER_CSS=`
:host{all:initial}
*{box-sizing:border-box}
dialog{position:fixed;inset:0;width:100vw;height:100vh;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:rgba(10,10,12,.94);color:#f4f4f6;font:14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow:hidden;outline:none}
dialog[open]{display:grid;grid-template-rows:auto minmax(0,1fr) auto}
dialog::backdrop{background:transparent}
button{font:inherit;color:inherit;margin:0;-webkit-tap-highlight-color:transparent}
.bar{display:flex;align-items:center;gap:12px;padding:10px 12px 10px 18px;min-height:60px;background:linear-gradient(rgba(0,0,0,.55),rgba(0,0,0,0));position:relative;z-index:2}
.counter{font-weight:600;font-variant-numeric:tabular-nums;min-width:52px}
.caption{flex:1;min-width:0;color:#b9b9c3;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tools{display:flex;align-items:center;gap:4px}
.tool{display:inline-flex;align-items:center;justify-content:center;min-width:40px;height:40px;padding:0 10px;border:0;border-radius:20px;background:rgba(255,255,255,.08);cursor:pointer;transition:background .15s ease}
.tool:hover:not(:disabled){background:rgba(255,255,255,.18)}
.tool:disabled{opacity:.35;cursor:default}
.tool svg{width:20px;height:20px}
.level{min-width:64px;font-variant-numeric:tabular-nums;font-size:13px}
.sep{width:1px;height:24px;margin:0 6px;background:rgba(255,255,255,.18)}
.stage{position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;padding:8px 76px;touch-action:none;user-select:none}
.photo{display:block;max-width:100%;max-height:100%;opacity:0;transform-origin:50% 50%;transition:transform .18s ease,opacity .18s ease;-webkit-user-drag:none;user-select:none;cursor:zoom-in}
.zoomed .photo{cursor:grab}
.stage.dragging,.dragging .photo{cursor:grabbing}
.stage[data-state=ready] .photo{opacity:1}
.stage.instant .photo{transition:opacity .18s ease}
.status{position:absolute;inset:0;display:none;flex-direction:column;align-items:center;justify-content:center;gap:12px;pointer-events:none;color:#d6d6de}
.stage[data-state=loading] .status,.stage[data-state=error] .status{display:flex}
.spinner{width:36px;height:36px;border-radius:50%;border:3px solid rgba(255,255,255,.18);border-top-color:#f4f4f6;animation:spin .8s linear infinite}
.stage[data-state=error] .spinner,.stage[data-state=loading] .failed{display:none}
.failed{display:flex;flex-direction:column;align-items:center;gap:10px;pointer-events:auto;text-align:center;max-width:320px}
.failed svg{width:32px;height:32px;opacity:.8}
.retry{padding:8px 16px;border:1px solid rgba(255,255,255,.35);border-radius:20px;background:transparent;cursor:pointer}
.retry:hover{background:rgba(255,255,255,.12)}
.nav{position:absolute;top:50%;z-index:2;display:flex;align-items:center;justify-content:center;width:52px;height:52px;margin-top:-26px;border:1px solid rgba(255,255,255,.16);border-radius:50%;background:rgba(0,0,0,.5);cursor:pointer;transition:background .15s ease,opacity .15s ease}
.nav:hover:not(:disabled){background:rgba(40,40,46,.9)}
.nav:disabled{opacity:.25;cursor:default}
.nav svg{width:28px;height:28px}
.prev{left:14px}.next{right:14px}
.foot{display:flex;flex-direction:column;align-items:center;gap:6px;padding:8px 12px 12px;background:linear-gradient(rgba(0,0,0,0),rgba(0,0,0,.55));position:relative;z-index:2}
.strip{position:relative;display:flex;gap:6px;max-width:100%;overflow-x:auto;padding:4px;scrollbar-width:thin}
.thumb{position:relative;flex:none;width:52px;height:52px;padding:0;border:0;border-radius:8px;overflow:hidden;background:rgba(255,255,255,.08);cursor:pointer;opacity:.55;transition:opacity .15s ease}
.thumb:hover{opacity:.85}
.thumb[aria-current=true]{opacity:1;outline:2px solid #aa9aff;outline-offset:2px}
.thumb img{width:100%;height:100%;object-fit:cover;display:block;opacity:0}
.thumb[data-state=ready] img{opacity:1}
.hint{color:#9a9aa6;font-size:12px;text-align:center}
:focus-visible{outline:2px solid #aa9aff;outline-offset:2px}
@keyframes spin{to{transform:rotate(360deg)}}
@media (max-width:640px){.stage{padding:8px}.nav{width:44px;height:44px;margin-top:-22px}.caption,.hint,.sep{display:none}.level{min-width:52px}}
@media (prefers-reduced-motion:reduce){.photo,.tool,.nav,.thumb{transition:none}.spinner{animation-duration:2.4s}}
`;
const sheets=new Map();
// Constructed sheets are not subject to the page's style CSP; a <style> is the fallback.
function adoptStyle(root,css){
  try{
    let sheet=sheets.get(css);
    if(!sheet){sheet=new CSSStyleSheet();sheet.replaceSync(css);sheets.set(css,sheet);}
    root.adoptedStyleSheets=[sheet];return;
  }catch{}
  const style=document.createElement('style');style.textContent=css;root.append(style);
}
const el=(tag,className)=>{const node=document.createElement(tag);if(className)node.className=className;return node;};
const icon=(node,attributes={})=>lucide(node,{'aria-hidden':'true',focusable:'false',...attributes});
const sizeLabel=bytes=>bytes>=1048576?`${(bytes/1048576).toFixed(1)} MiB`:`${Math.max(1,Math.round(bytes/1024))} KiB`;
// Facebook may act on clicks and keys that reach the message row.
function shield(root){for(const type of ['click','dblclick','mousedown','pointerdown','pointerup','keydown','keyup','touchstart'])root.addEventListener(type,event=>event.stopPropagation());}
const validAsset=asset=>MEDIA_KINDS.includes(asset?.kind)&&Number.isSafeInteger(asset.size)&&asset.size>0&&asset.size<=(asset.kind==='video'?MAX_VIDEO_BYTES:MAX_ASSET_BYTES);

// ---------------------------------------------------------------------------
// In the recalled bubble
// ---------------------------------------------------------------------------
function fileButton(view,asset){
  const button=el('button','file');button.type='button';button.setAttribute('data-pff-file','');
  const paint=()=>{
    const name=asset.name||tr('fileDefaultName',view.language);
    button.textContent=`${name} · ${sizeLabel(asset.size)}`;button.title=tr('fileDownload',view.language,{name});button.setAttribute('aria-label',button.title);
  };
  button.addEventListener('click',async event=>{
    event.preventDefault();if(button.disabled)return;button.disabled=true;
    try{
      const chunks=await readChunks(view.rpc,view.key,asset),url=URL.createObjectURL(new Blob(chunks,{type:'application/octet-stream'})),link=document.createElement('a');
      link.href=url;link.download=asset.name||'file';link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);paint();
    }catch{button.title=tr('mediaUnavailable',view.language);}
    finally{button.disabled=false;}
  });
  view.painters.push(paint);paint();return button;
}
function playerNode(view,asset){
  const video=asset.kind==='video',manual=video&&asset.subtype!=='gif',node=el(video?'video':'audio');
  if(video&&asset.subtype==='gif'){node.loop=true;node.muted=true;node.autoplay=true;node.playsInline=true;}
  else{node.controls=true;node.preload=video?'none':'metadata';}
  const paintTitle=state=>{
    if(state==='error')node.title=tr('mediaUnavailable',view.language);
    else if(manual&&state==='idle')node.title=tr('videoLoad',view.language);else node.removeAttribute('title');
  };
  const slot=new Slot(recordFor(view.key,asset,view.rpc),node,{valid:view.valid,manual,onState:paintTitle});
  if(manual)node.addEventListener('click',()=>{slot.requested=true;slot.want();});
  node.addEventListener('ended',()=>{if(!slot.visible)slot.unwant();});
  view.painters.push(()=>{node.setAttribute('aria-label',tr(video?'videoAria':'voiceAria',view.language));paintTitle(slot.state);});
  view.slots.push(slot);watch(slot);slot.paint();return node;
}
function albumNode(view,images){
  const count=images.length,sticker=count===1&&images[0].subtype==='sticker';
  const columns=count===1?1:count===2||count===4?2:3,shown=count===1?1:Math.min(count,6);
  const box=el('div',`album${count===1?' single':''}${sticker?' sticker':''}`);box.setAttribute('data-pff-album',String(count));
  box.style.setProperty('--columns',String(columns));box.style.setProperty('--width',`${columns===2?240:252}px`);
  images.slice(0,shown).forEach((asset,index)=>{
    const tile=el('button','tile');tile.type='button';tile.setAttribute('data-pff-image-tile',String(index));
    const img=el('img');img.decoding='async';img.draggable=false;
    const veil=el('span','veil'),label=el('span','label'),badge=el('span','badge');veil.append(icon(ImageOff),label);badge.append(icon(Maximize2));
    tile.append(img,veil);
    const hidden=index===shown-1&&count>shown?count-shown:0;
    if(hidden){const more=el('span','more');more.textContent=`+${hidden}`;tile.append(more);}else tile.append(badge);
    const paintTile=()=>{
      const state=slot.state,position=tr('galleryPosition',view.language,{index:index+1,count});
      tile.dataset.state=state;tile.setAttribute('aria-busy',String(state==='loading'));
      img.alt=count>1?`${tr('imageAlt',view.language)} · ${position}`:tr('imageAlt',view.language);
      label.textContent=tr('imageRetry',view.language);
      tile.title=state==='error'?`${tr('imageFailed',view.language)} ${tr('imageRetry',view.language)}`:count>1?tr('viewImageAt',view.language,{index:index+1,count}):tr('viewImage',view.language);
      tile.setAttribute('aria-label',tile.title);
    };
    const slot=new Slot(recordFor(view.key,asset,view.rpc),img,{valid:view.valid,onState:paintTile});
    // Once the size is known the box keeps it, so the chat doesn't jump when an
    // image scrolled out of view gives its memory back.
    if(count===1&&!sticker)img.addEventListener('load',()=>{
      if(!img.naturalWidth||tile.classList.contains('sized'))return;
      const ratio=Math.min(260/img.naturalWidth,320/img.naturalHeight,1),width=Math.max(48,Math.round(img.naturalWidth*ratio)),height=Math.max(48,Math.round(img.naturalHeight*ratio));
      tile.classList.add('sized');tile.style.width=`${width}px`;tile.style.aspectRatio=`${width}/${height}`;
    });
    tile.addEventListener('click',event=>{
      event.preventDefault();
      if(slot.state==='error'){slot.retry();return;}
      openViewer(view,images,index,tile);
    });
    view.painters.push(paintTile);view.slots.push(slot);watch(slot,tile);box.append(tile);
    // A redrawn bubble shows a file that is already loaded at once.
    if(slot.record.url)slot.want();else slot.paint();
  });
  return box;
}
export function archivedMedia(container,key,assets,rpc,valid=()=>container.isConnected,language='en'){
  const host=el('span');host.setAttribute('data-pff-media-view','');host.style.cssText='display:block;max-width:100%';
  const root=host.attachShadow({mode:'open'});adoptStyle(root,BUBBLE_CSS);shield(root);
  const view={key,rpc,language,host,slots:[],painters:[],valid:()=>!disposed&&host.isConnected&&valid()};let disposed=false;
  view.paint=()=>{for(const paint of view.painters)paint();};
  const usable=assets.filter(validAsset),images=usable.filter(asset=>asset.kind==='image');
  if(images.length)root.append(albumNode(view,images));
  for(const asset of usable){
    if(asset.kind==='file')root.append(fileButton(view,asset));
    else if(asset.kind==='video'||asset.kind==='voice')root.append(playerNode(view,asset));
  }
  view.paint();container.append(host);
  const controller={host,localize(next){view.language=next;view.paint();if(viewer?.view===view)viewer.localize();}};
  controllers.add(controller);
  return ()=>{
    if(disposed)return;disposed=true;controllers.delete(controller);
    for(const slot of view.slots)slot.dispose();
    host.remove();pump();
  };
}
export function sweepArchivedMedia(){
  for(const slot of [...slots])if(!slot.node.isConnected&&!slot.viewer||!slot.valid())slot.dispose();
  pump();
}
export function localizeArchivedMedia(container,language){
  for(const controller of controllers)if(container===controller.host||container.contains(controller.host))controller.localize(language);
}
// Called when every restored bubble is taken down: nothing stays readable.
export function clearArchivedMedia(){
  // The queue goes first, so releasing elements below cannot start a load.
  epoch++;waiting.length=0;viewer?.close(false);
  for(const slot of [...slots])slot.dispose();
  for(const record of records.values())if(record.url)URL.revokeObjectURL(record.url);
  records.clear();clearTimeout(trimTimer);trimTimer=null;
}

// ---------------------------------------------------------------------------
// Photo viewer: full screen, zoom, pan and switching between the photos of
// one message. One at a time, drawn in the top layer above Facebook.
// ---------------------------------------------------------------------------
const MIN_SCALE=1,STEP=1.25;
const extensionFor=mime=>({'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/avif':'avif'}[mime]||'img');
function openViewer(view,images,index,opener){
  viewer?.close(false);
  const host=el('div');host.setAttribute('data-pff-viewer','');
  const root=host.attachShadow({mode:'open'});adoptStyle(root,VIEWER_CSS);
  const dialog=el('dialog');dialog.setAttribute('aria-modal','true');dialog.tabIndex=-1;
  const bar=el('div','bar'),counter=el('div','counter'),caption=el('div','caption'),tools=el('div','tools');counter.setAttribute('aria-live','polite');
  const tool=(action,content,className='tool')=>{const button=el('button',className);button.type='button';button.dataset.pffViewerAction=action;button.append(content);return button;};
  const zoomOut=tool('zoom-out',icon(ZoomOut)),level=tool('reset',document.createTextNode('100%'),'tool level'),zoomIn=tool('zoom-in',icon(ZoomIn));
  const save=tool('download',icon(Download)),close=tool('close',icon(X)),sep=el('span','sep');
  tools.append(zoomOut,level,zoomIn,sep,save,close);bar.append(counter,caption,tools);
  const stage=el('div','stage'),photo=el('img','photo'),status=el('div','status'),spinner=el('div','spinner'),failed=el('div','failed'),failedText=el('div'),retry=el('button','retry');
  photo.setAttribute('data-pff-viewer-photo','');photo.draggable=false;photo.decoding='async';retry.type='button';retry.dataset.pffViewerAction='retry';
  failed.append(icon(ImageOff),failedText,retry);status.append(spinner,failed);stage.append(photo,status);
  const previous=tool('previous',icon(ChevronLeft),'nav prev'),next=tool('next',icon(ChevronRight),'nav next');
  const foot=el('div','foot'),strip=el('div','strip'),hint=el('div','hint');
  const many=images.length>1;
  if(many){stage.append(previous,next);foot.append(strip);}
  foot.append(hint);dialog.append(bar,stage,foot);root.append(dialog);
  const state={view,index:-1,scale:1,x:0,y:0,main:null,thumbs:[],open:true};
  const thumbs=images.map((asset,position)=>{
    const button=el('button','thumb'),img=el('img');button.type='button';button.setAttribute('data-pff-viewer-thumb',String(position));img.alt='';img.draggable=false;button.append(img);
    const slot=new Slot(recordFor(view.key,asset,view.rpc),img,{valid:()=>state.open,onState:value=>{button.dataset.state=value;}});slot.viewer=true;
    button.addEventListener('click',()=>show(position));if(many)strip.append(button);state.thumbs.push(slot);return button;
  });

  function localize(){
    const language=view.language;
    dialog.setAttribute('aria-label',tr('viewerLabel',language));caption.textContent=tr('restorationNote',language);
    for(const [button,key] of [[zoomOut,'zoomOut'],[zoomIn,'zoomIn'],[level,'zoomReset'],[save,'downloadImage'],[close,'closeViewer'],[previous,'previousImage'],[next,'nextImage']]){button.setAttribute('aria-label',tr(key,language));button.title=tr(key,language);}
    failedText.textContent=tr('imageFailed',language);retry.textContent=tr('retry',language);
    hint.textContent=tr(many?'viewerHint':'viewerHintSingle',language);
    thumbs.forEach((button,position)=>button.setAttribute('aria-label',tr('galleryPosition',language,{index:position+1,count:images.length})));
    paintPosition();
  }
  function paintPosition(){
    counter.textContent=many?`${state.index+1} / ${images.length}`:'';
    counter.setAttribute('aria-label',tr('galleryPosition',view.language,{index:state.index+1,count:images.length}));
    photo.alt=many?`${tr('imageAlt',view.language)} · ${tr('galleryPosition',view.language,{index:state.index+1,count:images.length})}`:tr('imageAlt',view.language);
  }
  // Zoom keeps the point under the pointer where it is; panning stops at the edges.
  function bounds(){
    const width=photo.offsetWidth*state.scale,height=photo.offsetHeight*state.scale,box=stage.getBoundingClientRect();
    return {x:Math.max(0,(width-box.width)/2),y:Math.max(0,(height-box.height)/2)};
  }
  function apply(){
    const limit=bounds();state.x=Math.max(-limit.x,Math.min(limit.x,state.x));state.y=Math.max(-limit.y,Math.min(limit.y,state.y));
    photo.style.transform=state.scale===1&&!state.x&&!state.y?'':`translate(${state.x}px,${state.y}px) scale(${state.scale})`;
    stage.classList.toggle('zoomed',state.scale>1);level.textContent=`${Math.round(state.scale*100)}%`;
    zoomOut.disabled=state.scale<=MIN_SCALE;zoomIn.disabled=state.scale>=maxScale();level.disabled=state.scale===1;
  }
  function maxScale(){
    const natural=photo.naturalWidth&&photo.offsetWidth?photo.naturalWidth/photo.offsetWidth:1;
    return Math.min(12,Math.max(4,natural*2));
  }
  function zoomTo(scale,clientX,clientY){
    const target=Math.max(MIN_SCALE,Math.min(maxScale(),scale));
    if(target===MIN_SCALE){state.scale=1;state.x=0;state.y=0;apply();return;}
    const box=stage.getBoundingClientRect(),cx=(clientX??box.left+box.width/2)-(box.left+box.width/2),cy=(clientY??box.top+box.height/2)-(box.top+box.height/2);
    const ratio=target/state.scale;state.x=cx-(cx-state.x)*ratio;state.y=cy-(cy-state.y)*ratio;state.scale=target;apply();
  }
  let instantTimer=null;
  function instant(){stage.classList.add('instant');clearTimeout(instantTimer);instantTimer=setTimeout(()=>stage.classList.remove('instant'),160);}
  function show(position){
    position=Math.max(0,Math.min(images.length-1,position));if(position===state.index)return;
    state.index=position;state.scale=1;state.x=0;state.y=0;photo.style.transform='';
    state.main?.dispose();photo.removeAttribute('src');
    const main=new Slot(recordFor(view.key,images[position],view.rpc),photo,{valid:()=>state.open,urgent:true,onState:value=>{
      stage.dataset.state=value;save.disabled=value!=='ready';stage.setAttribute('aria-busy',String(value==='loading'));
    }});main.viewer=true;state.main=main;main.want();
    thumbs.forEach((button,index)=>button.setAttribute('aria-current',String(index===position)));
    // Only the strip scrolls; scrollIntoView could also move the chat behind the viewer.
    if(many){const thumb=thumbs[position];strip.scrollTo({left:thumb.offsetLeft-(strip.clientWidth-thumb.offsetWidth)/2,behavior:'smooth'});}
    previous.disabled=position===0;next.disabled=position===images.length-1;
    // A disabled button loses focus; keep it inside the viewer.
    if(root.activeElement?.disabled){const other=previous.disabled?next:previous;if(other.disabled)dialog.focus();else other.focus({preventScroll:true});}
    paintPosition();apply();
  }
  function closeViewer(restoreFocus=true){
    if(!state.open)return;state.open=false;
    for(const slot of [state.main,...state.thumbs])slot?.dispose();
    window.removeEventListener('resize',apply);window.removeEventListener('keydown',onKey,true);
    if(dialog.open)dialog.close();host.remove();viewer=null;
    if(restoreFocus&&opener?.isConnected)opener.focus({preventScroll:true});
  }

  photo.addEventListener('load',apply);
  zoomIn.addEventListener('click',()=>zoomTo(state.scale*STEP));
  zoomOut.addEventListener('click',()=>zoomTo(state.scale/STEP));
  level.addEventListener('click',()=>zoomTo(1));
  previous.addEventListener('click',()=>show(state.index-1));
  next.addEventListener('click',()=>show(state.index+1));
  retry.addEventListener('click',()=>state.main?.retry());
  close.addEventListener('click',()=>closeViewer());
  save.addEventListener('click',()=>{
    const url=state.main?.record.url;if(!url)return;
    const link=document.createElement('a');link.href=url;link.download=`pitofacebookfixer-photo-${state.index+1}.${extensionFor(images[state.index].mime)}`;link.click();
  });
  dialog.addEventListener('cancel',event=>{event.preventDefault();closeViewer();});
  dialog.addEventListener('close',()=>closeViewer(false));
  // Listened for on the window: keys must work wherever focus ended up, and
  // Facebook's own shortcuts must not see them while the viewer is open.
  function onKey(event){
    if(!state.open)return;
    const handled={ArrowLeft:()=>show(state.index-1),ArrowRight:()=>show(state.index+1),Home:()=>show(0),End:()=>show(images.length-1),
      '+':()=>zoomTo(state.scale*STEP),'=':()=>zoomTo(state.scale*STEP),'-':()=>zoomTo(state.scale/STEP),'0':()=>zoomTo(1),Escape:()=>closeViewer()}[event.key];
    if(event.key!=='Tab')event.stopPropagation();
    if(!handled||event.ctrlKey||event.metaKey||event.altKey)return;
    event.preventDefault();handled();
  }
  window.addEventListener('keydown',onKey,true);
  for(const type of ['keyup','click','dblclick','mousedown','pointerdown','pointerup','touchstart','contextmenu'])dialog.addEventListener(type,event=>event.stopPropagation());
  dialog.addEventListener('wheel',event=>{
    event.preventDefault();event.stopPropagation();
    if(stage.dataset.state!=='ready')return;
    const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?400:1);
    instant();zoomTo(state.scale*Math.exp(-delta*(event.ctrlKey?0.01:0.0015)),event.clientX,event.clientY);
  },{passive:false});
  // A click on the photo zooms in at that point, or back out; dragging pans a
  // zoomed photo and swipes to the next one otherwise; two pointers pinch. A
  // click on the dark area around the photo closes the viewer.
  const pointers=new Map();let gesture=null;
  const onPhoto=(x,y)=>{const box=photo.getBoundingClientRect();return x>=box.left&&x<=box.right&&y>=box.top&&y<=box.bottom;};
  stage.addEventListener('pointerdown',event=>{
    if(event.button!==0||event.target.closest?.('button,.failed'))return;
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(pointers.size===2){
      const [a,b]=[...pointers.values()];
      gesture={pinch:true,distance:Math.hypot(a.x-b.x,a.y-b.y)||1,scale:state.scale};
    }else if(pointers.size===1)gesture={id:event.pointerId,startX:event.clientX,startY:event.clientY,x:state.x,y:state.y,moved:false,photo:onPhoto(event.clientX,event.clientY)};
  });
  stage.addEventListener('pointermove',event=>{
    if(!pointers.has(event.pointerId)||!gesture)return;
    pointers.set(event.pointerId,{x:event.clientX,y:event.clientY});
    if(gesture.pinch){
      if(pointers.size!==2)return;
      const [a,b]=[...pointers.values()];instant();
      zoomTo(gesture.scale*Math.hypot(a.x-b.x,a.y-b.y)/gesture.distance,(a.x+b.x)/2,(a.y+b.y)/2);return;
    }
    const dx=event.clientX-gesture.startX,dy=event.clientY-gesture.startY;
    if(!gesture.moved&&Math.hypot(dx,dy)>4){gesture.moved=true;try{stage.setPointerCapture(event.pointerId);}catch{}}
    if(state.scale>1&&gesture.moved){stage.classList.add('dragging');instant();state.x=gesture.x+dx;state.y=gesture.y+dy;apply();}
  });
  const endPointer=event=>{
    if(!pointers.delete(event.pointerId)||!gesture)return;
    stage.classList.remove('dragging');
    if(gesture.pinch){if(!pointers.size)gesture=null;return;}
    const dx=event.clientX-gesture.startX,dy=event.clientY-gesture.startY,{moved,photo:pressedPhoto}=gesture;gesture=null;
    if(event.type!=='pointerup')return;
    if(moved){if(state.scale===1&&Math.abs(dx)>60&&Math.abs(dx)>Math.abs(dy)*1.5)show(state.index+(dx<0?1:-1));return;}
    if(pressedPhoto&&stage.dataset.state==='ready')zoomTo(state.scale>1?1:2.5,event.clientX,event.clientY);
    else if(!pressedPhoto)closeViewer();
  };
  stage.addEventListener('pointerup',endPointer);stage.addEventListener('pointercancel',endPointer);
  window.addEventListener('resize',apply);

  (document.body||document.documentElement).append(host);
  viewer={view,localize,close:closeViewer};
  localize();
  for(const slot of state.thumbs)slot.want();
  show(index);
  dialog.showModal();
  (many?next.disabled?previous:next:close).focus({preventScroll:true});
}
