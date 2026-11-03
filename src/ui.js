import {MiB,normalizeSettings} from './shared.js';
import {archivedMedia,localizeArchivedMedia} from './media-render.js';
import staticMessages from './locales/static.json' with {type:'json'};
import {tr,localeFor,localizeError} from './i18n.js';
import {createIcons,MessagesSquare,LayoutGrid,HardDrive,Archive,Activity,ShieldCheck,SunMoon,TextCursorInput,RotateCw,MessageSquareDashed,EyeOff,ArrowUpRight,Info,SlidersHorizontal,ChevronDown,Check,AudioLines,BrushCleaning,Image,RefreshCw,Search,ArrowRight,MonitorCheck,Trash2,Inbox,Clock3,Languages} from 'lucide';

const icons={MessagesSquare,LayoutGrid,HardDrive,Archive,Activity,ShieldCheck,SunMoon,TextCursorInput,RotateCw,MessageSquareDashed,EyeOff,ArrowUpRight,Info,SlidersHorizontal,ChevronDown,Check,AudioLines,BrushCleaning,Image,RefreshCw,Search,ArrowRight,MonitorCheck,Trash2,Inbox,Clock3,Languages};
const paintIcons=()=>createIcons({icons,attrs:{'aria-hidden':'true','stroke-width':1.7}});
const $=id=>document.getElementById(id),form=$('settings'),popup=document.body.classList.contains('popup');
let archiveRows=[],archiveViews=[],config=null,lastStats=null,lastTab=null,lastFeedback={key:"reading",state:"saving",params:{}},lastPurge=null,language="en",revision=-1,sequence=0,nextCursor=null,mediaDisposers=[],archiveGeneration=0,archiveLoaded=false,limitsDirty=false;
const pending=new Map(),drafts=new Map();
const numberKeys=['maxBytes','maxMessages','retentionDays','imageRetentionDays','voiceRetentionDays'];
const fieldFor=key=>form.elements.namedItem(key==='maxBytes'?'budgetMiB':key);
const version=chrome.runtime.getManifest().version;
for(const node of document.querySelectorAll('[data-version]'))node.textContent=`v${version}`;
paintIcons();
const t=(key,params={})=>tr(key,language,params),locale=()=>localeFor(language);
function renderFeedback(){const {key,state,params}=lastFeedback;$('feedback').textContent=t(key,{...params,...(params.error?{error:localizeError(params.error,language)}:{})});$('feedback').dataset.state=state;}
function feedback(key,state='saved',params={}){lastFeedback={key,state,params};renderFeedback();}
function applyLanguage(){
 language=config?.language||'en';document.documentElement.lang=language;
 for(const node of document.querySelectorAll('[data-i18n]')){const entry=staticMessages[node.dataset.i18n];if(entry)node.textContent=entry[language];}
 for(const attribute of ['aria-label','placeholder','title'])for(const node of document.querySelectorAll(`[data-i18n-${attribute}]`)){const entry=staticMessages[node.getAttribute(`data-i18n-${attribute}`)];if(entry)node.setAttribute(attribute,entry[language]);}
 if($('languageButton')){$('languageCode').textContent=language.toUpperCase();$('languageButton').setAttribute('aria-label',t('languageSwitch'));$('languageButton').title=t('languageSwitch');}
 renderFeedback();updatePageTitle();updateLimitsState();renderTab();
 if(archiveLoaded)localizeArchive();
 if(purgeKind&&$('purgeDescription'))$('purgeDescription').textContent=t(purgeKind==='image'?'purgeImages':'purgeVoice');
 if(lastPurge)renderPurgeResult();
}

