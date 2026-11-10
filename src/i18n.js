import messages from './locales/messages.json' with {type:'json'};

export const localeFor=language=>language==='vi'?'vi-VN':'en-US';
export function tr(key,language='en',params={}){
  const template=messages[key]?.[language]??messages[key]?.en??key;
  return template.replace(/\{(\w+)\}/g,(_,name)=>String(params[name]??''));
}
// Errors travel as stable codes and are translated only where they are shown.
export function localizeError(value,language='en'){
  const message=String(value||'');
  const source=message.match(/^errSource:(.+)$/);
  if(source)return tr('errSource',language,{reason:source[1]});
  return /^err[A-Z]/.test(message)&&messages[message]?tr(message,language):message;
}
