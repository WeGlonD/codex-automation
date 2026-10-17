import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {ClaudeProvider,isRateLimitError} from '../src/providers/claude.mjs';

// Stands in for @anthropic-ai/claude-agent-sdk: each query() is a controllable message stream.
class FakeSDK {
  queries=[];sessions=new Set();
  query=({prompt,options})=>{
    const messages=[];let wake=null,ended=false,failure=null;
    const q={prompt,options,interrupted:false,closed:false,
      push(message){messages.push(message);wake?.();},
      end(){ended=true;wake?.();},
      fail(error){failure=error;wake?.();},
      async interrupt(){q.interrupted=true;q.push({type:'result',subtype:'error_during_execution',is_error:true,errors:['interrupted'],session_id:''});q.end();},
      close(){q.closed=true;},
      async accountInfo(){return {email:'me@example.com',subscriptionType:'pro'};},
      async supportedModels(){return [{value:'default',displayName:'Default',description:'',supportsEffort:true,supportedEffortLevels:['low','medium','high']},{value:'haiku',displayName:'Haiku',description:''}];},
      async *[Symbol.asyncIterator](){
        while(true){
          if(messages.length){yield messages.shift();continue;}
          if(failure)throw failure;
          if(ended)return;
          await new Promise(resolve=>{wake=resolve;});wake=null;
        }
      }};
    this.queries.push(q);
    return q;
  };
  getSessionInfo=async id=>this.sessions.has(id)?{sessionId:id}:undefined;
}

class OtherProvider extends EventEmitter {
  id='other';label='Other';connected=true;
  start(){}stop(){}
  models(){return [{id:'m',label:'M',isDefault:true,defaultEffort:'low',efforts:['low']}];}
  usage(){return {known:true,blocked:false,retryAt:Date.now(),windows:[]};}
  readSession(){return {active:false};}
  openSession({sessionId}){return {sessionId:sessionId||'other-session'};}
  startTurn(){return {turnId:'other-turn'};}
  steer(){}interrupt(){}answerApproval(){}rejectApproval(){}
  isRateLimitError(){return false;}
  prepareInput(_store,messages){return {text:messages.map(m=>m.text).join('\n')};}
  classifyTask(){return {action:'new',title:'x'};}
}

const flush=async(times=3)=>{for(let i=0;i<times;i++)await new Promise(resolve=>setImmediate(resolve));};
const final=(fields={})=>({type:'result',subtype:'success',is_error:false,result:'',structured_output:{status:'completed',summary:'done',decisionTitle:'',decisionBackground:'',question:'',options:[],optionDetails:[],...fields},session_id:''});

function setup(t,{extraProviders=[]}={}) {
  const root=mkdtempSync(join(tmpdir(),'claude-provider-'));
  const store=new Store(join(root,'db.sqlite'));
  const sdk=new FakeSDK();
  const claude=new ClaudeProvider({sdk,stateFile:join(root,'limits.json'),env:{PATH:'x',ANTHROPIC_API_KEY:'sk-should-not-leak'}});
  const config={workspaceRoot:root,maxConcurrent:2,maxCycles:3,turnTimeoutMinutes:30,digestHours:[],timezone:'Asia/Seoul',approvalsReviewer:'auto_review',defaultProvider:'claude'};
  const engine=new Engine(store,[claude,...extraProviders],config);
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {root,store,sdk,claude,engine};
}
async function startTask(ctx,goal='Write a report') {
  const task=ctx.engine.create({goal});
  await ctx.engine.tick();await flush();
  return {task,q:ctx.sdk.queries.at(-1)};
}

test('a Claude task runs on the user login and completes from structured output',async t=>{
  const ctx=setup(t);const {task,q}=await startTask(ctx);
  assert.equal(ctx.store.get(task.id).provider_id,'claude');
  assert.equal(ctx.store.get(task.id).status,'running');
  assert.equal(q.options.env.ANTHROPIC_API_KEY,undefined);
  assert.equal(q.options.permissionMode,'auto');
  assert.equal(q.options.resume,undefined);
  assert.equal(q.options.sessionId,ctx.store.get(task.id).thread_id);
  assert.equal(q.options.outputFormat.type,'json_schema');
  assert.deepEqual(q.options.disallowedTools,['AskUserQuestion']);
  q.push({type:'system',subtype:'init',session_id:q.options.sessionId});
  q.push({type:'assistant',parent_tool_use_id:null,message:{content:[{type:'text',text:'Looking at the files'}]}});
  q.push(final({summary:'Report written'}));
  await flush(6);
  const saved=ctx.store.get(task.id);
  assert.equal(saved.status,'completed');
  assert.equal(saved.summary,'Report written');
  assert.ok(ctx.store.messages(task.id).some(m=>m.role==='assistant'&&m.text==='Looking at the files'));
  assert.equal(ctx.claude.turns.size,0);
});

test('a follow-up instruction resumes the same Claude session',async t=>{
  const ctx=setup(t);const {task,q}=await startTask(ctx);
  q.push({type:'system',subtype:'init',session_id:q.options.sessionId});q.push(final());await flush(6);
  ctx.engine.message(task.id,'Add a chart');await ctx.engine.tick();await flush();
  const next=ctx.sdk.queries.at(-1);
  assert.notEqual(next,q);
  assert.equal(next.options.resume,ctx.store.get(task.id).thread_id);
  assert.equal(next.options.sessionId,undefined);
});