async function rpc(message){const result=await chrome.runtime.sendMessage(message);if(!result?.ok)throw Error(result?.error||t('connectionError'));return result;}
function applyTheme(){
 const selected=config?.theme||'system',dark=selected==='dark'||selected==='system'&&matchMedia('(prefers-color-scheme: dark)').matches;
 document.documentElement.dataset.theme=dark?'dark':'light';
 if($('themeButton')){const name=t({system:'themeSystem',light:'themeLight',dark:'themeDark'}[selected]);$('themeButton').title=t('themeTitle',{theme:name});$('themeButton').setAttribute('aria-label',t('themeAria',{theme:name}));}
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change',applyTheme);
function displaySettings(message){
 const incoming=Number.isSafeInteger(message.settingsRevision)?message.settingsRevision:0;
 if(!message.settings||incoming<revision)return;
 revision=incoming;const previousLanguage=language;config=normalizeSettings(message.settings);if(previousLanguage!==config.language)applyLanguage();
 for(const [key,value] of Object.entries(config)){
  const field=fieldFor(key);if(!field)continue;
  if(field.type==='checkbox')field.checked=pending.get(key)?.value??value;
  else if(!drafts.has(key))field.value=String(key==='maxBytes'?Math.round(value/MiB):value);
 }
 $('settingsFields').disabled=false;applyTheme();if(lastStats)displayStats(lastStats);
}
function displayStats(stats){
 if(!config||!stats)return;
 lastStats=stats;
 $('storageUsed').textContent=`${(stats.bytes/MiB).toLocaleString(locale(),{maximumFractionDigits:2,minimumFractionDigits:2})} MiB`;
 $('storageLimit').textContent=`/ ${(config.maxBytes/MiB).toLocaleString(locale())} MiB`;
 $('storageMeter').value=Math.min(1,stats.bytes/config.maxBytes);
 for(const [id,value] of [['messageCount',stats.count],['removedCount',stats.removed],['evictedCount',stats.evicted],['navRemovedCount',stats.removed]])if($(id))$(id).textContent=value.toLocaleString(locale());
 $('capacityNotice').hidden=!stats.capacityBlocked;
 $('capacityNotice').textContent=t('capacityBlocked',{size:((stats.removedBytes||0)/MiB).toLocaleString(locale(),{maximumFractionDigits:2})});
}
function updateLimitsState(){
 const node=$('limitsState');if(!node)return;
 limitsDirty=drafts.size>0;node.textContent=t(limitsDirty?'limitsPending':'limitsSaved');node.parentElement.dataset.dirty=String(limitsDirty);
}
async function savePatch(patch,{numeric=false}={}){
 const request=++sequence;for(const [key,value] of Object.entries(patch))pending.set(key,{request,value});
 feedback('saving','saving');
 try{
  // Dispatch immediately, including from a popup about to close. The worker
  // owns serialization and merges this patch with the current stored state.
  const result=await rpc({type:'save',settings:patch});
  for(const [key,value] of Object.entries(patch)){
   if(pending.get(key)?.request===request)pending.delete(key);
   if(numeric&&drafts.get(key)===String(key==='maxBytes'?value/MiB:value))drafts.delete(key);
  }
  displaySettings(result);displayStats(result.stats);updateLimitsState();
  if(!pending.size)feedback(result.maintenanceError?'maintenancePending':limitsDirty?'limitsDirty':'saved',result.maintenanceError?'error':limitsDirty?'dirty':'saved');
  return result;
 }catch(error){
  for(const key of Object.keys(patch))if(pending.get(key)?.request===request)pending.delete(key);
  if(config)displaySettings({settings:config,settingsRevision:revision});feedback('saveFailed','error',{error:error.message});throw error;
 }
}
form.addEventListener('change',event=>{
 const field=event.target;
 if(field instanceof HTMLInputElement&&field.type==='checkbox'&&config)savePatch({[field.name]:field.checked}).catch(()=>{});
});
form.addEventListener('input',event=>{
 const field=event.target;if(!(field instanceof HTMLInputElement)||field.type!=='number')return;
 const key=field.name==='budgetMiB'?'maxBytes':field.name;if(!numberKeys.includes(key))return;
 const original=String(key==='maxBytes'?Math.round(config.maxBytes/MiB):config[key]);
 if(field.value===original)drafts.delete(key);else drafts.set(key,field.value);
 updateLimitsState();if(limitsDirty)feedback('limitsDirty','dirty');
});
form.addEventListener('submit',async event=>{
 event.preventDefault();if(!config||!form.reportValidity())return;
 const patch={};for(const key of numberKeys){const field=fieldFor(key);if(field)patch[key]=Number(field.value)*(key==='maxBytes'?MiB:1);}
 const button=$('save');if(button)button.disabled=true;
 try{await savePatch(patch,{numeric:true});}catch{}finally{if(button)button.disabled=false;}
});
chrome.storage.onChanged.addListener((changes,area)=>{
 if(area!=='local'||!changes.settings)return;
 chrome.storage.local.get(['settings','settingsRevision']).then(displaySettings).catch(error=>feedback('operationError','error',{error:error.message}));
});
chrome.runtime.onMessage.addListener((message,sender)=>{
 if(sender.id===chrome.runtime.id&&message.type==='archiveStats')displayStats(message.stats);
});
$('languageButton')?.addEventListener('click',()=>{if(config)savePatch({language:config.language==='en'?'vi':'en'}).catch(()=>{});});
$('themeButton')?.addEventListener('click',()=>{if(!config)return;const theme=['system','light','dark'][(['system','light','dark'].indexOf(config.theme)+1)%3];savePatch({theme}).catch(()=>{});});
$('openOptions')?.addEventListener('click',()=>chrome.runtime.openOptionsPage());

function connection(key,state='waiting'){
 if($('connectionText'))$('connectionText').textContent=t(key);
 if($('connectionPill'))$('connectionPill').dataset.state=state;
}
function renderTab(){
 if(!lastTab)return;
 $('tabStats')?.replaceChildren();
 if(lastTab.noTab){connection('noFacebook');if($('tabSummary'))$('tabSummary').textContent=t('openFacebook');return;}
 if(lastTab.error){connection('reloadTab','error');if($('tabSummary'))$('tabSummary').textContent=/receiving end does not exist|could not establish connection/i.test(lastTab.error)?t('missingScript'):t('statusError',{error:localizeError(lastTab.error,language)});return;}
 const status=lastTab.status,counts=status.counters||{};
 const summary=status.error?t('notReady',{error:localizeError(status.error,language)}):!status.connected||!status.configured?t('waitingConfig'):!status.archiveEnabled?t('archiveDisabled'):!status.accountDetected?t('waitingAccount'):t('tabConnected');
 connection(status.error?'needsAttention':status.configured?'connected':'loadingConfig',status.error?'error':status.configured?'ready':'waiting');
 if($('tabSummary'))$('tabSummary').textContent=summary;
 const metrics=[['metricObserved',counts.messagesObserved],['metricBatches',status.savedBatches],['metricRecalls',counts.tombstonesObserved],['metricRestored',status.visible?.restored],['metricWaiting',status.visible?.waitingForDom],['metricUnmatched',status.visible?.unmatched],['metricMediaSaved',status.mediaSaved],['metricMediaFailed',status.mediaFailed],['metricVoiceSaved',counts.voiceAutoLoaded],['metricVoiceFailed',counts.voiceAutoFailed],['metricAccount',counts.missingAccount],['metricId',counts.missingMessageId],['metricThread',counts.missingThread],['metricText',counts.missingText],['metricErrors',counts.adapterErrors],['metricFocus',counts.focusBlocked],['metricReload',counts.reloadSignalsBlocked],['metricNavigation',counts.navigationsBlocked],['metricDropped',(counts.queueDropped||0)+(status.dropped||0)]];
 for(const [key,value] of metrics){if(!$('tabStats'))break;const div=document.createElement('div'),dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=t(key);dd.textContent=Number(value||0).toLocaleString(locale());div.append(dt,dd);$('tabStats').append(div);}
 if(status.sourceDiagnostics&&$('tabStats')){const p=document.createElement('p');p.className='help-text';p.textContent=t('sourceDiagnostic',{source:status.sourceDiagnostics.documentOrigin||status.sourceDiagnostics.senderOrigin||t('missing'),reason:status.sourceDiagnostics.reason});$('tabStats').append(p);}
}
async function refreshTab(){
 const button=$('refreshStatus');if(button)button.disabled=true;
 try{
  const tabs=await chrome.tabs.query({url:['https://www.facebook.com/*','https://web.facebook.com/*','https://www.messenger.com/*','https://messenger.com/*']});
  const focused=await chrome.tabs.query({active:true,lastFocusedWindow:true}),focusedIds=new Set(focused.map(tab=>tab.id));
  const tab=tabs.find(tab=>focusedIds.has(tab.id))||tabs.sort((a,b)=>(b.lastAccessed||0)-(a.lastAccessed||0))[0];
  lastTab=tab?{status:await chrome.tabs.sendMessage(tab.id,{type:'tabStatus'})}:{noTab:true};
 }catch(error){lastTab={error:error.message};}
 finally{renderTab();if(button)button.disabled=false;}
}
$('refreshStatus')?.addEventListener('click',refreshTab);

function emptyArchive(title,description){
 const wrapper=document.createElement('div');wrapper.className='empty-state';const icon=document.createElement('i');icon.dataset.lucide='inbox';const h=document.createElement('h2'),p=document.createElement('p');h.textContent=title;p.textContent=description;wrapper.append(icon,h,p);$('archiveRows').append(wrapper);paintIcons();
}
function filterArchive(){const query=$('archiveSearch').value.trim().toLocaleLowerCase(locale());for(const row of $('archiveRows').querySelectorAll('.archive-row'))row.hidden=query&&!row.dataset.search.includes(query);}
function renderArchive(){
 if(!$('archiveRows'))return;
 for(const dispose of mediaDisposers)dispose();mediaDisposers=[];archiveViews=[];$('archiveRows').replaceChildren();
 if(!archiveRows.length)emptyArchive(t('emptyTitle'),t('emptyHelp'));
 for(const row of archiveRows){
  const article=document.createElement('article');article.className='archive-row';article.dataset.search=(row.mediaPurged?t('mediaPurged'):row.text).toLocaleLowerCase(locale());
  const header=document.createElement('header'),icon=document.createElement('i'),time=document.createElement('time');icon.dataset.lucide='clock-3';time.dateTime=new Date(row.removedAt).toISOString();time.textContent=t('recallDetected',{date:new Date(row.removedAt).toLocaleString(locale())});header.append(icon,time);
  const p=document.createElement('p');p.className='message-body';p.textContent=row.mediaPurged?t('mediaPurged'):row.text;article.append(header,p);$('archiveRows').append(article);
  if(row.assets?.length)mediaDisposers.push(archivedMedia(article,{account:row.account,thread:row.thread,id:row.id},row.assets,rpc,()=>article.isConnected,language));
  const details=document.createElement('details'),summary=document.createElement('summary'),code=document.createElement('code');summary.textContent=t('archiveInfo');code.textContent=t('archiveMetadata',{account:row.account,thread:row.thread,truncated:row.truncated?t('truncatedSuffix'):''});details.append(summary,code);article.append(details);
  archiveViews.push({article,row,time,p,summary,code});
 }
 $('nextPage').hidden=archiveRows.length<30;paintIcons();filterArchive();
}
function localizeArchive(){
 for(const {article,row,time,p,summary,code} of archiveViews){
  article.dataset.search=(row.mediaPurged?t('mediaPurged'):row.text).toLocaleLowerCase(locale());
  time.textContent=t('recallDetected',{date:new Date(row.removedAt).toLocaleString(locale())});
  if(row.mediaPurged)p.textContent=t('mediaPurged');
  summary.textContent=t('archiveInfo');code.textContent=t('archiveMetadata',{account:row.account,thread:row.thread,truncated:row.truncated?t('truncatedSuffix'):''});
  localizeArchivedMedia(article,language);
 }
 const empty=$('archiveRows')?.querySelector('.empty-state');if(empty){empty.querySelector('h2').textContent=t('emptyTitle');empty.querySelector('p').textContent=t('emptyHelp');}
 filterArchive();
}
async function loadArchive(before=null){
 if(!$('archiveRows'))return;const request=++archiveGeneration;
 const result=await rpc({type:'list',before});if(request!==archiveGeneration)return;
 archiveRows=result.rows;archiveLoaded=true;
 const last=archiveRows.at(-1);nextCursor=last?[last.removedAt,last.account,last.thread,last.id]:null;renderArchive();
}
const safely=fn=>async()=>{try{await fn();}catch(error){feedback('operationError','error',{error:error.message});}};
$('refreshArchive')?.addEventListener('click',safely(()=>loadArchive()));$('nextPage')?.addEventListener('click',safely(()=>loadArchive(nextCursor)));$('archiveSearch')?.addEventListener('input',filterArchive);
function pageKey(){return ['overview','storage','archive','diagnostics'].includes(location.hash.slice(1))?location.hash.slice(1):'overview';}
function updatePageTitle(){if(popup)return;const name=staticMessages[pageKey()][language];$('currentPage').textContent=name;document.title=`${name} · PitoFacebookFixer`;}
function navigate(){
 if(popup)return;const key=pageKey();
 for(const page of document.querySelectorAll('[data-page]'))page.hidden=page.dataset.page!==key;
 for(const link of document.querySelectorAll('[data-nav]')){if(link.dataset.nav===key)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');}
 updatePageTitle();
 if(key==='archive'&&!archiveLoaded)loadArchive().catch(error=>feedback('operationError','error',{error:error.message}));
 if(key==='diagnostics')refreshTab();
}
addEventListener('hashchange',()=>{navigate();$('mainContent')?.focus({preventScroll:true});});navigate();
let purgeKind,lastTrigger;
function openDialog(id,trigger){lastTrigger=trigger;$(id).showModal();}
function closeDialog(id){$(id).close();lastTrigger?.focus();}
$('requestClear')?.addEventListener('click',event=>openDialog('clearPanel',event.currentTarget));
$('cancelClear')?.addEventListener('click',()=>closeDialog('clearPanel'));
$('confirmClear')?.addEventListener('click',async()=>{
 const button=$('confirmClear');button.disabled=true;
 try{const result=await rpc({type:'clear'});displayStats(result.stats);await loadArchive();closeDialog('clearPanel');feedback('cleared');}catch(error){feedback('operationError','error',{error:error.message});}finally{button.disabled=false;}
});
for(const [id,kind] of [['requestImages','image'],['requestVoice','voice']])$(id)?.addEventListener('click',event=>{
 purgeKind=kind;$('purgeDescription').textContent=t(kind==='image'?'purgeImages':'purgeVoice');lastPurge=null;$('purgeRemoved').checked=false;$('purgeDays').value='0';$('purgeFeedback').textContent='';openDialog('purgePanel',event.currentTarget);
});
$('cancelPurge')?.addEventListener('click',()=>closeDialog('purgePanel'));
$('confirmPurge')?.addEventListener('click',async()=>{
 const button=$('confirmPurge');button.disabled=true;
 try{
  const days=Number($('purgeDays').value);if(!$('purgeDays').value||!Number.isInteger(days)||days<0||days>3650)throw Error(t('invalidDays'));
  const result=await rpc({type:'purgeMedia',kind:purgeKind,days,includeRemoved:$('purgeRemoved').checked});displayStats(result.stats);await loadArchive();lastPurge=result;renderPurgeResult();
 }catch(error){$('purgeFeedback').textContent=localizeError(error.message,language);}finally{button.disabled=false;}
});
function renderPurgeResult(){if(lastPurge&&$('purgeFeedback'))$('purgeFeedback').textContent=t('purgeDone',{count:lastPurge.files.toLocaleString(locale()),files:t(lastPurge.files===1?'file':'files'),size:(lastPurge.bytes/MiB).toLocaleString(locale(),{minimumFractionDigits:2,maximumFractionDigits:2})});}
for(const id of ['clearPanel','purgePanel'])$(id)?.addEventListener('cancel',()=>lastTrigger?.focus());
async function initialize(){
 try{
  displaySettings(await rpc({type:'config'}));feedback('saved');
  const result=await rpc({type:'status'});displaySettings(result);displayStats(result.stats);
 }
 catch(error){feedback('operationError','error',{error:error.message});}
}
applyLanguage();applyTheme();initialize();refreshTab();
