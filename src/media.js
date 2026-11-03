export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_MESSAGE_MEDIA_BYTES = 16 * 1024 * 1024;
export const MAX_ASSETS = 20;
export const ASSET_CHUNK_BYTES = 192 * 1024;
const IMAGE_TYPES = new Set(['image/png','image/jpeg','image/webp','image/gif','image/avif']);
const VOICE_TYPES = new Set(['audio/ogg','audio/webm','audio/mp4','audio/mpeg','audio/wav','audio/x-wav','audio/aac']);

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
export const validMediaDescriptor = (value, origin) => value&&['image','voice'].includes(value.kind)&&allowedMediaURL(value.url,origin);
export function encodeBase64(bytes) {
  let value='';for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return btoa(value);
}
export function decodeBase64(value) {
  if(typeof value!=='string'||value.length>Math.ceil(MAX_ASSET_BYTES/3)*4||!/^[a-z0-9+/]*={0,2}$/i.test(value))throw Error('Dữ liệu phương tiện không hợp lệ.');
  return Uint8Array.from(atob(value),c=>c.charCodeAt(0));
}
export function detectedMime(bytes, hint, kind) {
  if(!['image','voice'].includes(kind))return null;
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
  else if(bytes[0]===26&&bytes[1]===69&&bytes[2]===223&&bytes[3]===163&&kind==='voice')mime='audio/webm';
  const normalized=String(hint||'').split(';')[0].trim().toLowerCase();
  return (kind==='image'?IMAGE_TYPES:VOICE_TYPES).has(mime)?mime:null;
}
export async function readMedia(response, kind) {
  if(!response.ok||Number(response.headers.get('content-length'))>MAX_ASSET_BYTES)throw Error('Tệp phương tiện không tải được hoặc vượt 8 MiB.');
  const reader=response.body?.getReader();if(!reader)throw Error('Phương tiện không có nội dung.');
  const chunks=[];let length=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;
    if(length>MAX_ASSET_BYTES){await reader.cancel();throw Error('Tệp phương tiện vượt 8 MiB.');}chunks.push(value);
  }}finally{reader.releaseLock();}
  const data=new Uint8Array(length);let offset=0;for(const chunk of chunks){data.set(chunk,offset);offset+=chunk.length;}
  const mime=detectedMime(data,response.headers.get('content-type'),kind);
  if(!mime||!length)throw Error('Chỉ hỗ trợ ảnh và tin nhắn thoại.');
  return {kind,mime,data};
}
export function assetSummary(asset,index) {
  return {kind:asset.kind,mime:asset.mime,size:asset.blob?.size??asset.data.byteLength,digest:asset.digest,index};
}
export function emojiOnly(value) {
  if(typeof value!=='string'||!value.trim()||value.length>128)return false;
  const stripped=value.replace(/[#*0-9]\ufe0f?\u20e3|[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\u200d\ufe0f\ufe0e]/gu,'');
  return !stripped.trim()&&/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value);
}
export function textWithEmoji(node) {
  if(node.nodeType===3)return node.data;
  if(!(node instanceof Element))return '';
  if(node.matches('img'))return emojiOnly(node.getAttribute('alt'))?node.getAttribute('alt'):'';
  return [...node.childNodes].map(textWithEmoji).join('');
}
