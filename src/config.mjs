import { mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const dataDir = process.env.AUTOMATION_DATA_DIR || join(root,'data');
mkdirSync(dataDir,{recursive:true});
const local = join(root,'config.local.json');
export const config = { port:4317, host:'127.0.0.1', maxConcurrent:2, maxCycles:6, turnTimeoutMinutes:30, approvalsReviewer:'auto_review', defaultModel:null,
  profiles:{ fast:{label:'빠른 실행',model:'gpt-6-luna',effort:'low'}, standard:{label:'일반 작업',model:'gpt-6-sol',effort:'medium'}, deep:{label:'심층 분석',model:'gpt-6-astra',effort:'high'}, auto:{label:'자동 선택',model:null,effort:null} },
  digestHours:[9,18], timezone:'Asia/Seoul', workspaceRoot:join(root,'workspaces'), allowedRoots:[join(root,'workspaces')], attachmentRoot:join(dataDir,'attachments'),
  codexCommand:process.env.CODEX_COMMAND || 'codex', providers:['codex','claude'], defaultProvider:'codex',
  claudeProfiles:{ auto:{label:'자동 선택',model:null,effort:null}, standard:{label:'일반 작업',model:'sonnet',effort:'medium'}, fast:{label:'빠른 실행',model:'haiku',effort:'low'}, deep:{label:'심층 분석',model:'opus',effort:'high'} },
  ...(existsSync(local)?JSON.parse(readFileSync(local,'utf8')):{}) };
config.providerProfiles={ codex:config.profiles, claude:config.claudeProfiles, ...(config.providerProfiles||{}) };
mkdirSync(config.workspaceRoot,{recursive:true});
const tokenFile=join(dataDir,'access-token');
if (!existsSync(tokenFile)) writeFileSync(tokenFile,randomBytes(32).toString('hex'),{mode:0o600});
export const accessToken=readFileSync(tokenFile,'utf8').trim();
export function checkedWorkspace(path) {
  const candidate=realpathSync(path);
  const allowed=config.allowedRoots.some(r => { const base=realpathSync(r); const a=process.platform==='win32'?candidate.toLowerCase():candidate; const b=process.platform==='win32'?base.toLowerCase():base; return a===b||a.startsWith(b+sep); });
  if (!allowed) throw new Error('허용된 작업 폴더 밖입니다. config.local.json의 allowedRoots를 확인하세요.');
  return candidate;
}
