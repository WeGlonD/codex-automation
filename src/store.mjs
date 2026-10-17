import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(file) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL,
        cwd TEXT NOT NULL, status TEXT NOT NULL, thread_id TEXT, turn_id TEXT, summary TEXT DEFAULT '',
        error TEXT DEFAULT '', cycles INTEGER DEFAULT 0, max_cycles INTEGER NOT NULL DEFAULT 6,
        profile TEXT NOT NULL DEFAULT 'standard', model TEXT, effort TEXT, retry_at TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
        role TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
        kind TEXT NOT NULL, question TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        answer TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT NOT NULL,
        detail TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox(key TEXT PRIMARY KEY, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL,
        created_at TEXT NOT NULL, sent_at TEXT);
      CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL,
        size INTEGER NOT NULL, content BLOB NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS message_attachments(message_id INTEGER NOT NULL REFERENCES messages(id),
        attachment_id TEXT NOT NULL UNIQUE REFERENCES attachments(id), PRIMARY KEY(message_id,attachment_id));
      CREATE TABLE IF NOT EXISTS maintenance_requests(id TEXT PRIMARY KEY, title TEXT NOT NULL,
        description TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS maintenance_notes(id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL REFERENCES maintenance_requests(id), text TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    for (const sql of ["ALTER TABLE tasks ADD COLUMN profile TEXT NOT NULL DEFAULT 'standard'", "ALTER TABLE tasks ADD COLUMN model TEXT", "ALTER TABLE tasks ADD COLUMN effort TEXT", "ALTER TABLE tasks ADD COLUMN retry_at TEXT"]) { try { this.db.exec(sql); } catch {} }
    const columns=new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map(c=>c.name));
    for(const column of ['session_model','session_effort','session_checked_at']) {
      if(!columns.has(column))this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
    }
    for(const column of ['settings_revision','applied_settings_revision']) {
      if(!columns.has(column))this.db.exec(`ALTER TABLE tasks ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
    }
    if(!columns.has('archived_at'))this.db.exec('ALTER TABLE tasks ADD COLUMN archived_at TEXT');
    if(!columns.has('provider_id'))this.db.exec("ALTER TABLE tasks ADD COLUMN provider_id TEXT NOT NULL DEFAULT 'codex'");
    if(!columns.has('archive_usage'))this.db.exec('ALTER TABLE tasks ADD COLUMN archive_usage TEXT');
  }
  now() { return new Date().toISOString(); }
  transaction(fn) { if(this.db.isTransaction)return fn();this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  setting(key, fallback) { const r = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key); return r ? JSON.parse(r.value) : fallback; }
  set(key, value) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  create({ title, goal, cwd, maxCycles = 6, id = randomUUID().slice(0, 8), profile = 'standard', model = null, effort = null, providerId = 'codex', attachments = [] }) {
    return this.transaction(()=>{
    const now = this.now();
    this.db.prepare('INSERT INTO tasks(id,title,goal,cwd,status,max_cycles,profile,model,effort,provider_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(id, title, goal, cwd, 'queued', maxCycles, profile, model, effort, providerId, now, now);
    this.message(id, 'user', goal,'pending',attachments); this.event(id, 'created', title); return this.get(id);
    });
  }
  get(id) { return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id); }
  list() { return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC, rowid DESC').all(); }
  latestMessages() { return this.db.prepare('SELECT task_id,id,created_at FROM messages WHERE id IN (SELECT MAX(id) FROM messages GROUP BY task_id)').all(); }
  patch(id, fields) {
    const allowed = new Set(['status','thread_id','turn_id','summary','error','cycles','max_cycles','title','profile','model','effort','retry_at','session_model','session_effort','session_checked_at','settings_revision','applied_settings_revision','archived_at','archive_usage']);
    const entries = Object.entries(fields).filter(([k]) => allowed.has(k));
    if (!entries.length) return;
    this.db.prepare(`UPDATE tasks SET ${entries.map(([k]) => `${k}=?`).join(',')},updated_at=? WHERE id=?`).run(...entries.map(([,v]) => v), this.now(), id);
  }
  message(taskId, role, text, state = role === 'user' ? 'pending' : 'delivered', attachments = []) {
    return this.transaction(()=>{
      this.validateAttachments(attachments);
      const id=this.db.prepare('INSERT INTO messages(task_id,role,text,state,created_at) VALUES (?,?,?,?,?)').run(taskId, role, text, state, this.now()).lastInsertRowid;
      for(const aid of attachments)this.db.prepare('INSERT INTO message_attachments VALUES (?,?)').run(id,aid);
      return id;
    });
  }
  addAttachment({id,name,mime,content}) {
    this.db.prepare('INSERT INTO attachments VALUES (?,?,?,?,?,?)').run(id,name,mime,content.length,content,this.now());
    return this.attachment(id);
  }
  attachment(id,content=false) {return this.db.prepare(`SELECT id,name,mime,size,created_at${content?',content':''} FROM attachments WHERE id=?`).get(id);}
  validateAttachments(ids) {
    if(!Array.isArray(ids)||ids.length>5||new Set(ids).size!==ids.length)throw new Error('첨부 파일은 한 번에 최대 5개입니다.');
    let total=0;
    for(const id of ids) {
      if(typeof id!=='string')throw new Error('잘못된 첨부 파일입니다.');
      const a=this.attachment(id);if(!a)throw new Error('첨부 파일이 없거나 만료됐습니다. 다시 선택해 주세요.');
      if(this.db.prepare('SELECT 1 FROM message_attachments WHERE attachment_id=?').get(id))throw new Error('이미 전송된 첨부 파일입니다.');
      total+=a.size;
    }
    if(total>50*1024*1024)throw new Error('첨부 파일 합계는 50MB 이하여야 합니다.');
  }
  messageAttachments(id) {return this.db.prepare('SELECT a.id,a.name,a.mime,a.size FROM attachments a JOIN message_attachments ma ON a.id=ma.attachment_id WHERE ma.message_id=? ORDER BY a.created_at,a.id').all(id);}
  pruneUnsentAttachments() {this.db.prepare("DELETE FROM attachments WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM message_attachments ma WHERE ma.attachment_id=attachments.id)").run(new Date(Date.now()-86400000).toISOString());}
  messages(id) { return this.db.prepare('SELECT * FROM messages WHERE task_id=? ORDER BY id').all(id); }
  messagesPage(id,before=null,limit=20) {
    const rows=before===null
      ? this.db.prepare('SELECT * FROM messages WHERE task_id=? ORDER BY id DESC LIMIT ?').all(id,limit+1)
      : this.db.prepare('SELECT * FROM messages WHERE task_id=? AND id<? ORDER BY id DESC LIMIT ?').all(id,before,limit+1);
    const hasMore=rows.length>limit;
    const messages=rows.slice(0,limit).reverse();
    return {messages,hasMore,nextBefore:hasMore?messages[0].id:null};
  }
  createMaintenanceRequest(title,description) {
    if(typeof title!=='string'||!title.trim()||title.trim().length>150)throw new Error('제목은 1~150자로 입력하세요.');
    if(typeof description!=='string'||!description.trim()||description.trim().length>30000)throw new Error('내용은 1~30,000자로 입력하세요.');
    const id=randomUUID().slice(0,8),now=this.now();
    this.db.prepare('INSERT INTO maintenance_requests VALUES (?,?,?,?,?)').run(id,title.trim(),description.trim(),now,now);
    return this.maintenanceRequest(id);
  }
  maintenanceRequest(id) {return this.db.prepare('SELECT * FROM maintenance_requests WHERE id=?').get(id);}
  maintenanceRequests() {return this.db.prepare('SELECT r.*, (SELECT COUNT(*) FROM maintenance_notes n WHERE n.request_id=r.id) AS note_count FROM maintenance_requests r ORDER BY updated_at DESC, rowid DESC').all();}
  maintenanceNotes(id) {return this.db.prepare('SELECT * FROM maintenance_notes WHERE request_id=? ORDER BY id').all(id);}
  addMaintenanceNote(id,text) {
    if(!this.maintenanceRequest(id))throw new Error('개선 요청을 찾을 수 없습니다.');
    if(typeof text!=='string'||!text.trim()||text.trim().length>30000)throw new Error('추가 내용은 1~30,000자로 입력하세요.');
    return this.transaction(()=>{
      const now=this.now();
      const noteId=this.db.prepare('INSERT INTO maintenance_notes(request_id,text,created_at) VALUES (?,?,?)').run(id,text.trim(),now).lastInsertRowid;
      this.db.prepare('UPDATE maintenance_requests SET updated_at=? WHERE id=?').run(now,id);
      return this.db.prepare('SELECT * FROM maintenance_notes WHERE id=?').get(noteId);
    });
  }
  pending(id) { return this.db.prepare("SELECT * FROM messages WHERE task_id=? AND role='user' AND state='pending' ORDER BY id").all(id); }
  markMessages(ids, state) { for (const id of ids) this.db.prepare('UPDATE messages SET state=? WHERE id=?').run(state, id); }
  decision(taskId, kind, question, payload = {}) {
    return this.transaction(()=>{
      const id = randomUUID().slice(0,8);
      this.db.prepare('INSERT INTO decisions(id,task_id,kind,question,payload,created_at) VALUES (?,?,?,?,?,?)').run(id, taskId, kind, question, JSON.stringify(payload), this.now());
      this.event(taskId, 'decision', question);
      this.queueDecisionNotice(id,taskId,kind);
      return id;
    });
  }
  queueDecisionNotice(id,taskId,kind) {
    const task=this.get(taskId);
    this.enqueue(JSON.stringify({title:kind==='approval'?'Codex 실행 승인 대기':'Codex 결정 대기',body:task.title+' 작업에 답변이 필요합니다.',url:'/?view=decisions',tag:'codex-decision-'+id,decisionId:id}));
  }
  ensureDecisionNotices() {
    const notified=new Set(this.db.prepare('SELECT text FROM outbox').all().flatMap(row=>{try{const id=JSON.parse(row.text).decisionId;return id?[id]:[];}catch{return [];}}));
    for(const decision of this.decisions())if(!notified.has(decision.id)&&!this.get(decision.task_id)?.archived_at)this.queueDecisionNotice(decision.id,decision.task_id,decision.kind);
  }
  decisions(pending = true) { return this.db.prepare(`SELECT * FROM decisions ${pending ? "WHERE status='pending'" : ''} ORDER BY created_at`).all().map(r => ({...r, payload: JSON.parse(r.payload)})); }
  resolve(id, answer, status = 'resolved') { this.db.prepare("UPDATE decisions SET status=?,answer=?,resolved_at=? WHERE id=? AND status='pending'").run(status, answer, this.now(), id); }
  event(taskId, kind, detail) { this.db.prepare('INSERT INTO events(task_id,kind,detail,created_at) VALUES (?,?,?,?)').run(taskId, kind, typeof detail === 'string' ? detail : JSON.stringify(detail), this.now()); }
  events(taskId) { return this.db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY id DESC LIMIT 100').all(taskId); }
  once(key, fn) { return this.transaction(() => { const old = this.db.prepare('SELECT result FROM inbox WHERE key=?').get(key); if (old) return JSON.parse(old.result); const result = fn(); this.db.prepare('INSERT INTO inbox VALUES (?,?)').run(key, JSON.stringify(result)); return result; }); }
  enqueue(text) { this.db.prepare('INSERT INTO outbox(text,created_at) VALUES (?,?)').run(text, this.now()); }
  outbox() { return this.db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL ORDER BY id LIMIT 10').all(); }
  sent(id) { this.db.prepare('UPDATE outbox SET sent_at=? WHERE id=?').run(this.now(), id); }
  recover() {
    this.transaction(() => {
      for (const task of this.list().filter(t => ['running','waiting_approval'].includes(t.status))) {
        this.patch(task.id, { status: 'recovery', turn_id: null, error: '프로그램이 재시작되었습니다. 진행 기록과 결과물을 확인한 뒤 재개하세요.' });
        this.event(task.id, 'recovery', 'Previous live turn lost; never replaying pending approval.');
      }
      this.db.prepare("UPDATE decisions SET status='expired',resolved_at=? WHERE status='pending' AND kind='approval'").run(this.now());
    });
  }
  taskAttachmentIds(id) { return this.db.prepare('SELECT ma.attachment_id AS id FROM message_attachments ma JOIN messages m ON m.id=ma.message_id WHERE m.task_id=?').all(id).map(r=>r.id); }
  // Bytes this task occupies inside the database.
  taskRecordBytes(id) {
    const one=(sql)=>Number(this.db.prepare(sql).get(id)?.n||0);
    return {
      attachments:one('SELECT SUM(a.size) AS n FROM attachments a JOIN message_attachments ma ON a.id=ma.attachment_id JOIN messages m ON m.id=ma.message_id WHERE m.task_id=?'),
      records:one('SELECT SUM(LENGTH(CAST(text AS BLOB))) AS n FROM messages WHERE task_id=?')+one('SELECT SUM(LENGTH(CAST(question AS BLOB))+LENGTH(CAST(payload AS BLOB))) AS n FROM decisions WHERE task_id=?')+one('SELECT SUM(LENGTH(CAST(detail AS BLOB))) AS n FROM events WHERE task_id=?')
    };
  }
  // Removes every row that belongs to one task. Files are the caller's job.
  deleteTask(id) {
    return this.transaction(()=>{
      const attachments=this.taskAttachmentIds(id);
      const decisions=this.db.prepare('SELECT id FROM decisions WHERE task_id=?').all(id).map(r=>r.id);
      this.db.prepare('DELETE FROM message_attachments WHERE message_id IN (SELECT id FROM messages WHERE task_id=?)').run(id);
      for(const aid of attachments)this.db.prepare('DELETE FROM attachments WHERE id=?').run(aid);
      this.db.prepare('DELETE FROM messages WHERE task_id=?').run(id);
      this.db.prepare('DELETE FROM decisions WHERE task_id=?').run(id);
      this.db.prepare('DELETE FROM events WHERE task_id=?').run(id);
      for(const did of decisions)this.db.prepare('DELETE FROM outbox WHERE text LIKE ?').run('%"decisionId":"'+did+'"%');
      this.db.prepare("DELETE FROM inbox WHERE key LIKE ? OR result LIKE ?").run('message:'+id+':%','%"taskId":"'+id+'"%');
      this.db.prepare('DELETE FROM tasks WHERE id=?').run(id);
      return {attachments};
    });
  }
  // Returns freed pages to the file system; deleted rows otherwise keep the file size.
  compact() { this.db.exec('VACUUM'); }
  close() { this.db.close(); }
}
