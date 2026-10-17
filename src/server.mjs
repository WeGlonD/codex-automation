import http from 'node:http';
import { readFileSync,writeFileSync,existsSync,statSync,mkdirSync,createReadStream } from 'node:fs';
import { join,sep } from 'node:path';
import { backup } from 'node:sqlite';
import { randomBytes,randomInt,createHmac,timingSafeEqual } from 'node:crypto';
import { Store } from './store.mjs';
import { CodexRPC } from './providers/codex-rpc.mjs';
import { CodexProvider } from './providers/codex.mjs';
import { ClaudeProvider } from './providers/claude.mjs';
import { Engine } from './engine.mjs';
import { root,dataDir,config,accessToken,checkedWorkspace } from './config.mjs';
import { receiveAttachment } from './attachments.mjs';
import { listOutputFiles,resolveOutputFile } from './artifacts.mjs';

const store=new Store(join(dataDir,'automation.sqlite'));
const factories={
  codex:()=>new CodexProvider(new CodexRPC(config.codexCommand)),
  claude:()=>new ClaudeProvider({stateFile:join(dataDir,'claude-rate-limits.json')})
};
const providers=config.providers.filter(id=>factories[id]).map(id=>factories[id]());
const engine=new Engine(store,providers,config,checkedWorkspace);
// The provider named in a request, or the default one; tasks always use their own stored provider.
function providerFor(id) {return engine.providerFor(id||engine.defaultProviderId);}
async function connectProviders() {await Promise.allSettled(providers.map(p=>p.start()));engine.changed();}
const clients=new Set();const loginAttempts=new Map();const inFlight=new Map();
let pairing=null;let closing=false;let webpush=null;
try {webpush=(await import('web-push')).default;} catch {}
if(webpush) {
  if(!store.setting('vapid',null)) store.set('vapid',webpush.generateVAPIDKeys());
  const keys=store.setting('vapid');webpush.setVapidDetails(publicOrigin()||'https://codex-automation.local',keys.publicKey,keys.privateKey);
}
function equal(a,b) {const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);}
function signature(value) {return createHmac('sha256',accessToken).update(value).digest('hex');}
function session() {const value=Date.now()+'.'+randomBytes(12).toString('hex');return value+'.'+signature(value);}
function authenticated(req) {
  if(equal(req.headers.authorization,'Bearer '+accessToken)) return true;
  const token=(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('session='))?.slice(8);
  if(!token) return false;const parts=token.split('.');
  return parts.length===3&&Date.now()-Number(parts[0])<30*86400000&&Number(parts[0])<=Date.now()&&equal(signature(parts[0]+'.'+parts[1]),parts[2]);
}
function publicOrigin() {return store.setting('publicOrigin',config.publicOrigin||'');}
function knownHost(req) {
  const allowed=new Set(['127.0.0.1:'+config.port,'localhost:'+config.port]);
  if(publicOrigin()) allowed.add(new URL(publicOrigin()).host);
  return allowed.has(req.headers.host);
}
function originOK(req) {
  if(!req.headers.origin) return !req.headers.cookie||equal(req.headers.authorization,'Bearer '+accessToken);
  const allowed=['http://127.0.0.1:'+config.port,'http://localhost:'+config.port,publicOrigin()];
  return allowed.includes(req.headers.origin);
}
function json(res,status,data,headers={}) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data));}
async function body(req) {let text='';for await(const chunk of req){text+=chunk;if(text.length>128000)throw new Error('입력이 너무 큽니다.');}return text?JSON.parse(text):{};}
function cookie(req) {return 'session='+session()+'; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000'+(req.headers.host===new URL(publicOrigin()||'http://localhost').host?'; Secure':'');}
async function pushNotice(title,body,{url='/',tag='codex-digest',onlyEndpoint=null}={}) {
  if(!webpush) return false;
  const subscriptions=store.setting('pushSubscriptions',[]).filter(sub=>!onlyEndpoint||sub.endpoint===onlyEndpoint);const expired=[];let failed=false;
  if(!subscriptions.length) return false;
  await Promise.allSettled(subscriptions.map(async sub=>{
    try {await webpush.sendNotification(sub,JSON.stringify({title,body,url,tag}),{TTL:86400,timeout:15000});}
    catch(e) {if([404,410].includes(e.statusCode))expired.push(sub.endpoint);else {failed=true;store.event(null,'push_error',String(e.statusCode||e.code||'network error'));}}
  }));
  if(expired.length) store.set('pushSubscriptions',store.setting('pushSubscriptions',[]).filter(s=>!expired.includes(s.endpoint)));
  return !failed&&subscriptions.length>expired.length;
}
let delivering=false,deliveryTimer=null;
function scheduleDelivery(){if(deliveryTimer||closing)return;deliveryTimer=setTimeout(()=>{deliveryTimer=null;void deliverQueuedNotices();},500);deliveryTimer.unref();}
engine.on('change',()=>{ for(const res of clients) res.write('data: update\n\n');scheduleDelivery(); });
async function deliverQueuedNotices(){
  if(delivering||closing)return;delivering=true;
  try {
    for(const entry of store.outbox()) {
      const notice=JSON.parse(entry.text);
      if(Date.now()-Date.parse(entry.created_at)>(notice.decisionId?86400000:7200000)){store.sent(entry.id);continue;}
      if(notice.decisionId){const decision=store.decisions().find(d=>d.id===notice.decisionId);if(!decision||store.get(decision.task_id)?.archived_at){store.sent(entry.id);continue;}}
      if(await pushNotice(notice.title,notice.body,{url:notice.url,tag:notice.tag}))store.sent(entry.id);else break;
    }
  } catch(e){store.event(null,'push_error',e.message);} finally{delivering=false;}
}
const maintenance=setInterval(async()=>{
  if(closing)return;
  try {
    store.pruneUnsentAttachments();
    await deliverQueuedNotices();
    const date=new Date().toISOString().slice(0,10);
    if(store.setting('lastBackup','')!==date) {
      const dir=join(dataDir,'backups');mkdirSync(dir,{recursive:true});
      await backup(store.db,join(dir,'automation-'+date+'.sqlite'));store.set('lastBackup',date);
    }
  } catch(e){store.event(null,'maintenance_error',e.message);}
},30000);maintenance.unref();
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if(!knownHost(req)) {json(res,403,{error:'Unknown host'});return;}
  const url=new URL(req.url,'http://localhost');
  try {
    if(req.method==='GET'&&url.pathname==='/health') {json(res,200,{ok:true,version:'0.1.0',codexConnected:!!engine.providers.get('codex')?.connected,provider:engine.defaultProviderId,providers:providers.map(p=>({id:p.id,connected:!!p.connected}))});return;}
    const assets={'/':'index.html','/app.js':'app.js','/style.css':'style.css','/sw.js':'sw.js','/manifest.webmanifest':'manifest.webmanifest','/icon.svg':'icon.svg'};
    if(req.method==='GET'&&assets[url.pathname]) {
      const file=assets[url.pathname];const ext=file.split('.').pop();
      res.writeHead(200,{'Content-Type':({html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',webmanifest:'application/manifest+json',svg:'image/svg+xml'})[ext],'Cache-Control':'no-cache'});
      res.end(readFileSync(join(root,'public',file)));return;
    }
    if(req.method!=='GET'&&!originOK(req)) {json(res,403,{error:'Cross-origin request rejected'});return;}
    if(req.method==='POST'&&url.pathname==='/api/login') {
      const key=req.socket.remoteAddress;const attempts=loginAttempts.get(key)||{count:0,reset:Date.now()+60000};
      if(attempts.reset<Date.now()){attempts.count=0;attempts.reset=Date.now()+60000;}
      if(++attempts.count>10){json(res,429,{error:'1분 후 다시 시도하세요.'});return;}loginAttempts.set(key,attempts);
      const input=await body(req);const byToken=equal(input.token,accessToken);const byPair=pairing&&Date.now()<pairing.expires&&equal(input.code,pairing.code);
      if(!byToken&&!byPair){json(res,401,{error:'접속 코드가 잘못되었거나 만료되었습니다.'});return;}
      if(byPair)pairing=null;json(res,200,{ok:true},{'Set-Cookie':cookie(req)});return;
    }
    if(!authenticated(req)){json(res,401,{error:'로그인이 필요합니다.'});return;}
    if(req.method==='POST'&&url.pathname==='/api/attachments') {
      const attachment=await receiveAttachment(store,req,url.searchParams.get('name'));json(res,201,attachment);return;
    }
    const attachmentMatch=url.pathname.match(/^\/api\/attachments\/([a-f0-9-]{36})$/);
    if(req.method==='GET'&&attachmentMatch) {
      const file=store.attachment(attachmentMatch[1],true);if(!file){json(res,404,{error:'첨부 파일을 찾을 수 없습니다.'});return;}
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':file.size,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.name),'Cache-Control':'no-store'});res.end(Buffer.from(file.content));return;
    }
    if(req.method==='GET'&&url.pathname==='/api/events') {
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write('data: update\n\n');clients.add(res);
      const timer=setInterval(()=>res.write(': heartbeat\n\n'),20000);req.on('close',()=>{clearInterval(timer);clients.delete(res);});return;
    }
    if(req.method==='GET'&&url.pathname==='/api/state') {json(res,200,{...engine.snapshot(),publicOrigin:publicOrigin(),pushAvailable:!!webpush,vapidPublicKey:store.setting('vapid',{}).publicKey});return;}
    if(req.method==='GET'&&url.pathname==='/api/limits') {const provider=providerFor(url.searchParams.get('provider'));await provider.start();const limits=await provider.usage();const models=await provider.models();json(res,200,{...limits,provider:provider.id,account:provider.account?{subscriptionType:provider.account.subscriptionType||null}:null,models,updatedAt:new Date().toISOString()});return;}
    const artifactMatch=url.pathname.match(/^\/api\/tasks\/([a-f0-9]{8})\/files$/);
    if(req.method==='GET'&&artifactMatch){
      const task=engine.getTask(artifactMatch[1]);const base=checkedWorkspace(task.cwd);
      const requested=url.searchParams.get('path');
      if(requested){
        const file=resolveOutputFile(base,requested);
        const size=statSync(file).size;
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':size,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(file.split(sep).pop()),'Cache-Control':'no-store'});
        const stream=createReadStream(file);stream.on('error',error=>res.destroy(error));res.on('close',()=>stream.destroy());stream.pipe(res);return;
      }
      json(res,200,listOutputFiles(base));return;
    }
    if(req.method==='GET'&&url.pathname==='/api/models') {json(res,200,{models:await engine.models(providerFor(url.searchParams.get('provider')).id)});return;}
    if(req.method==='POST'&&url.pathname==='/api/providers/reconnect') {for(const p of providers)if(!p.connected)p.failedAt=0;await connectProviders();json(res,200,{providers:engine.snapshot().providers});return;}
    if(req.method==='GET'&&url.pathname==='/api/maintenance-requests') {json(res,200,{requests:store.maintenanceRequests()});return;}
    const maintenanceMatch=url.pathname.match(/^\/api\/maintenance-requests\/([a-f0-9]{8})(?:\/notes)?$/);
    if(req.method==='GET'&&maintenanceMatch&&!url.pathname.endsWith('/notes')) {
      const request=store.maintenanceRequest(maintenanceMatch[1]);if(!request)throw new Error('개선 요청을 찾을 수 없습니다.');
      json(res,200,{request,notes:store.maintenanceNotes(request.id)});return;
    }
    const taskMatch=url.pathname.match(/^\/api\/tasks\/([a-f0-9]{8})(?:\/(messages|pause|resume|steer|rename|settings|archive|restore))?$/);
    if(taskMatch&&req.method==='GET'&&(!taskMatch[2]||taskMatch[2]==='messages')) {
      const task=engine.getTask(taskMatch[1]);
      const rawBefore=url.searchParams.get('before');
      const before=rawBefore===null?null:Number(rawBefore);
      if(rawBefore!==null&&(!/^\d+$/.test(rawBefore)||!Number.isSafeInteger(before)||before<1))throw new Error('잘못된 대화 페이지입니다.');
      const page=store.messagesPage(task.id,before);
      const messagePage={messages:page.messages.map(m=>({...m,attachments:store.messageAttachments(m.id)})),hasMore:page.hasMore,nextBefore:page.nextBefore};
      if(taskMatch[2]==='messages'){json(res,200,messagePage);return;}
      json(res,200,{task,...messagePage,events:store.events(task.id),decisions:store.decisions(false).filter(d=>d.task_id===task.id)});return;
    }
    if(req.method!=='POST'){json(res,404,{error:'Not found'});return;}
    const input=await body(req);
    if(url.pathname==='/api/maintenance-requests'||(maintenanceMatch&&url.pathname.endsWith('/notes'))) {
      const key=String(input.key||'');if(!/^[a-zA-Z0-9-]{16,80}$/.test(key))throw new Error('요청 ID가 필요합니다.');
      const result=url.pathname==='/api/maintenance-requests'
        ? store.once('maintenance:create:'+key,()=>({request:store.createMaintenanceRequest(input.title,input.description)}))
        : store.once('maintenance:note:'+maintenanceMatch[1]+':'+key,()=>({note:store.addMaintenanceNote(maintenanceMatch[1],input.text)}));
      for(const client of clients)client.write('data: update\n\n');
      json(res,200,result);return;
    }
    if(url.pathname==='/api/tasks') {json(res,201,engine.create(input));return;}
    if(url.pathname==='/api/inbox') {
      const attachmentIds=input.attachments||[];
      const text=String(input.text||(attachmentIds.length?'첨부 파일을 확인해주세요.':'')).trim();if(!text||text.length>30000)throw new Error('지시를 입력하세요.');
      const key=String(input.key||'');if(!/^[a-zA-Z0-9-]{16,80}$/.test(key))throw new Error('요청 ID가 필요합니다.');
      const previous=store.db.prepare('SELECT result FROM inbox WHERE key=?').get(key);
      if(previous){json(res,200,JSON.parse(previous.result));return;}
      if(inFlight.has(key)){json(res,200,await inFlight.get(key));return;}
      store.validateAttachments(attachmentIds);
      const selected=providerFor(input.provider);
      const work=(async()=>{
        const route=input.target==='new'?{action:'new',title:text.slice(0,60),text}:input.target?{action:'existing',taskId:input.target,text}:await selected.classifyTask(store.list().filter(task=>!task.archived_at),text,attachmentIds.map(id=>store.attachment(id).name));
        if(route.action==='ask')return {needsChoice:true,reason:route.reason};
        return store.once(key,()=>{
          if(route.action==='existing'){engine.message(route.taskId,route.text,attachmentIds);return {taskId:route.taskId,action:'existing',reason:route.reason};}
          const task=engine.create({goal:route.text,title:route.title,profile:input.profile,provider:selected.id,attachments:attachmentIds});return {taskId:task.id,action:'new',reason:route.reason};
        });
      })();inFlight.set(key,work);
      try{json(res,200,await work);}finally{inFlight.delete(key);}return;
    }
    if(taskMatch) {
      const [,id,action]=taskMatch;
      if(action==='messages') {
        if(input.key&&!/^[a-zA-Z0-9-]{16,80}$/.test(input.key))throw new Error('잘못된 요청 ID입니다.');
        const send=()=>{engine.message(id,input.text,input.attachments||[]);return {ok:true};};
        if(input.key)store.once('message:'+id+':'+input.key,send);else send();
      }
      else if(action==='pause')await engine.pause(id);
      else if(action==='resume')engine.resume(id);
      else if(action==='steer')await engine.steer(id,input.text,input.attachments||[]);
      else if(action==='rename')engine.rename(id,input.title);
      else if(action==='settings')await engine.configureTask(id,input);
      else if(action==='archive')await engine.archive(id);
      else if(action==='restore')engine.restore(id);
      else throw new Error('알 수 없는 작업 동작');json(res,200,{ok:true});return;
    }
    const decisionMatch=url.pathname.match(/^\/api\/decisions\/([a-f0-9]{8})$/);
    if(decisionMatch){await engine.decide(decisionMatch[1],input.answer);json(res,200,{ok:true});return;}
    if(url.pathname==='/api/pause'){store.set('paused',!!input.paused);if(input.paused)await Promise.allSettled([...engine.active.keys()].map(id=>engine.pause(id)));engine.changed();json(res,200,{ok:true});return;}
    if(url.pathname==='/api/digest'){json(res,200,{text:engine.digest(true)});return;}
    if(url.pathname==='/api/pair'){pairing={code:String(randomInt(10000000,100000000)),expires:Date.now()+300000};json(res,200,pairing);return;}
    if(url.pathname==='/api/push/subscribe'){
      if(!webpush)throw new Error('Web Push 모듈이 설치되지 않았습니다.');
      const sub=input.subscription;const endpoint=new URL(sub?.endpoint);
      // Only browser vendor push services; never permit arbitrary server-side requests.
      if(endpoint.protocol!=='https:'||!['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].some(host=>endpoint.hostname===host||endpoint.hostname.endsWith('.'+host)))throw new Error('지원하지 않는 Push 서버');
      if(!sub.keys?.p256dh||!sub.keys?.auth)throw new Error('잘못된 Push 구독');
      const subscriptions=store.setting('pushSubscriptions',[]).filter(s=>s.endpoint!==sub.endpoint);if(subscriptions.length>=10)throw new Error('최대 10개 기기까지 연결할 수 있습니다.');
      store.set('pushSubscriptions',[...subscriptions,sub]);json(res,200,{ok:true});scheduleDelivery();return;
    }
    if(url.pathname==='/api/push/test'){const delivered=await pushNotice('Codex 서버 Push 테스트','서버에서 실제 Push 전송이 완료되었습니다.',{tag:'codex-test',onlyEndpoint:input.endpoint||null});if(!delivered)throw new Error('이 기기의 Push 구독이 만료됐거나 전송하지 못했습니다. 알림 연결을 다시 시도하세요.');json(res,200,{ok:true});return;}
    if(url.pathname==='/api/shutdown'){json(res,200,{ok:true});void shutdown();return;}
    json(res,404,{error:'Not found'});
  } catch(e) {json(res,400,{error:e.message});}
});
server.requestTimeout=120000;
async function shutdown(){if(closing)return;closing=true;await engine.stop();for(const res of clients)res.end();server.close(()=>{store.close();process.exit(0);});setTimeout(()=>process.exit(0),5000).unref();}
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
server.on('error',e=>{console.error(e.message);process.exit(1);});
server.listen(config.port,config.host,()=>{
  writeFileSync(join(dataDir,'open-dashboard.html'),'<!doctype html><meta charset="utf-8"><title>Codex Automation</title><script>location.replace('+JSON.stringify('http://127.0.0.1:'+config.port+'/#'+accessToken)+')</script>',{mode:0o600});
  console.log('Codex Automation: http://127.0.0.1:'+config.port);engine.start();store.ensureDecisionNotices();scheduleDelivery();void connectProviders();
});
