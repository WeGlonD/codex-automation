import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
import {Engine} from '../src/engine.mjs';
import {messageInput} from '../src/attachments.mjs';
import {pruneBackups} from '../src/backups.mjs';
import {ClaudeProvider} from '../src/providers/claude.mjs';

class FilesProvider extends EventEmitter {
  id='example';connected=true;sessionPaths=[];folderDirs=[];
  start(){}stop(){}
  models(){return [];}usage(){return {known:true,blocked:false,retryAt:0,windows:[]};}
  readSession(){return {active:false};}openSession(){return {sessionId:'s'};}startTurn(){return {turnId:'t'};}
  steer(){}interrupt(){}answerApproval(){}rejectApproval(){}isRateLimitError(){return false;}
  prepareInput(_s,messages){return {text:messages.map(m=>m.text).join('\n')};}classifyTask(){return {action:'new'};}
  sessionFiles(){return {files:this.sessionPaths.filter(p=>existsSync(p)),emptyDirs:[],folderDirs:this.folderDirs.filter(p=>existsSync(p))};}
}

function setup(t) {
  const root=mkdtempSync(join(tmpdir(),'task-delete-'));
  const workspaceRoot=join(root,'agent-tasks');mkdirSync(workspaceRoot);
  const store=new Store(join(root,'db.sqlite'));
  const provider=new FilesProvider();
  const engine=new Engine(store,provider,{workspaceRoot,attachmentRoot:join(root,'attachments'),maxConcurrent:1,maxCycles:2,turnTimeoutMinutes:30,digestHours:[],timezone:'Asia/Seoul'});
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return {root,workspaceRoot,store,provider,engine};
}
// A task with a file in its folder, an attachment that was handed to the AI, a decision notice and a session file.
function fullTask(ctx,cwd) {
  const attachment=ctx.store.addAttachment({id:randomUUID(),name:'photo.png',mime:'image/png',content:Buffer.alloc(5000,1)});
  const task=ctx.engine.create({goal:'Make a chart',attachments:[attachment.id],...(cwd?{cwd}:{})});
  writeFileSync(join(task.cwd,'result.txt'),'x'.repeat(3000));
  messageInput(ctx.store,ctx.store.messages(task.id),ctx.engine.attachmentRoot());
  ctx.store.decision(task.id,'business','Which color?',{options:['red']});
  const session=join(ctx.root,'session-'+task.id+'.jsonl');writeFileSync(session,'y'.repeat(2000));
  ctx.store.patch(task.id,{thread_id:'session-1'});ctx.provider.sessionPaths.push(session);
  // Claude Code also keeps folders named after the working folder (memory, other process runs).
  const folderDir=join(ctx.root,'claude-folder-'+task.id);mkdirSync(join(folderDir,'memory'),{recursive:true});writeFileSync(join(folderDir,'other-run.jsonl'),'z');
  ctx.provider.folderDirs.push(folderDir);
  return {task:ctx.store.get(task.id),attachment,session,folderDir};
}

test('archiving records the size of everything that belongs to the task',async t=>{
  const ctx=setup(t);const {task}=fullTask(ctx);
  await ctx.engine.archive(task.id);
  const usage=JSON.parse(ctx.store.get(task.id).archive_usage);
  assert.ok(usage.attachments>=10000,'attachment stored in the database and its copy');
  assert.ok(usage.workspace>=3000);
  assert.equal(usage.session,2001,"session file plus the folder Claude keeps for this task");
  assert.equal(usage.sharedFolder,false);
  assert.equal(usage.total,usage.attachments+usage.records+usage.workspace+usage.session);
  ctx.engine.restore(task.id);
  assert.equal(ctx.store.get(task.id).archive_usage,null);
});

test('only an archived task can be deleted, and deleting removes its records and files',async t=>{
  const ctx=setup(t);const {task,attachment,session,folderDir}=fullTask(ctx);
  await assert.rejects(()=>ctx.engine.deleteTask(task.id),/보관된 작업만/);
  await ctx.engine.archive(task.id);
  const result=await ctx.engine.deleteTask(task.id);
  assert.deepEqual(result.failed,[]);
  assert.equal(ctx.store.get(task.id),undefined);
  assert.equal(ctx.store.messages(task.id).length,0);
  assert.equal(ctx.store.decisions(false).filter(d=>d.task_id===task.id).length,0);
  assert.equal(ctx.store.events(task.id).length,0);
  assert.equal(ctx.store.attachment(attachment.id),undefined);
  assert.ok(!ctx.store.outbox().some(row=>row.text.includes('Which color')||row.text.includes(task.id)));
  assert.equal(existsSync(task.cwd),false);
  assert.equal(existsSync(session),false);
  assert.equal(existsSync(folderDir),false);
  assert.deepEqual(readdirSync(ctx.engine.attachmentRoot()),[]);
});

