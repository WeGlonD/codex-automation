import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';

const norm=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
export function inside(base,path) { const b=norm(base),p=norm(path);return p.startsWith(b+sep); }

// Size of a file or folder tree; symbolic links are counted, never followed.
export function pathSize(path) {
  let stat;try{stat=lstatSync(path);}catch{return 0;}
  if(!stat.isDirectory()) return stat.size;
  let total=0;
  for(const name of readdirSync(path)) total+=pathSize(join(path,name));
  return total;
}

// Only the folder agent-server created for this task (workspaceRoot\<task id>) is the task's own;
// a folder the user chose is shared with other work and is never measured as the task's or deleted.
export function ownedWorkspace(task,workspaceRoot) {
  if(!workspaceRoot||!existsSync(task.cwd)) return null;
  let real;try{real=realpathSync(task.cwd);}catch{return null;}
  const expected=join(realpathSync(workspaceRoot),task.id);
  return norm(real)===norm(expected)&&basename(real)===task.id?real:null;
}

export function attachmentCopies(root,attachmentIds) {
  if(!root||!attachmentIds.length||!existsSync(root)) return [];
  const prefixes=attachmentIds.map(id=>id+'_');
  return readdirSync(root).filter(name=>prefixes.some(prefix=>name.startsWith(prefix))).map(name=>join(root,name));
}

export function removePaths(paths) {
  const removed=[],failed=[];
  for(const path of paths) {
    try{rmSync(path,{recursive:true,force:true});removed.push(path);}
    catch(e){failed.push({path,error:e.message});}
  }
  return {removed,failed};
}
// Folders that only held the deleted session are removed when they end up empty.
export function removeEmptyDirs(paths) { for(const path of paths){try{rmdirSync(path);}catch{}} }
