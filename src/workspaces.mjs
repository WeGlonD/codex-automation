import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const norm=path=>process.platform==='win32'?resolve(path).toLowerCase():resolve(path);
const real=path=>{try{return realpathSync(path);}catch{return resolve(path);}};
export const samePath=(a,b)=>norm(real(a))===norm(real(b));
const within=(base,path)=>{const b=norm(base),p=norm(path);return p===b||p.startsWith(b+sep);};

// Folders a task may be started in: the direct subfolders of each allowed root,
// except the automatic task folder root and anything inside it.
export function workspaceChoices(allowedRoots=[],workspaceRoot) {
  const auto=workspaceRoot?real(workspaceRoot):null;
  const groups=[];
  for(const root of allowedRoots) {
    if(!existsSync(root)) continue;
    const base=real(root);const folders=[];
    for(const entry of readdirSync(base,{withFileTypes:true})) {
      if(!entry.isDirectory()||entry.name.startsWith('.')) continue;
      const path=join(base,entry.name);
      if(auto&&(within(auto,path)||within(path,auto))) continue;
      folders.push({name:entry.name,path,label:basename(base)+sep+entry.name});
    }
    folders.sort((a,b)=>a.name.localeCompare(b.name));
    groups.push({root:basename(base),path:base,folders});
  }
  return groups;
}

// The space a task belongs to: 'general' for folders agent-server made, the top-level folder under an
// allowed root for chosen folders (by its real path), or 'other' when it is outside every listed space.
export function taskSpace(cwd,{allowedRoots=[],workspaceRoot}={}) {
  const path=real(cwd);
  if(workspaceRoot&&within(real(workspaceRoot),path)) return 'general';
  for(const root of allowedRoots.map(real)) {
    if(!within(root,path)||norm(root)===norm(path)) continue;
    const top=join(root,relative(root,path).split(sep)[0]);
    if(workspaceRoot&&within(top,real(workspaceRoot))) continue;
    return top;
  }
  return 'other';
}

// Short folder name for display: automatic task folders show their shared root, others
// their path from the allowed root's own name (e.g. projects\household-budget).
export function folderLabel(cwd,{allowedRoots=[],workspaceRoot}={}) {
  const path=real(cwd);
  const auto=workspaceRoot?real(workspaceRoot):null;
  const shown=auto&&norm(dirname(path))===norm(auto)?auto:path;
  for(const root of allowedRoots.map(real)) if(within(root,shown)) return join(basename(root),relative(root,shown))||basename(root);
  return auto&&shown===auto?join(basename(dirname(auto)),basename(auto)):shown;
}