test('deleting a task that ran in a folder the user chose never removes that folder',async t=>{
  const ctx=setup(t);
  const project=join(ctx.root,'projects','household-budget');mkdirSync(project,{recursive:true});
  writeFileSync(join(project,'README.md'),'keep me');
  const {task,folderDir}=fullTask(ctx,project);
  await ctx.engine.archive(task.id);
  assert.equal(JSON.parse(ctx.store.get(task.id).archive_usage).sharedFolder,true);
  const result=await ctx.engine.deleteTask(task.id);
  assert.equal(result.sharedFolder,true);
  assert.equal(existsSync(join(project,'README.md')),true);
  assert.equal(existsSync(join(folderDir,'other-run.jsonl')),true,'other sessions of a shared folder stay');
  assert.equal(ctx.store.get(task.id),undefined);
});

test('a folder named like the task elsewhere is not treated as the task folder',async t=>{
  const ctx=setup(t);
  const task=ctx.engine.create({goal:'x'});
  const decoy=join(ctx.root,task.id);mkdirSync(decoy);
  ctx.store.db.prepare('UPDATE tasks SET cwd=? WHERE id=?').run(decoy,task.id);
  await ctx.engine.archive(task.id);await ctx.engine.deleteTask(task.id);
  assert.equal(existsSync(decoy),true);
});

test('backups older than the keep period are pruned but the newest few always stay',t=>{
  const dir=mkdtempSync(join(tmpdir(),'backups-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const now=Date.parse('2026-10-31T12:00:00Z');
  const days=['2026-10-01','2026-10-10','2026-10-18','2026-10-20','2026-10-30','2026-10-31'];
  for(const day of days)writeFileSync(join(dir,'automation-'+day+'.sqlite'),'db');
  writeFileSync(join(dir,'notes.txt'),'not a backup');
  assert.deepEqual(pruneBackups(dir,{keepDays:14,keepMin:3,now}).sort(),['automation-2026-10-01.sqlite','automation-2026-10-10.sqlite']);
  assert.deepEqual(readdirSync(dir).sort(),['automation-2026-10-18.sqlite','automation-2026-10-20.sqlite','automation-2026-10-30.sqlite','automation-2026-10-31.sqlite','notes.txt']);
  // After a long shutdown every backup is old, yet the newest three remain.
  assert.deepEqual(pruneBackups(dir,{keepDays:14,keepMin:3,now:Date.parse('2027-03-01T00:00:00Z')}),['automation-2026-10-18.sqlite']);
  assert.equal(readdirSync(dir).filter(n=>n.endsWith('.sqlite')).length,3);
});

test('Claude session files are found by session ID and folder name only',t=>{
  const root=mkdtempSync(join(tmpdir(),'claude-home-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const home=join(root,'.claude'),temp=join(root,'temp');
  const sid='00258a42-8cb5-4dfd-b1c4-9e9dd2adf4ee',other='11111111-2222-3333-4444-555555555555';
  const cwd='D:\\Document\\Workspace\\sandbox\\agent-tasks\\86c5401f',folder='D--Document-Workspace-sandbox-agent-tasks-86c5401f';
  for(const dir of [join(home,'projects',folder,sid),join(home,'file-history',sid),join(temp,folder,sid)])mkdirSync(dir,{recursive:true});
  writeFileSync(join(home,'projects',folder,sid+'.jsonl'),'{}');writeFileSync(join(home,'projects',folder,other+'.jsonl'),'{}');
  writeFileSync(join(temp,'cache-break-state-'+sid+'.json'),'{}');
  const provider=new ClaudeProvider({claudeHome:home,tempRoot:temp});
  const {files,emptyDirs}=provider.sessionFiles({sessionId:sid,cwd});
  assert.deepEqual(files.map(f=>f.slice(root.length+1)).sort(),[join('.claude','file-history',sid),join('.claude','projects',folder,sid),join('.claude','projects',folder,sid+'.jsonl'),join('temp',folder,sid),join('temp','cache-break-state-'+sid+'.json')].sort());
  assert.ok(!files.some(f=>f.includes(other)));
  assert.deepEqual(emptyDirs,[join(home,'projects',folder),join(temp,folder)]);
  assert.deepEqual(provider.sessionFiles({sessionId:'../../etc',cwd}).files,[]);
});
