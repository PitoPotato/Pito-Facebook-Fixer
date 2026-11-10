import {decodeBase64,encodeBase64} from './media.js';

// Session storage is memory-only and closed to content scripts by default, so
// an unlocked archive locks itself again when the browser exits.
export const sessionKeys={
  get:async()=>{const {vaultKey}=await chrome.storage.session.get('vaultKey');return vaultKey?decodeBase64(vaultKey):null;},
  set:async bytes=>{await chrome.storage.session.set({vaultKey:encodeBase64(bytes)});},
  clear:async()=>{await chrome.storage.session.remove('vaultKey');},
};
