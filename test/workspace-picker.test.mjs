import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,sep} from 'node:path';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {workspaceChoices,folderLabel,taskSpace} from '../src/workspaces.mjs';
import {ClaudeProvider} from '../src/providers/claude.mjs';

function layout(t) {
  const root=mkdtempSync(join(tmpdir(),'picker-'));const closers=[];
  t.after(()=>{for(const close of closers)close();rmSync(root,{recursive:true,force:true});});
  const sandbox=join(root,'sandbox'),projects=join(root,'projects'),auto=join(sandbox,'agent-tasks');
  for(const dir of [join(auto,'a1b2c3d4'),join(sandbox,'api-test'),join(sandbox,'.cache'),join(projects,'household-budget'),join(projects,'todo-app')])mkdirSync(dir,{recursive:true});
  writeFileSync(join(projects,'notes.txt'),'not a folder');
  return {root,sandbox,projects,auto,allowedRoots:[sandbox,projects],closers};
}

class RecordingProvider extends EventEmitter {
  id='example';connected=true;opened=[];
  start(){}stop(){}models(){return [];}usage(){return {known:true,blocked:false,retryAt:0,windows:[]};}
  readSession(){return {active:false};}
  openSession(args){this.opened.push(args);return {sessionId:'s-'+this.opened.length};}
  startTurn(){return {turnId:'t'};}steer(){}interrupt(){}answerApproval(){}rejectApproval(){}isRateLimitError(){return false;}
  prepareInput(_s,messages){return {text:messages.map(m=>m.text).join('\n')};}classifyTask(){return {action:'new'};}
}

test('the picker lists folders under each allowed root, never the automatic task folders',t=>{
  const l=layout(t);
  const groups=workspaceChoices(l.allowedRoots,l.auto);
  assert.deepEqual(groups.map(g=>[g.root,g.folders.map(f=>f.name)]),[['sandbox',['api-test']],['projects',['household-budget','todo-app']]]);
  assert.equal(groups[1].folders[0].label,'projects'+sep+'household-budget');
  assert.deepEqual(workspaceChoices([join(l.root,'missing')],l.auto),[]);
});

test('folders are labelled by allowed root, and automatic task folders by their shared root',t=>{
  const l=layout(t);const options={allowedRoots:l.allowedRoots,workspaceRoot:l.auto};
  assert.equal(folderLabel(join(l.auto,'a1b2c3d4'),options),'sandbox'+sep+'agent-tasks');
  assert.equal(folderLabel(join(l.projects,'household-budget'),options),'projects'+sep+'household-budget');
  const outside=mkdtempSync(join(tmpdir(),'outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  assert.equal(folderLabel(outside,options).toLowerCase(),outside.toLowerCase());
});

test('a chosen project folder gets the project rules and every task sees the allowed folders',async t=>{
  const l=layout(t);
  const store=new Store(join(l.root,'db.sqlite'));l.closers.push(()=>store.close());
  const provider=new RecordingProvider();
  const engine=new Engine(store,provider,{workspaceRoot:l.auto,allowedRoots:l.allowedRoots,maxConcurrent:2,maxCycles:2,turnTimeoutMinutes:30,digestHours:[],timezone:'Asia/Seoul'});
  const own=engine.create({goal:'experiment'});
  const project=engine.create({goal:'add a chart',cwd:join(l.projects,'household-budget')});
  await engine.tick();await new Promise(resolve=>setImmediate(resolve));
  const byCwd=Object.fromEntries(provider.opened.map(args=>[args.cwd,args]));
  const ownArgs=byCwd[store.get(own.id).cwd],projectArgs=byCwd[store.get(project.id).cwd];
  assert.match(ownArgs.instructions,/Use output\/ only/);
  assert.doesNotMatch(ownArgs.instructions,/existing project/);
  assert.match(projectArgs.instructions,/This folder is an existing project\. Follow the CLAUDE\.md files of this project and its parent folders/);
  assert.match(projectArgs.instructions,/do not create work\/ or output\/ folders/);
  assert.doesNotMatch(projectArgs.instructions,/Use output\/ only|internal working files in work\//);
  assert.deepEqual(projectArgs.additionalDirectories,l.allowedRoots);
  const folders=Object.fromEntries(engine.snapshot().tasks.map(task=>[task.id,task.folder]));
  assert.equal(folders[own.id],'sandbox'+sep+'agent-tasks');
  assert.equal(folders[project.id],'projects'+sep+'household-budget');
  const spaces=Object.fromEntries(engine.snapshot().tasks.map(task=>[task.id,task.space]));
  assert.equal(spaces[own.id],'general');
  assert.equal(spaces[project.id].toLowerCase(),join(l.projects,'household-budget').toLowerCase());
});

test('Claude receives the allowed folders as additional working directories',async t=>{
  const l=layout(t);const calls=[];
  const sdk={query:({options})=>{calls.push(options);return {async accountInfo(){return {email:'me@example.com'};},async supportedModels(){return [];},close(){},async *[Symbol.asyncIterator](){}};},getSessionInfo:async()=>undefined};
  const claude=new ClaudeProvider({sdk,env:{}});
  const {sessionId}=await claude.openSession({cwd:join(l.projects,'household-budget'),instructions:'x',additionalDirectories:[...l.allowedRoots,join(l.root,'missing')]});
  await claude.startTurn({sessionId,input:{text:'hi'}});
  assert.deepEqual(calls.at(-1).additionalDirectories,l.allowedRoots);
});

test('each task belongs to the general space, the project it runs in, or other',t=>{
  const l=layout(t);const options={allowedRoots:l.allowedRoots,workspaceRoot:l.auto};
  assert.equal(taskSpace(join(l.auto,'a1b2c3d4'),options),'general');
  const project=join(l.projects,'household-budget');mkdirSync(join(project,'src'),{recursive:true});
  assert.equal(taskSpace(project,options).toLowerCase(),project.toLowerCase());
  assert.equal(taskSpace(join(project,'src'),options).toLowerCase(),project.toLowerCase(),'a subfolder still belongs to its project');
  assert.equal(taskSpace(join(l.sandbox,'api-test'),options).toLowerCase(),join(l.sandbox,'api-test').toLowerCase());
  assert.equal(taskSpace(l.projects,options),'other','an allowed root itself is not a space');
  const outside=mkdtempSync(join(tmpdir(),'outside-'));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  assert.equal(taskSpace(outside,options),'other');
});
