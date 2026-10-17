const $=id=>document.getElementById(id);
const statusNames={queued:'실행 대기',running:'진행 중',waiting:'결정 대기',waiting_approval:'실행 승인 대기',paused:'일시정지',completed:'완료',failed:'실행 실패',recovery:'복구 대기',rate_limited:'사용량 한도 대기'};
let state,selected=null,eventSource,toastTimer,refreshTimer,view='tasks',inboxKey=crypto.randomUUID(),limitsState=null;
let conversation=null;
let selectedImprovement=null,improvementKey=crypto.randomUUID(),improvementNoteKey=crypto.randomUUID();
const artifactOpenByTask=new Map();
let replyKey=crypto.randomUUID();
async function api(path,body){const res=await fetch('/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await res.json();if(!res.ok){if(res.status===401)showLogin();throw new Error(data.error||'요청 실패');}return data;}
function toast(text){$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6000);}
function showLogin(){$('login').hidden=false;$('workspace').hidden=true;eventSource?.close();}
function el(tag,className,text){const e=document.createElement(tag);if(className)e.className=className;if(text!==undefined)e.textContent=text;return e;}
function button(text,fn,className='secondary'){const b=el('button',className,text);b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){toast(e.message);}finally{b.disabled=false;}};return b;}
const attachmentQueues={inbox:[],reply:[]};
function renderAttachmentQueue(key){
const container=$(key+'-attachment-list');container.replaceChildren();
container.hidden=!attachmentQueues[key].length;
if(!attachmentQueues[key].length)return;
  for(const [index,entry] of attachmentQueues[key].entries()){
    const item=el('div','attachment-chip');const label=el('span','',entry.file.name+' · '+(entry.file.size/1048576).toFixed(2)+' MB');
    const remove=button('삭제',()=>{attachmentQueues[key].splice(index,1);renderAttachmentQueue(key);if(key==='inbox')inboxKey=crypto.randomUUID();else replyKey=crypto.randomUUID();},'attachment-remove');
    item.append(label,remove);container.append(item);
  }
}
function setupAttachments(key,textareaId,containerId){
const container=$(containerId);container.replaceChildren();container.className='attachment-picker';container.hidden=false;
  const picker=el('input');picker.type='file';picker.multiple=true;picker.hidden=true;picker.accept='*/*';picker.setAttribute('aria-label','첨부 파일 선택');
  const choose=el('button','secondary attachment-choose','파일 첨부');choose.type='button';choose.onclick=()=>picker.click();
  const list=el('div','attachment-list');list.id=key+'-attachment-list';
  picker.onchange=()=>{
    const files=[...picker.files];const queue=attachmentQueues[key];
    let total=queue.reduce((sum,item)=>sum+item.file.size,0);
    for(const file of files){
      if(queue.length>=5){toast('한 번에 최대 5개 파일까지 첨부할 수 있습니다.');break;}
      if(file.size>20*1024*1024){toast(file.name+': 파일당 최대 20MB까지 첨부할 수 있습니다.');continue;}
      if(total+file.size>50*1024*1024){toast('첨부 파일 합계는 50MB 이하여야 합니다.');continue;}
      queue.push({file,id:null});total+=file.size;
    }
    picker.value='';renderAttachmentQueue(key);if(key==='inbox')inboxKey=crypto.randomUUID();else replyKey=crypto.randomUUID();
  };
  container.append(choose,picker,list);
}
async function uploadAttachments(key){
  const ids=[];
  for(const item of attachmentQueues[key]){
    if(!item.id){const response=await fetch('/api/attachments?name='+encodeURIComponent(item.file.name),{method:'POST',body:item.file});const data=await response.json();if(!response.ok)throw new Error(data.error||'파일을 첨부하지 못했습니다.');item.id=data.id;}
    ids.push(item.id);
  }
  return ids;
}
setupAttachments('inbox','inbox-text','inbox-attachments');
setupAttachments('reply','reply','reply-attachments');
$('inbox-text').required=false;$('reply').required=false;
function appendMessageAttachments(item,files){
  if(!files?.length)return;const list=el('div','message-attachments');
  for(const file of files){const link=el('a','attachment-link','📎 '+file.name+' · '+(file.size/1048576).toFixed(2)+' MB');link.href='/api/attachments/'+encodeURIComponent(file.id);link.setAttribute('download','');list.append(link);}
  item.append(list);
}
function showView(name){view=name;for(const e of document.querySelectorAll('.view'))e.hidden=e.id!=='view-'+name;for(const e of document.querySelectorAll('.nav'))e.classList.toggle('active',e.dataset.view===name);$('page-title').textContent=({tasks:'오늘의 작업',decisions:'결정 대기함',improvements:'개선 요청',report:'정기 보고',limits:'사용량·모델',settings:'연결·설정'})[name];if(name==='limits')void loadLimits();if(name==='improvements')void loadImprovements();}
for(const e of document.querySelectorAll('[data-view]'))e.onclick=()=>showView(e.dataset.view);
async function refresh(){try{state=await api('/state');$('login').hidden=true;$('workspace').hidden=false;render();refreshWorkspacesSoon();if(selected)await loadTask(selected);}catch(e){if(!$('workspace').hidden)toast(e.message);}}
// Minimal, safe Markdown: headings, lists, checkboxes, bold, inline code and code blocks are built as
// elements; everything else stays plain text, so model output never becomes HTML.
function inlineMarkdown(parent,text){
  const pattern=/(\*\*[^*]+\*\*|`[^`]+`)/g;let last=0,match;
  while((match=pattern.exec(text))){
    if(match.index>last)parent.append(text.slice(last,match.index));
    const token=match[0];parent.append(token.startsWith('**')?el('strong','',token.slice(2,-2)):el('code','',token.slice(1,-1)));
    last=match.index+token.length;
  }
  if(last<text.length)parent.append(text.slice(last));
}
function markdown(text,className=''){
  const root=el('div','md '+className);let list=null,code=null;
  for(const line of String(text??'').split(/\r?\n/)){
    if(code){if(/^\s*```/.test(line)){root.append(code);code=null;}else code.textContent+=(code.textContent?'\n':'')+line;continue;}
    if(/^\s*```/.test(line)){list=null;code=el('pre','md-code');continue;}
    const heading=line.match(/^(#{1,6})\s+(.*)$/),item=line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    if(heading){list=null;const h=el('p','md-h md-h'+Math.min(heading[1].length,3));inlineMarkdown(h,heading[2]);root.append(h);continue;}
    if(item){
      const ordered=/^\s*\d/.test(line);
      if(!list||list.dataset.ordered!==String(ordered)){list=el(ordered?'ol':'ul','md-list');list.dataset.ordered=String(ordered);root.append(list);}
      const li=el('li'),box=item[1].match(/^\[( |x|X)\]\s+(.*)$/);
      if(box){li.className='md-task';li.append(box[1]===' '?'☐ ':'☑ ');inlineMarkdown(li,box[2]);}else inlineMarkdown(li,item[1]);
      list.append(li);continue;
    }
    list=null;if(!line.trim())continue;
    const p=el('p','md-p');inlineMarkdown(p,line);root.append(p);
  }
  if(code)root.append(code);
  return root;
}
let workspaceGroups=[],generalFolder='',generalLabel='',workspacesLoadedAt=0,workspacesReady=false,currentSpace=savedSpace();
// The chosen space is a per-device convenience; the page works the same without storage.
function savedSpace(){try{return localStorage.getItem('space')||'all';}catch{return 'all';}}
function saveSpace(value){try{localStorage.setItem('space',value);}catch{}}
const sameSpace=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
function inSpace(task,space=currentSpace){return space==='all'||sameSpace(task.space,space);}
// A task can create a new project folder at any time, so the list follows screen updates (at most every few seconds).
function refreshWorkspacesSoon(){if(Date.now()-workspacesLoadedAt>3000)void loadWorkspaces();}
async function loadWorkspaces(){
  workspacesLoadedAt=Date.now();
  try{const data=await api('/workspaces');workspaceGroups=data.groups;const parts=String(data.general||'').split(/[\\/]/).filter(Boolean);generalFolder=parts.at(-1)||'';generalLabel=parts.slice(-2).join('\\');workspacesReady=true;}catch{}
  renderSpaces();
}
function renderSpaces(){
  if(!state)return;
  const select=$('space'),tasks=state.tasks.filter(t=>!t.archived_at);
  const badge=space=>{const own=tasks.filter(t=>inSpace(t,space));const waiting=state.decisions.filter(d=>own.some(t=>t.id===d.task_id)).length;return (own.length?' · '+own.length:'')+(waiting?' · 결정 '+waiting:'');};
  select.replaceChildren(new Option('전체 보기'+badge('all'),'all'),new Option('일반'+(generalFolder?' ('+generalFolder+')':'')+badge('general'),'general'));
  for(const group of workspaceGroups){
    if(!group.folders.length)continue;
    const optgroup=document.createElement('optgroup');optgroup.label=group.root;
    for(const folder of group.folders)optgroup.append(new Option(folder.name+badge(folder.path),folder.path));
    select.append(optgroup);
  }
  if(tasks.some(t=>t.space==='other'))select.append(new Option('기타'+badge('other'),'other'));
  let match=[...select.options].find(o=>sameSpace(o.value,currentSpace));
  if(!match&&!workspacesReady){match=new Option('불러오는 중',currentSpace);select.append(match);}
  if(!match){currentSpace='all';match=select.options[0];}
  select.value=match.value;
  renderSpaceNotes();
}
// Where the current space sends instructions and which tasks the list shows, repeated next to both.
const composerSpace=el('span','space-note');document.querySelector('label[for="inbox-text"]').append(composerSpace);
const listSpace=el('span','space-note');$('task-list').closest('section').querySelector('.section-heading h2').append(listSpace);
const listSpaceHint=el('p','muted space-hint','목록 위치를 바꾸려면 위에서 작업 공간을 변경하세요.');$('task-list').closest('section').querySelector('.section-heading').after(listSpaceHint);
function spacePath(space=currentSpace){
  if(space==='all')return '';
  if(space==='general')return generalLabel||'일반';
  if(space==='other')return '기타';
  for(const group of workspaceGroups)for(const folder of group.folders)if(sameSpace(folder.path,space))return group.root+'\\'+folder.name;
  return '';
}
function renderSpaceNotes(){
  const path=spacePath();
  composerSpace.textContent=currentSpace==='all'?' · 전체 (새 작업은 일반에 생성)':path?' · 📁 '+path:'';
  const archive=$('filter').value==='archived';
  listSpace.textContent=archive?' · 보관함 (모든 작업 공간)':currentSpace==='all'?' · 전체':path?' · 📁 '+path:'';
  listSpaceHint.textContent=archive?'보관함은 모든 작업 공간의 보관 작업을 보여줍니다.':'목록 위치를 바꾸려면 위에서 작업 공간을 변경하세요.';
}
$('space').onchange=()=>{currentSpace=$('space').value;saveSpace(currentSpace);inboxKey=crypto.randomUUID();render();};
function providerInfo(id){return state?.providers?.find(p=>p.id===id);}
function providerLabel(id){return providerInfo(id)?.label||id||'AI';}
function fillSelect(select,options,fallback){const current=select.value;select.replaceChildren(...options);const usable=[...select.options].filter(o=>!o.disabled);select.value=usable.some(o=>o.value===current)?current:usable.some(o=>o.value===fallback)?fallback:usable[0]?.value||'';}
function renderProviders(){
  const providers=state.providers||[];
  const preferred=providerInfo(state.defaultProvider)?.connected?state.defaultProvider:providers.find(p=>p.connected)?.id;
  fillSelect($('inbox-provider'),providers.map(p=>{const o=new Option(p.label+(p.connected?'':' · 연결 안 됨'),p.id);o.disabled=!p.connected;return o;}),preferred);
  const profiles=providerInfo($('inbox-provider').value)?.profiles||state.config.profiles||{};
  // A new AI choice starts from its standard profile; later refreshes keep the user's pick.
  if($('inbox-profile').dataset.provider!==$('inbox-provider').value){$('inbox-profile').dataset.provider=$('inbox-provider').value;$('inbox-profile').value='';}
  fillSelect($('inbox-profile'),Object.entries(profiles).map(([key,p])=>new Option((p.label||key)+(p.model?' · '+p.model+(p.effort?' / '+p.effort:''):' · 추천 설정'),key)),'standard');
  fillSelect($('limits-provider'),providers.map(p=>new Option(p.label,p.id)),$('inbox-provider').value);
  const status=$('provider-status');status.replaceChildren();
  for(const p of providers){const row=el('div','provider-row'),info=el('div');info.append(el('strong','',p.label));if(!p.connected&&p.error)info.append(el('small','',p.error));row.append(info,el('span','badge '+(p.connected?'connected':'failed'),p.connected?'연결됨':'연결 안 됨'));status.append(row);}
}
$('inbox-provider').onchange=()=>{renderProviders();inboxKey=crypto.randomUUID();};
$('limits-provider').onchange=()=>void loadLimits();
$('reconnect-providers').onclick=async()=>{$('reconnect-providers').disabled=true;try{await api('/providers/reconnect',{});await refresh();toast('AI 연결 상태를 다시 확인했습니다.');}catch(e){toast(e.message);}finally{$('reconnect-providers').disabled=false;}};
function render(){
  const providers=state.providers||[];
  $('connection').textContent=providers.length?providers.map(p=>p.label+(p.connected?' 연결됨':' 연결 안 됨')).join(' · '):state.connected?'연결됨':'작업을 기다리는 중';
  renderProviders();
  const visibleTasks=state.tasks.filter(t=>!t.archived_at);
  $('nav-tasks').textContent=visibleTasks.length;$('nav-decisions').textContent=state.decisions.length;
  $('count-running').textContent=visibleTasks.filter(t=>t.status==='running').length;$('count-waiting').textContent=state.decisions.length;$('count-completed').textContent=visibleTasks.filter(t=>t.status==='completed').length;
  $('pause-all').textContent=state.paused?'작업 접수 재개':'전체 일시정지';
  const target=$('inbox-target').value;$('inbox-target').replaceChildren(new Option('자동 분류',''),new Option('새 작업','new'),...visibleTasks.filter(t=>inSpace(t)).map(t=>new Option(t.title,t.id)));$('inbox-target').value=[...$('inbox-target').options].some(o=>o.value===target)?target:'';renderSpaces();
  renderTasks();renderDecisions();if(view==='limits')void loadLimits();if(view==='improvements')void loadImprovements();
  $('report-text').textContent=state.digest?.text||'첫 보고서를 기다리고 있습니다. 지금 보고서를 만들 수도 있어요.';
  $('mobile-url').textContent=state.publicOrigin||'사설 접속 주소 설정 중';if(state.publicOrigin)$('mobile-url').href=state.publicOrigin;
  $('runtime-settings').textContent='동시 실행 '+state.config.maxConcurrent+'개 · 작업당 자동 진행 '+state.config.maxCycles+'회 · 정기 보고 '+state.config.digestHours.join('시, ')+'시 ('+state.config.timezone+')';
  $('enable-push').disabled=!state.pushAvailable;
}
function profileLabel(task){
  const confirmed=!!task.session_checked_at;
  const model=confirmed?(task.session_model||'확인 안 됨'):(task.model||'자동 선택');
  const effort=confirmed?(task.session_effort||'자동 / 미지정'):(task.effort||'자동');
  const pending=task.settings_revision>task.applied_settings_revision;
  return providerLabel(task.provider_id)+' · '+(confirmed?'세션 모델: ':'요청 모델: ')+model+' · effort: '+effort+(pending?' → 다음 실행: '+(task.model||'자동 선택')+' / '+(task.effort||'추천 설정'):'');
}
async function loadLimits(){const provider=$('limits-provider').value;try{const data=await api('/limits'+(provider?'?provider='+encodeURIComponent(provider):''));if(provider===$('limits-provider').value){limitsState=data;renderLimits();}}catch(e){const c=$('limits-content');c.replaceChildren(el('article','setting-card',providerLabel(provider)+' 사용량을 불러오지 못했습니다: '+e.message));}}
async function loadImprovements(){
  try{
    const data=await api('/maintenance-requests');
    const list=$('improvement-list'),signature=JSON.stringify(data.requests);
    if(list.dataset.signature!==signature){
      list.dataset.signature=signature;list.replaceChildren();
      if(!data.requests.length)list.append(el('p','muted','아직 접수된 개선 요청이 없습니다.'));
      for(const request of data.requests){
        const card=button('',()=>loadImprovement(request.id),'improvement-item'+(selectedImprovement===request.id?' selected':''));card.dataset.requestId=request.id;
        const updated=el('small','',new Date(request.updated_at).toLocaleString('ko-KR')+(request.note_count?' · 추가 내용 '+request.note_count+'개':''));
        card.append(el('strong','',request.title),updated);list.append(card);
      }
    }
    if(selectedImprovement&&data.requests.some(request=>request.id===selectedImprovement)&&list.dataset.renderedDetailSignature!==signature){
      await loadImprovement(selectedImprovement);list.dataset.renderedDetailSignature=signature;
    }
  }catch(e){toast(e.message);}
}
async function loadImprovement(id){
  const data=await api('/maintenance-requests/'+id);
  const detail=$('improvement-detail'),draft=detail.dataset.requestId===id?detail.querySelector('textarea')?.value||'':'';
  const signature=JSON.stringify([id,data]);
  if(detail.dataset.signature===signature)return;
  if(detail.dataset.requestId!==id)improvementNoteKey=crypto.randomUUID();
  detail.dataset.signature=signature;detail.dataset.requestId=id;
  selectedImprovement=id;
  detail.hidden=false;detail.replaceChildren();
  detail.append(el('p','eyebrow','접수된 개선 요청 · '+new Date(data.request.created_at).toLocaleString('ko-KR')),el('h2','',data.request.title),el('p','improvement-description',data.request.description));
  const notes=el('div','improvement-notes');notes.append(el('h3','','추가 내용'));
  if(!data.notes.length)notes.append(el('p','muted','아직 추가된 내용이 없습니다.'));
  for(const note of data.notes){const item=el('div','improvement-note');item.append(el('small','',new Date(note.created_at).toLocaleString('ko-KR')),el('p','',note.text));notes.append(item);}
  const form=el('form','improvement-note-form'),label=el('label','','이 요청에 내용 추가'),input=el('textarea');
  input.id='improvement-note';label.htmlFor=input.id;input.rows=3;input.maxLength=30000;input.required=true;input.value=draft;input.placeholder='생각난 내용이나 조건을 더 적어주세요.';
  form.append(label,input,el('button','primary','추가 내용 저장'));
  form.onsubmit=async event=>{event.preventDefault();const submit=form.querySelector('button');submit.disabled=true;try{await api('/maintenance-requests/'+id+'/notes',{text:input.value,key:improvementNoteKey});improvementNoteKey=crypto.randomUUID();input.value='';await loadImprovements();toast('추가 내용을 저장했습니다.');}catch(e){toast(e.message);}finally{submit.disabled=false;}};
  detail.append(notes,form);
  for(const card of $('improvement-list').querySelectorAll('.improvement-item'))card.classList.toggle('selected',card.dataset.requestId===id);
}
$('improvement-form').onsubmit=async event=>{
  event.preventDefault();const submit=event.submitter;submit.disabled=true;
  try{const result=await api('/maintenance-requests',{title:$('improvement-title').value,description:$('improvement-description').value,key:improvementKey});improvementKey=crypto.randomUUID();$('improvement-form').reset();selectedImprovement=result.request.id;await loadImprovements();toast('개선 요청을 접수했습니다. 자동 실행되지는 않습니다.');}
  catch(e){toast(e.message);}finally{submit.disabled=false;}
};
function renderLimits(){
  const c=$('limits-content');if(!c||!limitsState)return;c.replaceChildren();
  if(limitsState.account?.subscriptionType){const card=el('article','setting-card');card.append(el('p','eyebrow','ACCOUNT'),el('h2','',providerLabel(limitsState.provider)+' · '+limitsState.account.subscriptionType+' 구독'));c.append(card);}
  for(const window of limitsState.windows||[]){
    const used=Math.max(0,Math.min(100,Number(window.usedPercent)||0));
    const card=el('article','setting-card');
    card.append(el('p','eyebrow',window.label),el('h2','',String(Math.max(0,100-used))+'% 남음 · '+used+'% 사용'));
    const bar=el('div','limit-bar');bar.style.setProperty('--used',used+'%');card.append(bar);
    if(window.resetsAt)card.append(el('p','muted','초기화: '+new Date(window.resetsAt).toLocaleString('ko-KR')));
    c.append(card);
  }
  if(!limitsState.windows?.length)c.append(el('article','setting-card',limitsState.provider==='claude'?'아직 받은 사용량 정보가 없습니다. Claude 작업을 한 번 실행하면 표시됩니다.':'사용량 정보를 제공하지 않았습니다.'));
  const modelCard=el('article','setting-card');modelCard.append(el('p','eyebrow','AVAILABLE MODELS'));
  modelCard.append(el('h2','',limitsState.models?.length?limitsState.models.map(m=>m.label||m.id).join(', '):'모델 정보를 제공하지 않았습니다.'));c.append(modelCard);
}
let storageState=null;const measuring=new Set();
const archiveBar=el('div','archive-bar');archiveBar.hidden=true;
const archiveSummary=el('p','muted archive-summary');
const archiveSort=el('select');archiveSort.setAttribute('aria-label','보관 작업 정렬');archiveSort.append(new Option('최근 대화순','recent'),new Option('용량 큰 순','size'));archiveSort.onchange=()=>renderTasks();
archiveBar.append(archiveSummary,archiveSort);$('task-list').before(archiveBar);
function usageOf(task){try{return JSON.parse(task.archive_usage||'null');}catch{return null;}}
function usageText(u){
  if(!u)return '용량 계산 중';
  const parts=[['첨부',u.attachments],['대화 기록',u.session],['작업 기록',u.records]];
  if(!u.sharedFolder)parts.splice(1,0,['작업 폴더',u.workspace]);
  return '용량 '+formatFileSize(u.total)+' ('+parts.map(([label,bytes])=>label+' '+formatFileSize(bytes)).join(' · ')+')'+(u.sharedFolder?' · 프로젝트 폴더는 삭제하지 않음':'');
}
async function loadStorage(){try{storageState=await api('/storage');renderArchiveBar();}catch(e){toast(e.message);}}
function renderArchiveBar(){
  archiveBar.hidden=$('filter').value!=='archived';
  if(archiveBar.hidden||!storageState)return;
  const s=storageState;
  archiveSummary.textContent='보관 작업 '+s.archived.count+'개 · '+formatFileSize(s.archived.bytes)+' | DB '+formatFileSize(s.database)+' | 백업 '+s.backups.count+'개 · '+formatFileSize(s.backups.bytes)+' (최근 '+s.backupKeepDays+'일, 최소 '+s.backupKeepMin+'개 유지)';
}
// Tasks archived before sizes were recorded get measured once when the archive is shown.
async function measureMissing(tasks){
  for(const task of tasks){if(usageOf(task)||measuring.has(task.id))continue;measuring.add(task.id);try{await api('/tasks/'+task.id+'/usage',{});}catch(e){toast(e.message);}}
}
async function deleteTask(task){
  if(!confirm('"'+task.title+'" 작업을 완전히 삭제합니다.\n대화, 첨부, 작업 폴더, Claude 대화 기록이 지워지고 되돌릴 수 없습니다.\n(직접 고른 프로젝트 폴더는 지우지 않습니다)'))return;
  const result=await api('/tasks/'+task.id+'/delete',{confirm:task.id});
  if(selected===task.id){selected=null;conversation=null;$('chat-content').hidden=true;$('chat-empty').hidden=false;}
  await refresh();await loadStorage();
  toast(result.failed.length?'작업을 삭제했지만 파일 '+result.failed.length+'개는 지우지 못했습니다.':'작업을 삭제했습니다.');
}
function renderTasks(){
  const list=$('task-list');list.replaceChildren();const filter=$('filter').value;renderArchiveBar();
  // The archive is for finding what to clean up, so it always spans every space, like its storage summary.
  renderSpaceNotes();
  const tasks=state.tasks.filter(t=>(filter==='archived'||inSpace(t))&&(filter==='archived'?!!t.archived_at:!t.archived_at&&(filter==='all'||(filter==='completed'?t.status==='completed':t.status!=='completed'))));
  if(filter==='archived'){if(archiveSort.value==='size')tasks.sort((a,b)=>(usageOf(b)?.total||0)-(usageOf(a)?.total||0));void measureMissing(tasks);}
  if(!tasks.length){list.append(el('p','muted',filter==='archived'?'보관된 작업이 없습니다.':'이 조건에 맞는 작업이 없습니다.'));return;}
  for(const task of tasks){
    const card=button('',()=>selectTask(task.id),'task-card'+(selected===task.id?' selected':''));
    const lastMessageAt=task.last_message_at||task.created_at;
    const lastMessageTime=el('time','',new Date(lastMessageAt).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false}));lastMessageTime.dateTime=lastMessageAt;lastMessageTime.title='마지막 대화';
    const meta=el('span','meta');meta.append(el('span','badge '+(task.archived_at?'archived':task.status),task.archived_at?'보관됨':statusNames[task.status]||task.status),lastMessageTime);
    card.append(meta,el('span','title',task.title),el('span','preview',task.summary||task.goal),el('span','muted',profileLabel(task)),el('span','muted task-folder','📁 '+(task.folder||task.cwd)));
    if(task.archived_at)card.append(el('span','muted task-usage',usageText(usageOf(task))));
    const entry=el('div','task-entry');const actions=el('div','task-actions');
    if(!task.archived_at)actions.append(button('모델·effort 변경',()=>openModelSettings(task.id),'secondary task-model-edit'));
    actions.append(button(task.archived_at?'복원':'보관',()=>toggleArchive(task),'secondary task-archive-edit'));
    if(task.archived_at)actions.append(button('용량 다시 계산',async()=>{await api('/tasks/'+task.id+'/usage',{});await refresh();await loadStorage();},'secondary task-archive-edit'),button('삭제',()=>deleteTask(task),'secondary task-archive-edit task-delete'));
    entry.append(card,actions);list.append(entry);
  }
}
async function toggleArchive(task){
  await api('/tasks/'+task.id+'/'+(task.archived_at?'restore':'archive'),{});
  if(task.archived_at){$('filter').value='all';await refresh();await selectTask(task.id);toast('작업을 복원했습니다. 일시정지된 작업은 재개 버튼으로 이어갈 수 있습니다.');}
  else {if(selected===task.id){selected=null;$('chat-content').hidden=true;$('chat-empty').hidden=false;}await refresh();void loadStorage();toast('작업을 보관했습니다. 보관함에서 다시 볼 수 있습니다.');}
}
$('filter').onchange=()=>{renderTasks();if($('filter').value==='archived')void loadStorage();};
const renameDialog=el('dialog','rename-dialog');
renameDialog.setAttribute('aria-labelledby','rename-heading');
const renameForm=el('form');
const renameHeading=el('h2','','작업 이름 변경');renameHeading.id='rename-heading';
const renameLabel=el('label','','새 작업 이름');renameLabel.htmlFor='rename-title';
const renameInput=el('input');renameInput.id='rename-title';renameInput.required=true;renameInput.maxLength=150;renameInput.autocomplete='off';
const renameActions=el('div','rename-actions');
const renameSave=el('button','primary','저장');renameSave.type='submit';
renameActions.append(button('취소',()=>renameDialog.close()),renameSave);
renameForm.append(renameHeading,renameLabel,renameInput,renameActions);renameDialog.append(renameForm);document.body.append(renameDialog);
const renameButton=button('이름 변경',()=>{if(!selected)return;renameDialog.dataset.taskId=selected;renameInput.value=$('chat-title').textContent;renameDialog.showModal();renameInput.focus();renameInput.select();});
renameButton.id='rename-task';$('chat-title').after(renameButton);
const sessionSettings=el('p','muted session-settings');sessionSettings.id='session-settings';$('chat-title').after(sessionSettings);
const modelButton=button('모델·effort 변경',()=>openModelSettings(selected));modelButton.id='edit-task-model';sessionSettings.after(modelButton);
const modelDialog=el('dialog','rename-dialog model-dialog');modelDialog.setAttribute('aria-labelledby','model-heading');
const modelForm=el('form');const modelHeading=el('h2','','모델·effort 변경');modelHeading.id='model-heading';
const modelHelp=el('p','muted','저장한 설정은 다음 실행부터 적용됩니다. 진행 중인 실행은 그대로 이어집니다.');
const modelLabel=el('label','','모델');modelLabel.htmlFor='task-model-select';
const modelSelect=el('select');modelSelect.id='task-model-select';
const effortLabel=el('label','','effort');effortLabel.htmlFor='task-effort-select';
const effortSelect=el('select');effortSelect.id='task-effort-select';
const modelError=el('p','error');modelError.hidden=true;modelError.setAttribute('role','alert');
const modelActions=el('div','rename-actions');const modelSave=el('button','primary','저장');modelSave.type='submit';
modelActions.append(button('취소',()=>modelDialog.close()),modelSave);
modelForm.append(modelHeading,modelHelp,modelLabel,modelSelect,effortLabel,effortSelect,modelError,modelActions);modelDialog.append(modelForm);document.body.append(modelDialog);
let modelCatalog=[];
function populateEfforts(value='') {
  const model=modelSelect.value?modelCatalog.find(m=>m.id===modelSelect.value):modelCatalog.find(m=>m.isDefault);
  effortSelect.replaceChildren(new Option('자동 선택 · 추천 설정'+(model?.defaultEffort?' ('+model.defaultEffort+')':''),''),...(model?.efforts||[]).map(e=>new Option(e,e)));
  effortSelect.value=[...effortSelect.options].some(o=>o.value===value)?value:'';
}
modelSelect.onchange=()=>{populateEfforts(effortSelect.value);modelSave.disabled=!!modelSelect.value&&!modelCatalog.some(m=>m.id===modelSelect.value);};
async function openModelSettings(id) {
  if(!id||modelDialog.open)return;
  modelDialog.dataset.taskId=id;modelError.hidden=true;modelSave.disabled=true;modelSelect.disabled=true;effortSelect.disabled=true;
  modelSelect.replaceChildren(new Option('모델 목록을 불러오는 중',''));effortSelect.replaceChildren();modelDialog.showModal();
  try {
    const detail=await api('/tasks/'+id);
    const catalog=await api('/models?provider='+encodeURIComponent(detail.task.provider_id));
    if(!modelDialog.open||modelDialog.dataset.taskId!==id)return;
    modelCatalog=catalog.models;
    modelSelect.replaceChildren(new Option('자동 선택 · 추천 설정',''),...modelCatalog.map(m=>new Option(m.label||m.id,m.id)));
    const unavailable=!!detail.task.model&&!modelCatalog.some(m=>m.id===detail.task.model);
    if(unavailable){const option=new Option(detail.task.model+' (사용 불가)',detail.task.model);option.disabled=true;modelSelect.add(option);modelError.textContent='기존 모델을 사용할 수 없습니다. 자동 선택이나 다른 모델을 선택해 주세요.';modelError.hidden=false;}
    modelSelect.value=detail.task.model||'';populateEfforts(detail.task.effort||'');modelSave.disabled=unavailable;modelSelect.disabled=false;effortSelect.disabled=false;modelSelect.focus();
  } catch(e) {modelError.textContent=e.message;modelError.hidden=false;}
}
modelForm.onsubmit=async e=>{
  e.preventDefault();const id=modelDialog.dataset.taskId;modelSave.disabled=true;modelError.hidden=true;
  try {await api('/tasks/'+id+'/settings',{model:modelSelect.value||null,effort:effortSelect.value||null});modelDialog.close();await refresh();toast('모델·effort를 저장했습니다. 다음 실행부터 적용됩니다.');}
  catch(e) {modelError.textContent=e.message;modelError.hidden=false;}finally{modelSave.disabled=false;}
};
renameForm.onsubmit=async e=>{
  e.preventDefault();const id=renameDialog.dataset.taskId;renameSave.disabled=true;
  try{await api('/tasks/'+id+'/rename',{title:renameInput.value});renameDialog.close();await refresh();toast('작업 이름을 변경했습니다.');}
  catch(e){toast(e.message);}finally{renameSave.disabled=false;}
};
async function selectTask(id){if(selected!==id)conversation=null;selected=id;showView('tasks');renderTasks();await loadTask(id);if(innerWidth<1100&&selected===id)$('chat-content').scrollIntoView({behavior:'smooth',block:'start'});}
function renderMessages(id,mode='refresh'){
  if(selected!==id||conversation?.taskId!==id)return;
  const container=$('messages');
  const signature=JSON.stringify([id,conversation.hasMore,conversation.messages]);
  if(container.dataset.signature===signature)return;
  const oldHeight=container.scrollHeight,oldTop=container.scrollTop;
  const wasBottom=oldHeight-oldTop-container.clientHeight<70;
  container.dataset.signature=signature;container.replaceChildren();
  if(conversation.hasMore)container.append(button('이전 대화 더 보기',()=>loadOlderMessages(id),'secondary history-more'));
  for(const m of conversation.messages){const item=el('div','message '+m.role);item.append(el('small','',m.role==='user'?'나'+(m.state==='pending'?' · 다음 실행에 반영':m.state==='uncertain'?' · 전달 확인 필요':''):providerLabel(conversation.providerId)),markdown(m.text,'text'));appendMessageAttachments(item,m.attachments);container.append(item);}
  if(mode==='prepend')container.scrollTop=oldTop+container.scrollHeight-oldHeight;
  else if(mode==='initial'||wasBottom)container.scrollTop=container.scrollHeight;
  else container.scrollTop=oldTop;
}
async function loadOlderMessages(id){
  const current=conversation;
  if(selected!==id||current?.taskId!==id||!current.hasMore||!current.nextBefore)return;
  const page=await api('/tasks/'+id+'/messages?before='+current.nextBefore);
  if(selected!==id||conversation!==current)return;
  const byId=new Map([...page.messages,...current.messages].map(m=>[m.id,m]));
  current.messages=[...byId.values()].sort((a,b)=>a.id-b.id);
  current.hasMore=page.hasMore;current.nextBefore=page.nextBefore;
  renderMessages(id,'prepend');
}
async function loadTask(id){const detail=await api('/tasks/'+id);if(selected!==id)return;const t=detail.task;$('chat-empty').hidden=true;$('chat-content').hidden=false;$('chat-id').textContent='#'+id+' · '+(t.archived_at?'보관됨':statusNames[t.status]||t.status);$('chat-title').textContent=t.title;$('session-settings').textContent=profileLabel(t)+' · 📁 '+(state.tasks.find(x=>x.id===id)?.folder||t.cwd);$('task-error').textContent=t.error;$('task-error').hidden=!t.error;
  const initial=conversation?.taskId!==id;
  if(initial)conversation={taskId:id,providerId:t.provider_id,messages:detail.messages,hasMore:detail.hasMore,nextBefore:detail.nextBefore};
  else {const byId=new Map([...conversation.messages,...detail.messages].map(m=>[m.id,m]));conversation.messages=[...byId.values()].sort((a,b)=>a.id-b.id);}
  renderMessages(id,initial?'initial':'refresh');
  const artifactData=await api('/tasks/'+id+'/files');if(selected!==id)return;
  const artifacts=$('artifacts'),artifactSignature=JSON.stringify([id,artifactData]);
  if(artifacts.dataset.taskId!==id){
    if(artifacts.dataset.taskId)artifactOpenByTask.set(artifacts.dataset.taskId,artifacts.open);
    artifacts.dataset.taskId=id;artifacts.open=artifactOpenByTask.get(id)??false;
  }
  if(artifacts.dataset.signature!==artifactSignature){
    artifacts.dataset.signature=artifactSignature;artifacts.replaceChildren();artifacts.hidden=!artifactData.files.length;
    if(artifactData.files.length){
      const heading=el('summary','artifact-summary','결과 파일 '+artifactData.files.length+'개');
      const body=el('div','artifact-body');body.append(el('p','muted','output 폴더의 전달용 파일만 표시합니다. 파일을 누르면 휴대폰에 다운로드됩니다.'));
      const list=el('div','artifact-list');
      for(const f of artifactData.files){
        const row=el('div','artifact-row'),info=el('div','artifact-info'),name=el('strong','',f.path),size=el('small','',formatFileSize(f.size)+' · 수정 '+new Date(f.modifiedAt).toLocaleString('ko-KR'));
        const link=el('a','artifact-download','다운로드');link.href='/api/tasks/'+id+'/files?path='+encodeURIComponent(f.path);link.download=f.path.split('/').pop();link.setAttribute('aria-label',f.path+' 다운로드');
        info.append(name,size);row.append(info,link);list.append(row);
      }
      body.append(list);
      if(artifactData.truncated)body.append(el('p','muted','파일이 많아 일부만 표시했습니다.'));
      artifacts.append(heading,body);
    }
  }
  $('task-path').textContent='작업 폴더: '+t.cwd;$('task-events').textContent=detail.events.map(e=>new Date(e.created_at).toLocaleString('ko-KR')+' · '+e.kind+'\n'+e.detail).join('\n\n');
  $('message-form').hidden=!!t.archived_at;$('pause-task').disabled=!!t.archived_at||!['running','queued','waiting_approval','waiting','rate_limited'].includes(t.status);$('resume-task').disabled=!!t.archived_at||!['paused','recovery','failed'].includes(t.status);const canSteer=providerInfo(t.provider_id)?.capabilities?.steer!==false;$('steer').disabled=!!t.archived_at||t.status!=='running'||!canSteer;$('steer').parentElement.title=canSteer?'':providerLabel(t.provider_id)+' 작업은 즉시 반영을 지원하지 않습니다.';if(t.status!=='running'||!canSteer)$('steer').checked=false;
}
function formatFileSize(bytes){if(bytes<1024)return bytes+' B';const unit=bytes<1048576?'KB':bytes<1073741824?'MB':'GB';const divisor=unit==='KB'?1024:unit==='MB'?1048576:1073741824;return (bytes/divisor).toFixed(1)+' '+unit;}
function renderDecisions(){const container=$('decisions');const sig=JSON.stringify([state.decisions,state.tasks.map(t=>[t.id,t.title,t.goal,t.summary])]);if(container.dataset.signature===sig)return;const drafts=Object.fromEntries([...container.querySelectorAll('textarea')].map(x=>[x.id,x.value]));container.dataset.signature=sig;container.replaceChildren();if(!state.decisions.length){container.append(el('div','empty','지금은 결정이 필요한 항목이 없습니다.'));return;}
  for(const d of state.decisions){const card=el('article','decision');const task=state.tasks.find(t=>t.id===d.task_id);card.append(el('p','eyebrow',(d.kind==='approval'?'실행 권한 요청':'방향 결정')+' · '+(task?.title||d.task_id)));
    const background=d.payload.background?.trim()||d.payload.context?.trim()||[task?.goal&&'요청: '+task.goal.slice(0,700),task?.summary&&'현재까지: '+task.summary.slice(0,1000)].filter(Boolean).join('\n\n');
    card.append(el('h2','',d.payload.title?.trim()||task?.title||d.question));
    if(background)card.append(el('p','decision-section-title','결정이 필요해진 배경'),markdown(background,'decision-context'));
    card.append(el('p','decision-section-title','결정할 질문'),el('p','decision-question',d.question));
    if(d.kind==='business'&&d.payload.options?.length){
      card.append(el('p','decision-section-title','선택지별 실행 내용과 장단점'));
      const optionList=el('div','decision-option-list');
      for(const option of d.payload.options){
        const detail=d.payload.optionDetails?.find(item=>item.option===option);
        const item=el('section','decision-option');item.append(el('h3','',option));
        if(detail){for(const [label,value] of [['선택하면 수행할 작업',detail.action],['장점',detail.pros],['단점·남는 일',detail.cons]])item.append(el('strong','',label),el('p','',value||'기록된 내용이 없습니다.'));}
        else item.append(el('p','muted','이 선택지의 상세 설명은 이전 결정 기록에 없습니다.'));
        optionList.append(item);
      }
      card.append(optionList);
    }
    if(d.kind==='approval'){const details=el('pre','request-detail',JSON.stringify(d.payload,null,2));card.append(details);}
    const actions=el('div','actions');const answer=async text=>{await api('/decisions/'+d.id,{answer:text});toast('답변을 반영했습니다.');await refresh();};
    if(d.kind==='approval'&&d.payload.kind==='execution'){actions.append(button('이 동작 허용',()=>answer('accept'),'primary'),button('거절',()=>answer('decline')));}
    else {for(const option of d.payload.options||[])actions.append(button(option,()=>answer(option)));const input=el('textarea');input.id='answer-'+d.id;input.placeholder=d.payload.questions?.length>1?'질문 ID별 JSON 답변: {"id":"답변"}':'선택하거나 직접 답변을 적어주세요.';input.value=drafts[input.id]||'';card.append(input);actions.append(button('답변 보내기',()=>answer(input.value),'primary'));}
    actions.append(button('작업 대화 보기',()=>selectTask(d.task_id)));card.append(actions);container.append(card);
  }
}
$('login-form').onsubmit=async e=>{e.preventDefault();try{const value=$('login-code').value.trim();await api('/login',value.length===8?{code:value}:{token:value});$('login-code').value='';await connect();}catch(e){toast(e.message);}};
$('inbox-form').onsubmit=async e=>{e.preventDefault();const text=$('inbox-text').value.trim();if(!text&&!attachmentQueues.inbox.length){$('inbox-text').focus();return;}$('send-inbox').disabled=true;try{const attachments=await uploadAttachments('inbox');const result=await api('/inbox',{text,target:$('inbox-target').value,provider:$('inbox-provider').value||undefined,space:currentSpace==='other'?'all':currentSpace,profile:$('inbox-profile').value,attachments,key:inboxKey});if(result.needsChoice){$('routing-hint').textContent=result.reason+' — 대상 목록에서 새 작업 또는 기존 작업을 선택하세요.';return;}$('inbox-text').value='';attachmentQueues.inbox=[];renderAttachmentQueue('inbox');$('routing-hint').textContent=result.action==='new'?'새 작업을 등록했습니다.':'기존 작업에 지시를 추가했습니다.';inboxKey=crypto.randomUUID();await refresh();await selectTask(result.taskId);}catch(e){toast(e.message);}finally{$('send-inbox').disabled=false;}};
$('inbox-text').oninput=()=>{inboxKey=crypto.randomUUID();};
$('message-form').onsubmit=async e=>{e.preventDefault();if(!selected)return;const text=$('reply').value.trim();if(!text&&!attachmentQueues.reply.length){$('reply').focus();return;}const b=e.submitter;b.disabled=true;try{const attachments=await uploadAttachments('reply');await api('/tasks/'+selected+($('steer').checked?'/steer':'/messages'),{text,attachments,key:replyKey});$('reply').value='';attachmentQueues.reply=[];renderAttachmentQueue('reply');replyKey=crypto.randomUUID();await refresh();}catch(e){toast(e.message);}finally{b.disabled=false;}};
$('reply').oninput=()=>{replyKey=crypto.randomUUID();};
for(const action of ['pause','resume'])$(action+'-task').onclick=async()=>{try{await api('/tasks/'+selected+'/'+action,{});await refresh();}catch(e){toast(e.message);}};
$('pause-all').onclick=async()=>{try{await api('/pause',{paused:!state.paused});await refresh();}catch(e){toast(e.message);}};
$('make-report').onclick=async()=>{try{await api('/digest',{});await refresh();}catch(e){toast(e.message);}};
$('pair').onclick=async()=>{try{const p=await api('/pair',{});$('pair-code').textContent=p.code;setTimeout(()=>$('pair-code').textContent='만료됨',300000);}catch(e){toast(e.message);}};
let pushSyncPromise=null;
function syncPushSubscription(){
  if(!pushSyncPromise)pushSyncPromise=registerPushSubscription().finally(()=>{pushSyncPromise=null;});
  return pushSyncPromise;
}
async function registerPushSubscription(){
  if(!state?.pushAvailable)throw new Error('서버에서 Push 알림을 사용할 수 없습니다.');
  if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))throw new Error('이 브라우저에서는 Push 알림을 지원하지 않습니다.');
  if(Notification.permission!=='granted')throw new Error('이 기기에서 알림을 허용한 뒤 다시 시도하세요.');
  const registration=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;
  const raw=atob(state.vapidPublicKey.replace(/-/g,'+').replace(/_/g,'/'));const key=Uint8Array.from(raw,c=>c.charCodeAt(0));
  const subscription=await registration.pushManager.getSubscription()||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
  await api('/push/subscribe',{subscription:subscription.toJSON()});
  $('push-status').textContent='서버 Push 연결됨 · 정기 보고와 결정 대기 알림을 받습니다.';
  return subscription;
}
async function sendPushTest(){
  let subscription=await syncPushSubscription();
  try{await api('/push/test',{endpoint:subscription.endpoint});}
  catch(e){
    if(!e.message.includes('Push 구독이 만료'))throw e;
    await subscription.unsubscribe();subscription=await syncPushSubscription();
    await api('/push/test',{endpoint:subscription.endpoint});
  }
}
function refreshPushConnection(){
  if(!('Notification' in window))return;
  if(Notification.permission==='granted'&&!$('workspace').hidden)void syncPushSubscription().catch(e=>{$('push-status').textContent='알림 연결 실패: '+e.message;});
  else if(Notification.permission==='denied')$('push-status').textContent='알림이 차단돼 있습니다. Android 앱 알림과 사이트 알림 설정을 확인하세요.';
  else $('push-status').textContent='이 기기 알림 켜기를 눌러 Push를 연결하세요.';
}
$('enable-push').onclick=async()=>{try{if(!('Notification' in window))throw new Error('이 브라우저에서는 알림을 지원하지 않습니다.');const permission=await Notification.requestPermission();if(permission!=='granted')throw new Error('이 기기에서 알림을 허용하세요.');await sendPushTest();toast('서버에서 이 기기로 테스트 알림을 전송했습니다.');}catch(e){$('push-status').textContent='알림 연결 실패: '+e.message;toast(e.message);}};
$('test-push').onclick=async()=>{try{await sendPushTest();toast('서버에서 이 기기로 테스트 알림을 전송했습니다.');}catch(e){$('push-status').textContent='알림 테스트 실패: '+e.message;toast(e.message);}};
async function connect(){await refresh();if($('workspace').hidden)return;void loadWorkspaces();eventSource?.close();eventSource=new EventSource('/api/events');eventSource.onmessage=()=>{clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,150);};eventSource.onerror=()=>{$('connection').textContent='연결 복구 중';};refreshPushConnection();}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state)refreshPushConnection();});
if(navigator.permissions?.query)navigator.permissions.query({name:'notifications'}).then(permission=>{permission.onchange=()=>{if(state)refreshPushConnection();};}).catch(()=>{});
navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='show-view'&&event.data.view==='decisions')showView('decisions');});
async function boot(){if(new URLSearchParams(location.search).get('view')==='decisions')showView('decisions');const token=location.hash.slice(1);if(token){history.replaceState(null,'',location.pathname+location.search);try{await api('/login',{token});}catch(e){toast(e.message);}}await connect();if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});}
void boot();
