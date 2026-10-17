import { EventEmitter } from 'node:events';
import { CodexRPC } from './codex-rpc.mjs';
import { isRateLimitError, limitState } from './codex-rate-limits.mjs';
import { messageInput } from '../attachments.mjs';
import { routeMessage } from './codex-router.mjs';

// The only module allowed to know the Codex App Server wire protocol.
export class CodexProvider extends EventEmitter {
  id='codex';label='Codex';lastError='';
  capabilities=Object.freeze({resume:true,steer:true,approvals:true,models:true,usage:true,images:true,structuredOutput:true});
  constructor(rpc=new CodexRPC()) {
    super(); this.rpc=rpc;
    rpc.on('notification',message=>this.translateNotification(message));
    rpc.on('request',message=>this.translateRequest(message));
    rpc.on('disconnect',reason=>this.emit('disconnect',reason));
    rpc.on('diagnostic',detail=>this.emit('diagnostic',detail));
  }
  get connected(){return this.rpc.connected;}
  async start(){try{await this.rpc.start();this.lastError='';}catch(e){this.lastError=/ENOENT/.test(e.message)?'Codex CLI가 설치되어 있지 않습니다 (codex 명령을 찾을 수 없음).':e.message;throw e;}}
  stop(){return this.rpc.stop();}
  isRateLimitError(error){return isRateLimitError(error);}
  prepareInput(store,messages,directory,prefix=''){return {items:messageInput(store,messages,directory,prefix)};}
  classifyTask(tasks,text,attachments){return routeMessage(this.rpc,tasks,text,attachments);}
  async usage(){
    await this.start();const raw=await this.rpc.call('account/rateLimits/read',{},10000);
    const groups=Object.values(raw.rateLimitsByLimitId||{});if(!groups.length&&raw.rateLimits)groups.push(raw.rateLimits);
    const windows=groups.flatMap(group=>['primary','secondary'].flatMap(slot=>{
      const window=group[slot];if(!window||!Number.isFinite(window.usedPercent))return [];
      const mins=window.windowDurationMins||0;
      const label=mins>=10000?'주간 한도':mins>=240?'5시간 한도':group.limitName||group.limitId||'사용량 한도';
      const reset=Number(window.resetsAt);
      return [{id:(group.limitId||'default')+':'+slot,label,usedPercent:window.usedPercent,resetsAt:Number.isFinite(reset)&&reset>0?new Date(reset<1e12?reset*1000:reset).toISOString():null}];
    }));
    return {...limitState(raw),windows};
  }
  async models(){
    await this.start();const models=[];let cursor;
    do {const page=await this.rpc.call('model/list',{limit:50,includeHidden:false,...(cursor?{cursor}:{})});models.push(...(page.data||[]));cursor=page.nextCursor;} while(cursor);
    return models.map(m=>({id:m.model,label:m.displayName||m.model,isDefault:!!m.isDefault,defaultEffort:m.defaultReasoningEffort,efforts:(m.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort)}));
  }
  async readSession(sessionId){await this.start();const result=await this.rpc.call('thread/read',{threadId:sessionId,includeTurns:false});return {active:result.thread?.status?.type==='active',model:result.thread?.model,effort:result.thread?.reasoningEffort};}
  async openSession({sessionId,cwd,model,effort,accessMode,approvalsReviewer,instructions,ephemeral=false}){
    await this.start();
    const full=accessMode==='full';
    const settings={cwd,approvalPolicy:full?'never':ephemeral?'never':'on-request',sandbox:full?'danger-full-access':ephemeral?'read-only':'workspace-write',approvalsReviewer:full?'user':approvalsReviewer||'user',developerInstructions:instructions};
    if(model)settings.model=model;if(effort)settings.config={model_reasoning_effort:effort};if(ephemeral)settings.ephemeral=true;
    const result=await this.rpc.call(sessionId?'thread/resume':'thread/start',sessionId?{threadId:sessionId,...settings}:settings);
    return {sessionId:result.thread.id,model:result.model||result.thread?.model,effort:result.reasoningEffort||result.thread?.reasoningEffort};
  }
  async startTurn({sessionId,input,model,effort,outputSchema}){
    const params={threadId:sessionId,input:input.items||input,outputSchema};if(model)params.model=model;if(effort)params.effort=effort;
    const result=await this.rpc.call('turn/start',params);return {turnId:result.turn.id};
  }
  steer({sessionId,turnId,input}){return this.rpc.call('turn/steer',{threadId:sessionId,expectedTurnId:turnId,input:input.items||input});}
  interrupt({sessionId,turnId}){return this.rpc.call('turn/interrupt',{threadId:sessionId,turnId});}
  rejectApproval(request,reason){this.rpc.reject(request.requestId,reason);}
  answerApproval(request,answer){
    let result;
    if(request.kind==='execution'){
      if(!['accept','decline'].includes(answer))throw new Error('Choose accept or decline.');
      result={decision:answer};
    } else if(request.kind==='question'){
      const questions=request.questions||[];
      if(questions.some(q=>q.isSecret))throw new Error('Secret answers must be entered directly in the provider.');
      const values=questions.length===1?{[questions[0].id]:answer}:JSON.parse(answer);
      result={answers:Object.fromEntries(questions.map(q=>{if(!values[q.id])throw new Error('Answer every question ID.');return [q.id,{answers:[String(values[q.id])]}];}))};
    } else throw new Error('Unsupported approval type.');
    this.rpc.respond(request.requestId,result);
  }
  translateRequest(message){
    const {method,params:p={},id:requestId}=message;
    const kind=['item/commandExecution/requestApproval','item/fileChange/requestApproval'].includes(method)?'execution':['item/tool/requestUserInput','tool/requestUserInput'].includes(method)?'question':'unsupported';
    this.emit('approvalRequested',{requestId,sessionId:p.threadId,turnId:p.turnId,itemId:p.itemId,kind,questions:p.questions||[],reason:p.reason,details:p});
  }
  translateNotification({method,params:p={}}){
    if(method==='account/rateLimits/updated'){this.emit('usageUpdated',p.rateLimits||p);return;}
    if(method==='serverRequest/resolved'){this.emit('approvalResolved',{requestId:p.requestId??p.id});return;}
    if(method==='error'){this.emit('turnError',{sessionId:p.threadId,turnId:p.turnId,error:p.error});return;}
    if(method==='item/started'&&p.item){this.emit('itemStarted',{sessionId:p.threadId,turnId:p.turnId,item:p.item});return;}
    if(method==='turn/started'){this.emit('turnStarted',{sessionId:p.threadId,turnId:p.turn?.id});return;}
    if(method==='item/completed'&&p.item?.type==='agentMessage')this.emit('message',{sessionId:p.threadId,turnId:p.turnId,phase:p.item.phase,text:p.item.text});
    if(method==='item/completed'&&['commandExecution','fileChange'].includes(p.item?.type))this.emit('toolCompleted',{sessionId:p.threadId,turnId:p.turnId,kind:p.item.type,item:p.item});
    if(method==='turn/completed')this.emit('turnCompleted',{sessionId:p.threadId,turnId:p.turn?.id,status:p.turn?.status,error:p.turn?.error});
  }
}
