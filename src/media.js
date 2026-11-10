export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 64 * 1024 * 1024;
export const MAX_MESSAGE_MEDIA_BYTES = 16 * 1024 * 1024;
export const MAX_ASSETS = 20;
export const ASSET_CHUNK_BYTES = 192 * 1024;
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
export const MEDIA_KINDS = ['image','voice','video','file'];
const TYPES = {
  image:new Set(['image/png','image/jpeg','image/webp','image/gif','image/avif']),
  voice:new Set(['audio/ogg','audio/webm','audio/mp4','audio/mpeg','audio/wav','audio/x-wav','audio/aac']),
  video:new Set(['video/mp4','video/webm']),
};

export function assetLimit(kind,settings,subtype) {
  if(kind!=='video'||subtype==='gif')return MAX_ASSET_BYTES;
  return Math.min((settings?.maxVideoMiB??32)*1024*1024,MAX_VIDEO_BYTES);
}
export function allowedMediaURL(value, origin = 'https://www.facebook.com') {
  if(typeof value!=='string'||value.length>MAX_ASSET_BYTES*1.4+100)return false;
  if(/^data:(?:image\/(?:png|jpeg|webp|gif|avif)|audio\/(?:ogg|webm|mp4|mpeg|wav|x-wav|aac));base64,[a-z0-9+/=]+$/i.test(value))return true;
  try {
    const url=new URL(value);
    if(url.protocol==='blob:')return new URL(url.pathname).origin===origin;
    return value.length<=8192&&url.protocol==='https:'&&!url.username&&!url.password&&
      (url.hostname.endsWith('.fbcdn.net')||url.hostname.endsWith('.fbsbx.com'));
  }catch{return false;}
}
export const validMediaDescriptor = (value, origin) => value&&MEDIA_KINDS.includes(value.kind)&&allowedMediaURL(value.url,origin);
// Identifies a CDN file across visits. Facebook rotates the signature in the
// query string, but the path and the resize parameter name the actual file.
export async function mediaUrlKey(value) {
  try {
    const url=new URL(value);
    if(url.protocol!=='https:')return null;
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${url.pathname}|${url.searchParams.get('stp')||''}`));
    return Array.from(new Uint8Array(digest).subarray(0,16),b=>b.toString(16).padStart(2,'0')).join('');
  }catch{return null;}
}
export function cleanFileName(value) {
  if(typeof value!=='string')return undefined;
  const name=value.replace(/[\x00-\x1f\x7f<>:"/\\|?*]+/g,'_').replace(/^\.+/,'').trim().slice(0,160);
  return name||undefined;
}
export function encodeBase64(bytes) {
  let value='';for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return btoa(value);
}
export function decodeBase64(value) {
  if(typeof value!=='string'||value.length>Math.ceil(MAX_ASSET_BYTES/3)*4||!/^[a-z0-9+/]*={0,2}$/i.test(value))throw Error('errInvalidMediaData');
  const text=atob(value),bytes=new Uint8Array(text.length);
  for(let i=0;i<text.length;i++)bytes[i]=text.charCodeAt(i);
  return bytes;
}
// The second argument (a server-declared type) is deliberately not trusted:
// only the leading bytes of the content decide what a file is.
export function detectedMime(bytes, _declared, kind) {
  if(kind==='file')return bytes.length?'application/octet-stream':null;
  if(!TYPES[kind])return null;
  const ascii=(start,end)=>String.fromCharCode(...bytes.subarray(start,end));
  let mime=null;
  if(bytes[0]===137&&ascii(1,4)==='PNG')mime='image/png';
  else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)mime='image/jpeg';
  else if(ascii(0,4)==='GIF8')mime='image/gif';
  else if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WEBP')mime='image/webp';
  else if(ascii(4,8)==='ftyp'&&/avif|avis/.test(ascii(8,32)))mime='image/avif';
  else if(ascii(0,4)==='OggS')mime='audio/ogg';
  else if(ascii(0,4)==='RIFF'&&ascii(8,12)==='WAVE')mime='audio/wav';
  else if(ascii(0,3)==='ID3'||(bytes[0]===255&&(bytes[1]&224)===224))mime='audio/mpeg';
  else if(ascii(4,8)==='ftyp'&&kind==='voice')mime='audio/mp4';
  else if(ascii(4,8)==='ftyp'&&kind==='video')mime='video/mp4';
  else if(bytes[0]===26&&bytes[1]===69&&bytes[2]===223&&bytes[3]===163&&kind==='voice')mime='audio/webm';
  else if(bytes[0]===26&&bytes[1]===69&&bytes[2]===223&&bytes[3]===163&&kind==='video')mime='video/webm';
  return TYPES[kind].has(mime)?mime:null;
}
export async function readMedia(response, kind, limit = MAX_ASSET_BYTES) {
  if(!response.ok||Number(response.headers.get('content-length'))>limit)throw Error('errMediaDownload');
  const reader=response.body?.getReader();if(!reader)throw Error('errMediaEmpty');
  const chunks=[];let length=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;
    if(length>limit){await reader.cancel();throw Error('errMediaLarge');}chunks.push(value);
  }}finally{reader.releaseLock();}
  const data=new Uint8Array(length);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  const mime=detectedMime(data,response.headers.get('content-type'),kind);
  if(!mime||!length)throw Error('errMediaType');
  return {kind,mime,data};
}
// Keeps decrypted page media as a Blob handle: no base64 string, no second copy.
export async function readBlobMedia(response, kind, limit = MAX_ASSET_BYTES) {
  if(!response.ok||Number(response.headers.get('content-length'))>limit)throw Error('errMediaDownload');
  const blob=await response.blob();
  if(!blob.size)throw Error('errMediaEmpty');
  if(blob.size>limit)throw Error('errMediaLarge');
  const mime=detectedMime(new Uint8Array(await blob.slice(0,64).arrayBuffer()),null,kind);
  if(!mime)throw Error('errMediaType');
  return {kind,mime,blob};
}
export function assetSummary(asset,index) {
  return {kind:asset.kind,mime:asset.mime,size:asset.plainSize??asset.blob?.size??asset.data.byteLength,digest:asset.digest,index,
    ...(asset.subtype?{subtype:asset.subtype}:{}),...(asset.name?{name:asset.name}:{})};
}
export function emojiOnly(value) {
  if(typeof value!=='string'||!value.trim()||value.length>128)return false;
  const stripped=value.replace(/[#*0-9]️?⃣|[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}‍️︎]/gu,'');
  return !stripped.trim()&&/[\p{Extended_Pictographic}\p{Regional_Indicator}⃣]/u.test(value);
}
export function textWithEmoji(node) {
  if(node.nodeType===3)return node.data;
  if(!(node instanceof Element))return '';
  if(node.matches('img'))return emojiOnly(node.getAttribute('alt'))?node.getAttribute('alt'):'';
  return [...node.childNodes].map(textWithEmoji).join('');
}
