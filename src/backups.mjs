import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pattern=/^automation-(\d{4}-\d{2}-\d{2})\.sqlite$/;

// Deletes daily backups older than keepDays, but always keeps the newest keepMin
// so a long shutdown never leaves only today's (possibly already bad) copy.
export function pruneBackups(dir,{keepDays=14,keepMin=3,now=Date.now()}={}) {
  let names;try{names=readdirSync(dir);}catch{return [];}
  const backups=names.map(name=>({name,date:name.match(pattern)?.[1]})).filter(b=>b.date).sort((a,b)=>b.date.localeCompare(a.date));
  const cutoff=new Date(now-keepDays*86400000).toISOString().slice(0,10);
  const removed=[];
  for(const backup of backups.slice(Math.max(0,keepMin))) {
    if(backup.date>=cutoff) continue;
    rmSync(join(dir,backup.name),{force:true});removed.push(backup.name);
  }
  return removed;
}

export function backupUsage(dir) {
  let bytes=0,count=0;
  try { for(const name of readdirSync(dir)) if(pattern.test(name)){bytes+=statSync(join(dir,name)).size;count++;} } catch {}
  return {bytes,count};
}
