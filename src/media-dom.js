import {MAX_ASSETS,emojiOnly,allowedMediaURL,readBlobMedia,cleanFileName} from './media.js';
import {canonicalMessageId} from './shared.js';

const voiceSources=new WeakMap(),sources=new WeakMap();let serial=0;
let preload=()=>{};
export const requestVoicePreload=(row,item)=>preload(row,item);
export function releaseVoicePayloads(items){for(const item of items||[])for(const descriptor of item.media||[])if(descriptor.automatic){delete descriptor.blob;descriptor.stored=true;}}
const nativeId=row=>canonicalMessageId(row.getAttribute('data-message-id')||row.getAttribute('data-mid')||row.id);
const excluded='[role="toolbar"],[role="heading"],h1,h2,h3,h4,h5,h6,[data-pff-media],[data-pff-restored],blockquote';
function source(node,url,kind){
  let known=sources.get(node);
  if(!known||known.url!==url){known={url,sourceId:`media-${++serial}`};sources.set(node,known);}
  return {kind,url,sourceId:known.sourceId};
}
export function voiceRow(row){
  return !!row.querySelector('[role="slider"][aria-label*="Audio"],[role="slider"][aria-label*="âm thanh"],[data-message-voice]');
}
function fileName(link,url){
  try{return cleanFileName(link.getAttribute('download')||decodeURIComponent(new URL(url).pathname.split('/').pop()||''))||cleanFileName(link.textContent);}
  catch{return cleanFileName(link.textContent);}
}
export function collectMedia(row,options={}){
  const result=[],unique=new Set();let imagePosition=0,videoPosition=0,filePosition=0;
  for(const img of row.querySelectorAll('img')){
    const url=img.currentSrc||img.src,alt=img.getAttribute('alt')||'';
    if(img.closest(excluded)||emojiOnly(alt)||/profile|đại diện|video|tệp|file/i.test(alt)||/\/emoji\.php\//.test(url))continue;
    const label=img.closest('[role="button"],a')?.getAttribute('aria-label')||'',description=`${alt} ${label}`;
    const sticker=/sticker|nhãn dán/i.test(alt)||/\/stickers?\//.test(url),gif=!sticker&&(/\bgif\b/i.test(description)||/\.gif(?:$|\?)/i.test(url));
    if((sticker||gif)&&!options.saveStickers)continue;
    if(!sticker&&!gif&&!/open photo|mở ảnh|photo|ảnh|image/i.test(description))continue;
    const position=imagePosition++;
    if(!allowedMediaURL(url,location.origin))continue;
    result.push({...source(img,url,'image'),position,...(sticker?{subtype:'sticker'}:gif?{subtype:'gif'}:{})});unique.add(url);if(result.length===MAX_ASSETS)return result;
  }
  for(const video of row.querySelectorAll('video')){
    const url=video.currentSrc||video.src,gif=video.loop&&!video.controls;
    if(video.closest(excluded)||(gif?!options.saveStickers:!options.saveVideo)||unique.has(url)||!allowedMediaURL(url,location.origin))continue;
    result.push({...source(video,url,'video'),position:videoPosition++,...(gif?{subtype:'gif'}:{})});unique.add(url);if(result.length===MAX_ASSETS)return result;
  }
  // Only direct attachment links count. Ordinary page links never qualify, and
  // a file is captured by reading its URL, never by clicking on the user's behalf.
  if(options.saveFiles)for(const link of row.querySelectorAll('a[href]')){
    const url=link.href;
    if(link.closest(excluded)||link.querySelector('img,video')||unique.has(url)||!allowedMediaURL(url,location.origin)||!/\.fbsbx\.com$/.test(new URL(url).hostname))continue;
    result.push({...source(link,url,'file'),position:filePosition++,name:fileName(link,url)});unique.add(url);if(result.length===MAX_ASSETS)return result;
  }
  if(voiceRow(row)){
    for(const audio of row.querySelectorAll('audio,[data-message-voice]')){
      const url=audio.currentSrc||audio.src||audio.getAttribute('data-message-voice');
      if(!audio.closest(excluded)&&allowedMediaURL(url,location.origin)&&!unique.has(url)){result.push(source(audio,url,'voice'));unique.add(url);}
    }
    const known=voiceSources.get(row);
    if(known?.nativeId===nativeId(row)&&!unique.has(known.url))result.push(known);
  }
  return result.slice(0,MAX_ASSETS);
}
export function installVoiceCapture(config,changed,policy=async()=>false,count=()=>{}){
  let selected=null,automatic=null,scheduled=false,preloading=false,manualAudio=null,inputEpoch=0;const pendingMetadata=new WeakMap(),automaticPlayers=new WeakMap(),attempts=new WeakMap(),queued=new WeakSet(),jobs=[];
  async function run(){
    scheduled=false;if(automatic||!jobs.length)return;
    const job=jobs.shift(),row=job.row.deref();
    if(row)queued.delete(row);
    const expectedId=canonicalMessageId(job.item.nativeId),epoch=inputEpoch;
    if(!config().archive||!config().autoVoice||!row?.isConnected||nativeId(row)!==expectedId){schedule();return;}
    const rect=row.getBoundingClientRect();
    if(rect.bottom<0||rect.top>innerHeight+100||manualAudio?.deref()?.paused===false){schedule();return;}
    const button=[...row.querySelectorAll('button,[role="button"]')].find(n=>/^(?:play|phát)(?: voice clip| audio| đoạn âm thanh| tin nhắn thoại)?$/i.test(n.getAttribute('aria-label')||''));
    if(!button||!await policy(job.item)||!row.isConnected||nativeId(row)!==expectedId||epoch!==inputEpoch){schedule();return;}
    if(!config().archive||!config().autoVoice){schedule();return;}
    const previousAttempt=attempts.get(row);attempts.set(row,{id:expectedId,count:previousAttempt?.id===expectedId?previousAttempt.count+1:1});
    const context={row:new WeakRef(row),id:expectedId,at:Date.now(),consumed:false};automatic=context;
    context.timer=setTimeout(()=>{if(automatic===context){automatic=null;if(row.isConnected&&nativeId(row)===expectedId)changed(row);}schedule();},10000);
    // Facebook resolves/decrypts the clip in its own handler. The play hook
    // below captures the resulting source and never starts native playback.
    button.click();
  }
  function schedule(){if(!scheduled&&!preloading&&!automatic&&jobs.length){scheduled=true;setTimeout(()=>{preloading=true;run().catch(()=>{automatic=null;}).finally(()=>{preloading=false;schedule();});},250);}}
  preload=(row,item)=>{
    const attempt=attempts.get(row);
    if(!config().autoVoice||!config().archive||jobs.length>=16||queued.has(row)||attempt?.id===canonicalMessageId(item.nativeId)&&attempt.count>=2)return;
    queued.add(row);jobs.push({row:new WeakRef(row),item});schedule();
  };
  document.addEventListener('pointerdown',event=>{
    inputEpoch++;
    if(automatic){clearTimeout(automatic.timer);automatic=null;schedule();}
    const element=event.target instanceof Element?event.target:null,row=element?.closest('[data-message-id],[data-mid],[id^="mid."]');
    selected=row&&voiceRow(row)&&!element.closest('[data-pff-restored]')?{row:new WeakRef(row),id:nativeId(row),at:Date.now()}:null;
  },true);
  const play=HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play=function(){
    const owned=automaticPlayers.get(this);
    if(owned){
      const explicit=selected&&!selected.consumed&&selected.id===owned.id&&selected.row.deref()===owned.row.deref()&&Date.now()-selected.at<10000;
      if(!explicit)return Promise.resolve();
      automaticPlayers.delete(this);
    }
    const auto=automatic,autoRow=auto?.row.deref();
    if(auto&&!auto.consumed&&this instanceof HTMLAudioElement&&autoRow?.isConnected&&nativeId(autoRow)===auto.id&&Date.now()-auto.at<10000){
      auto.consumed=true;const audio=this,url=this.src||this.currentSrc;
      automaticPlayers.set(audio,{row:new WeakRef(autoRow),id:auto.id});
      (async()=>{
        if(!config().archive||!config().autoVoice)return;
        if(!allowedMediaURL(url,location.origin))return;
        const loaded=await readBlobMedia(await fetch(url,{signal:AbortSignal.timeout(8000)}),'voice');
        if(automatic!==auto||!config().archive||!autoRow.isConnected||nativeId(autoRow)!==auto.id)return;
        voiceSources.set(autoRow,{...source(audio,url,'voice'),nativeId:auto.id,automatic:true,blob:loaded.blob});count('voiceAutoLoaded');changed(autoRow);
      })().catch(()=>{count('voiceAutoFailed');if(autoRow.isConnected&&nativeId(autoRow)===auto.id)changed(autoRow);}).finally(()=>{
        clearTimeout(auto.timer);if(automatic===auto)automatic=null;
        audio.pause();audio.dispatchEvent(new Event('pause'));schedule();
      });
      return Promise.resolve();
    }
    const row=selected?.row.deref();
    if(config().archive&&!selected?.consumed&&this instanceof HTMLAudioElement&&row?.isConnected&&nativeId(row)===selected.id&&Date.now()-selected.at<10000&&
      document.activeElement?.closest('[data-message-id],[data-mid],[id^="mid."]')===row){
      const selection=selected,expectedId=selected.id;selection.consumed=true;
      pendingMetadata.get(this)?.();
      const capture=()=>{
        if(!config().archive||!row.isConnected||nativeId(row)!==expectedId||selected!==selection)return;
        const url=this.src||this.currentSrc;
        if(allowedMediaURL(url,location.origin)){
          voiceSources.set(row,{...source(this,url,'voice'),nativeId:expectedId});changed(row);
        }
      };
      capture();
      if(this.readyState<1){
        const cleanup=()=>{this.removeEventListener('loadedmetadata',loaded);this.removeEventListener('error',cleanup);pendingMetadata.delete(this);};
        const loaded=()=>{cleanup();capture();};pendingMetadata.set(this,cleanup);
        this.addEventListener('loadedmetadata',loaded,{once:true});this.addEventListener('error',cleanup,{once:true});
      }
    }
    if(this instanceof HTMLAudioElement)manualAudio=new WeakRef(this);
    return Reflect.apply(play,this,arguments);
  };
}