test('a tool permission request waits in the decision inbox and is answered precisely',async t=>{
  const ctx=setup(t);const {task,q}=await startTask(ctx);
  const permission=q.options.canUseTool('Bash',{command:'npm test'},{signal:new AbortController().signal,toolUseID:'tool-1',requestId:'r1'});
  assert.equal(ctx.store.get(task.id).status,'waiting_approval');
  const decision=ctx.store.decisions()[0];
  assert.equal(decision.kind,'approval');
  assert.match(decision.question,/npm test/);
  await ctx.engine.decide(decision.id,'accept');
  assert.deepEqual(await permission,{behavior:'allow',updatedInput:{command:'npm test'}});
  assert.equal(ctx.store.get(task.id).status,'running');
  const declined=q.options.canUseTool('Write',{file_path:'C:/x.txt'},{signal:new AbortController().signal,toolUseID:'tool-2'});
  await ctx.engine.decide(ctx.store.decisions()[0].id,'decline');
  assert.equal((await declined).behavior,'deny');
});

test('a Claude usage limit waits for the reported reset instead of failing',async t=>{
  const ctx=setup(t);const {task,q}=await startTask(ctx);
  const resetsAt=Math.floor(Date.now()/1000)+3600;
  q.push({type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'five_hour',resetsAt,utilization:1}});
  q.push({type:'result',subtype:'success',is_error:true,result:"You've hit your limit · resets 3pm",session_id:''});
  await flush(8);
  assert.equal(ctx.store.get(task.id).status,'rate_limited');
  const usage=await ctx.claude.usage();
  assert.equal(usage.blocked,true);
  assert.ok(Math.abs(usage.retryAt-(resetsAt*1000+5000))<1000);
  assert.equal(usage.windows[0].usedPercent,100);
  // The last report survives a restart.
  const restarted=new ClaudeProvider({sdk:ctx.sdk,stateFile:join(ctx.root,'limits.json')});
  assert.equal((await restarted.usage()).blocked,true);
  // A later "allowed" report for the same window clears the wait and lists every window.
  ctx.claude.recordLimit({status:'allowed',rateLimitType:'five_hour',resetsAt,unifiedWindows:{five_hour:{utilization:0.3,resetsAt},seven_day:{utilization:0.04,resetsAt:resetsAt+86400}}});
  const usage2=await ctx.claude.usage();
  assert.equal(usage2.blocked,false);
  assert.deepEqual(usage2.windows.map(w=>[w.id,w.usedPercent]),[['five_hour',30],['seven_day',4]]);
});

test('a Claude process that dies mid-turn goes to recovery, not failure',async t=>{
  const ctx=setup(t);const {task,q}=await startTask(ctx);
  q.fail(new Error('Claude Code process exited with code 1'));
  await flush(6);
  const saved=ctx.store.get(task.id);
  assert.equal(saved.status,'recovery');
  assert.match(saved.error,/끊겼습니다/);
});

test('pausing interrupts the live Claude turn',async t=>{
  const ctx=setup(t);const {task,q}=await startTask(ctx);
  await ctx.engine.pause(task.id);await flush(6);
  assert.equal(q.interrupted,true);
  assert.equal(ctx.store.get(task.id).status,'paused');
});

test('steering is refused with a clear message for Claude tasks',async t=>{
  const ctx=setup(t);const {task}=await startTask(ctx);
  await assert.rejects(()=>ctx.engine.steer(task.id,'faster'),/즉시 반영을 지원하지 않습니다/);
  assert.equal(ctx.store.messages(task.id).length,1);
});

test('a disconnect of one provider leaves the other provider tasks running',async t=>{
  const other=new OtherProvider();
  const ctx=setup(t,{extraProviders:[other]});
  const {task:claudeTask}=await startTask(ctx);
  const otherTask=ctx.engine.create({goal:'other work',provider:'other'});
  await ctx.engine.tick();await flush();
  assert.equal(ctx.store.get(otherTask.id).status,'running');
  other.emit('disconnect','other went away');
  assert.equal(ctx.store.get(otherTask.id).status,'recovery');
  assert.equal(ctx.store.get(claudeTask.id).status,'running');
  const snapshot=ctx.engine.snapshot();
  assert.deepEqual(snapshot.providers.map(p=>p.id),['claude','other']);
  assert.equal(snapshot.defaultProvider,'claude');
});

test('a task for an unregistered provider is paused instead of run',async t=>{
  const ctx=setup(t);
  const task=ctx.store.create({goal:'old',title:'old',cwd:ctx.root,providerId:'gone'});
  await ctx.engine.tick();
  assert.equal(ctx.store.get(task.id).status,'paused');
});

test('classification runs without tools on the small model',async t=>{
  const ctx=setup(t);
  const tasks=[{id:'abcd1234',title:'Report',summary:'writing a report'}];
  const pending=ctx.claude.classifyTask(tasks,'add a chart to the report');
  await flush(4);
  const q=ctx.sdk.queries.at(-1);
  assert.deepEqual(q.options.tools,[]);
  assert.equal(q.options.model,'haiku');
  assert.equal(q.options.persistSession,false);
  q.push({type:'result',subtype:'success',is_error:false,result:'',structured_output:{action:'existing',taskId:'abcd1234',title:'',reason:'같은 보고서',confidence:0.95}});
  const route=await pending;
  assert.equal(route.action,'existing');
  assert.equal(route.taskId,'abcd1234');
});

test('only real usage limits count as rate limits',()=>{
  assert.equal(isRateLimitError({message:"You've hit your limit · resets 3pm"}),true);
  assert.equal(isRateLimitError({code:'usage_limit_exceeded'}),true);
  assert.equal(isRateLimitError({message:'Credit balance is too low'}),false);
  assert.equal(isRateLimitError({message:'Invalid API key · rate limit exceeded'}),false);
  assert.equal(isRateLimitError({message:'Overloaded'}),false);
});
