import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { getOptionalRadarConfig, getRadarCallbackConfig } from "./config";
import { callbackSignature, canonicalLinkedInUrl, retryDelaySeconds } from "./contracts";
import { getSessionPage, saveSessionState, markNeedsReauth } from "@/lib/linkedin/session";
import { recordRuntimePause } from "./pause";
import { nativeThreadId, readWholeThread, type NativeMessage } from "@/lib/linkedin/radar-thread-reader";

export const managedClaimSchema = z.object({ schemaVersion:z.literal(1), conversationId:z.uuid(), marketId:z.uuid(), threadId:z.string().refine(v=>{try{nativeThreadId(v);return true;}catch{return false;}}), counterpart:z.url().refine(v=>/^https:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\//i.test(v)), claimId:z.uuid(), claimedBy:z.uuid(), from:z.iso.datetime({offset:true}), expiresAt:z.iso.datetime({offset:true}) }).strict();
export function requireRadarSecret(provided: unknown) {
  const expected=process.env.INTERNAL_API_SECRET;
  if(typeof provided!=="string" || !expected || !timingSafeEqual(createHash("sha256").update(provided).digest(),createHash("sha256").update(expected).digest())) throw Object.assign(new Error("Radar service authentication required"),{statusCode:401});
}
export function initializeManagedSchema(db:Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS radar_retired_scope (
    thread_hash TEXT PRIMARY KEY,scope_hash TEXT NOT NULL,retired_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS radar_retired_send (
    step_hash TEXT PRIMARY KEY,retired_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS radar_managed_thread (
    thread_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, conversation_id TEXT UNIQUE, market_id TEXT NOT NULL,
    counterpart TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('radar','usuario')), scope_id TEXT NOT NULL UNIQUE,
    from_at TEXT NOT NULL, expires_at TEXT NOT NULL, first_message_id TEXT, target_id TEXT,
    complete INTEGER NOT NULL DEFAULT 0, gap TEXT, manifest_hash TEXT, next_sync_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS radar_managed_outbox (
    event_id TEXT PRIMARY KEY, thread_id TEXT REFERENCES radar_managed_thread(thread_id) ON DELETE CASCADE,
    occurred_at TEXT NOT NULL, payload_json TEXT, payload_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL DEFAULT (datetime('now')), locked_at TEXT);
  CREATE TABLE IF NOT EXISTS radar_controlled_send (
    id TEXT PRIMARY KEY, step_key TEXT NOT NULL UNIQUE, target_id TEXT NOT NULL, account_id TEXT NOT NULL,
    market_id TEXT NOT NULL, counterpart TEXT NOT NULL, text TEXT, started_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('iniciado','incierto','confirmado')), expires_at TEXT NOT NULL,
    native_thread_id TEXT, native_message_id TEXT, source_context_hash TEXT, legacy_track_id TEXT,
    message_hash TEXT, last_message_hash TEXT, legacy_provenance INTEGER NOT NULL DEFAULT 0);`);
  const columns=db.prepare("PRAGMA table_info(radar_managed_thread)").all() as {name:string}[];
  if(!columns.some(c=>c.name==="manifest_hash"))db.exec("ALTER TABLE radar_managed_thread ADD COLUMN manifest_hash TEXT");
  const intentColumns=db.prepare("PRAGMA table_info(radar_controlled_send)").all() as {name:string}[];
  for(const [name,type] of [["source_context_hash","TEXT"],["legacy_track_id","TEXT"],["message_hash","TEXT"],["last_message_hash","TEXT"],["legacy_provenance","INTEGER NOT NULL DEFAULT 0"]]) {
    if(!intentColumns.some(c=>c.name===name))db.exec(`ALTER TABLE radar_controlled_send ADD COLUMN ${name} ${type}`);
  }
  if(db.prepare(`SELECT 1 FROM radar_controlled_send WHERE native_thread_id IS NOT NULL AND native_message_id IS NOT NULL
    GROUP BY account_id,native_thread_id,native_message_id HAVING count(*)>1 LIMIT 1`).get())throw new Error("Ambiguous controlled native binding; reconciliation required");
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS radar_controlled_native_identity ON radar_controlled_send(account_id,native_thread_id,native_message_id)
    WHERE native_thread_id IS NOT NULL AND native_message_id IS NOT NULL`);
}
const runtimeKey=()=>process.env.RADAR_RUNTIME_KEY?.trim() || null;
const hash=(v:string)=>`linki_managed_${createHash("sha256").update(v).digest("hex")}`;
type ControlledIntent={id:string;step_key:string;target_id:string;account_id:string;native_thread_id:string|null;source_context_hash:string|null;legacy_track_id:string|null;message_hash:string|null;last_message_hash:string|null;legacy_provenance:number};
const hasTable=(db:Database.Database,name:string)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
function ownedTrack(db:Database.Database,trackId:string,targetId:string,accountId:string) {
  return db.prepare(`SELECT t.id,t.last_linkedin_message FROM run_profile_tracks t
    JOIN run_profiles p ON p.id=t.run_profile_id JOIN runs r ON r.id=p.run_id
    WHERE t.id=? AND t.track='linkedin' AND p.target_id=? AND r.account_id=?`).get(trackId,targetId,accountId) as {id:string;last_linkedin_message:string|null}|undefined;
}
// Exact hashes survive callback ACK redaction; unknown old copies require explicit recovery.
function cleanupControlledDerivatives(db:Database.Database,intents:ControlledIntent[],retiredAt:string) {
  const ids=new Set(intents.map(i=>i.id));
  const remaining=db.prepare("SELECT id,target_id,source_context_hash,legacy_track_id,last_message_hash FROM radar_controlled_send").all() as Pick<ControlledIntent,"id"|"target_id"|"source_context_hash"|"legacy_track_id"|"last_message_hash">[];
  const targets=hasTable(db,"targets"),tracks=hasTable(db,"run_profile_tracks");
  for(const intent of intents) {
    const target=targets?db.prepare("SELECT icebreaker_context FROM targets WHERE id=?").get(intent.target_id) as {icebreaker_context:string|null}|undefined:undefined;
    if(!intent.legacy_provenance) {
      const oldTrack=tracks?db.prepare(`SELECT 1 FROM run_profile_tracks t JOIN run_profiles p ON p.id=t.run_profile_id
        JOIN runs r ON r.id=p.run_id WHERE p.target_id=? AND r.account_id=? AND t.track='linkedin' AND t.last_linkedin_message IS NOT NULL`).get(intent.target_id,intent.account_id):undefined;
      if(target?.icebreaker_context!==null && target?.icebreaker_context!==undefined || oldTrack)throw new Error("Legacy managed derivative provenance unavailable; cleanup pending");
    }
    if(target?.icebreaker_context!==null && target?.icebreaker_context!==undefined && intent.source_context_hash===hash(target.icebreaker_context)
      && !remaining.some(i=>!ids.has(i.id) && i.target_id===intent.target_id && i.source_context_hash===intent.source_context_hash)) {
      db.prepare("UPDATE targets SET icebreaker_context=NULL WHERE id=?").run(intent.target_id);
    }
    if(tracks && intent.legacy_track_id) {
      const owned=ownedTrack(db,intent.legacy_track_id,intent.target_id,intent.account_id);
      if(!owned && db.prepare("SELECT 1 FROM run_profile_tracks WHERE id=?").get(intent.legacy_track_id))throw new Error("Legacy managed track ownership differs; cleanup pending");
      if(owned?.last_linkedin_message!==null && owned?.last_linkedin_message!==undefined && intent.last_message_hash===hash(owned.last_linkedin_message)
        && !remaining.some(i=>!ids.has(i.id) && i.legacy_track_id===intent.legacy_track_id && i.last_message_hash===intent.last_message_hash)) {
        db.prepare("UPDATE run_profile_tracks SET last_linkedin_message=NULL WHERE id=?").run(owned.id);
      }
      if(owned && !remaining.some(i=>!ids.has(i.id) && i.legacy_track_id===intent.legacy_track_id)) {
        db.prepare("UPDATE run_profile_tracks SET state='skipped',next_step_at=NULL,error_message='Radar managed scope retired' WHERE id=? AND state NOT IN ('completed','failed','skipped')").run(owned.id);
      }
    }
    db.prepare("INSERT OR IGNORE INTO radar_retired_send(step_hash,retired_at) VALUES(?,?)").run(hash(intent.step_key),retiredAt);
    db.prepare("DELETE FROM radar_managed_outbox WHERE event_id=?").run(hash(`${intent.id}:incierto`));
  }
}
function queue(db:Database.Database,thread:string|null,eventId:string,occurredAt:string,data:Record<string,unknown>) {
  const payload={schemaVersion:1,eventId,eventType:"conversation.message",source:"linki",occurredAt,data:{runtimeKey:runtimeKey(),...data}};
  const raw=JSON.stringify(payload),fingerprint=createHash("sha256").update(raw).digest("hex");
  const prior=db.prepare("SELECT payload_hash FROM radar_managed_outbox WHERE event_id=?").get(eventId) as {payload_hash:string}|undefined;
  if(prior && prior.payload_hash!==fingerprint)throw new Error("Native callback replay diverged");
  db.prepare("INSERT OR IGNORE INTO radar_managed_outbox(event_id,thread_id,occurred_at,payload_json,payload_hash) VALUES(?,?,?,?,?)").run(eventId,thread,occurredAt,raw,fingerprint);
}
export function registerManagedClaim(input:z.infer<typeof managedClaimSchema>,db=getDb(),config=getOptionalRadarConfig()) {
  initializeManagedSchema(db);
  if(!config || !runtimeKey()) throw new Error("Managed runtime binding unavailable");
  if(Date.parse(input.from)>=Date.parse(input.expiresAt) || Date.parse(input.expiresAt)<=Date.now())throw new Error("Retention boundary invalid");
  if(db.prepare("SELECT 1 FROM radar_retired_scope WHERE thread_hash=?").get(hash(input.threadId)))throw new Error("Native scope retired");
  const counterpart=canonicalLinkedInUrl(input.counterpart);
  const previous=db.prepare("SELECT * FROM radar_managed_thread WHERE thread_id=? OR scope_id=?").get(input.threadId,input.claimId) as Record<string,unknown>|undefined;
  if(previous) {
    if(previous.thread_id!==input.threadId || previous.account_id!==config.accountId || previous.market_id!==input.marketId || previous.counterpart!==counterpart || previous.scope_id!==input.claimId || previous.conversation_id!==input.conversationId)throw new Error("Managed thread registration diverged");
    return {registered:true,duplicate:true};
  }
  db.prepare(`INSERT INTO radar_managed_thread(thread_id,account_id,conversation_id,market_id,counterpart,scope,scope_id,from_at,expires_at,gap) VALUES(?,?,?,?,?,'usuario',?,?,?,'Exact thread recovery pending')`).run(input.threadId,config.accountId,input.conversationId,input.marketId,counterpart,input.claimId,input.from,input.expiresAt);
  return {registered:true,duplicate:false};
}
export function prepareControlledSend(db:Database.Database,input:{stepKey:string;targetId:string;accountId:string;marketId:string;counterpart:string;text:string;trackId?:string;sourceContext?:string|null}) {
  initializeManagedSchema(db);
  if(db.prepare("SELECT 1 FROM radar_retired_send WHERE step_hash=?").get(hash(input.stepKey)))return {id:hash(input.stepKey),send:false,state:"retirado"};
  const prior=db.prepare("SELECT * FROM radar_controlled_send WHERE step_key=?").get(input.stepKey) as Record<string,unknown>|undefined;
  if(prior) {
    if(prior.target_id!==input.targetId || prior.account_id!==input.accountId || prior.market_id!==input.marketId || prior.counterpart!==canonicalLinkedInUrl(input.counterpart) || (prior.text!==null && prior.text!==input.text) || (input.trackId && prior.legacy_track_id!==input.trackId))throw new Error("Controlled intent replay diverged");
    return {id:String(prior.id),send:false,state:String(prior.state)};
  }
  const id=randomUUID(),started=new Date().toISOString(),expires=new Date();expires.setUTCMonth(expires.getUTCMonth()+24);
  db.transaction(()=>{
    if(hasTable(db,"run_profile_tracks") && (!input.trackId || !ownedTrack(db,input.trackId,input.targetId,input.accountId)))throw new Error("Controlled legacy track ownership required");
    const target=hasTable(db,"targets")?db.prepare("SELECT icebreaker_context FROM targets WHERE id=?").get(input.targetId) as {icebreaker_context:string|null}|undefined:undefined;
    const source=input.sourceContext===undefined?target?.icebreaker_context:input.sourceContext;
    const sourceHash=source===null || source===undefined?null:hash(source);
    db.prepare(`INSERT INTO radar_controlled_send(id,step_key,target_id,account_id,market_id,counterpart,text,started_at,state,expires_at,source_context_hash,legacy_track_id,message_hash,legacy_provenance) VALUES(?,?,?,?,?,?,?,?,'iniciado',?,?,?,?,1)`).run(id,input.stepKey,input.targetId,input.accountId,input.marketId,canonicalLinkedInUrl(input.counterpart),input.text,started,expires.toISOString(),sourceHash,input.trackId??null,hash(input.text));
  })();
  return {id,send:true,state:"iniciado"};
}
export function recordControlledLegacyContext(db:Database.Database,id:string,trackId:string,text:string) {
  return db.transaction(()=>{
    const intent=db.prepare("SELECT * FROM radar_controlled_send WHERE id=?").get(id) as ControlledIntent & {state:string}|undefined;
    if(!intent || intent.state!=="confirmado" || !intent.native_thread_id)return false;
    const thread=db.prepare("SELECT account_id FROM radar_managed_thread WHERE thread_id=?").get(intent.native_thread_id) as {account_id:string}|undefined;
    if(!thread || thread.account_id!==intent.account_id || db.prepare("SELECT 1 FROM radar_retired_scope WHERE thread_hash=?").get(hash(intent.native_thread_id)))return false;
    if(intent.legacy_track_id!==trackId || !ownedTrack(db,trackId,intent.target_id,intent.account_id))throw new Error("Controlled legacy track ownership differs");
    // The hash is bound before dispatch, so ACK redaction cannot remove this guard.
    if(intent.message_hash!==hash(text))throw new Error("Controlled legacy message differs");
    db.prepare("UPDATE run_profile_tracks SET last_linkedin_message=? WHERE id=?").run(text,trackId);
    db.prepare("UPDATE radar_controlled_send SET last_message_hash=? WHERE id=?").run(hash(text),id);
    return true;
  })();
}
export function recordControlledOutcome(db:Database.Database,id:string,proof:NativeMessage|null) {
  const intent=db.prepare("SELECT * FROM radar_controlled_send WHERE id=?").get(id) as Record<string,string>;
  if(!intent)throw new Error("Controlled intent absent");
  if(proof && (proof.direction!=="saliente" || (intent.text===null?intent.message_hash!==hash(proof.text):proof.text!==intent.text) || Date.parse(proof.occurredAt)<Date.parse(intent.started_at)-1000))throw new Error("Native receipt does not prove controlled intent");
  if(proof && intent.native_thread_id && (intent.native_thread_id!==proof.threadId || intent.native_message_id!==proof.id))throw new Error("Controlled native binding is immutable");
  db.transaction(()=>{
    if(!proof) {
      db.prepare("UPDATE radar_controlled_send SET state='incierto' WHERE id=? AND state='iniciado'").run(id);
      queue(db,null,hash(`${id}:incierto`),intent.started_at,{kind:"gap",intentId:id,marketId:intent.market_id,counterpart:intent.counterpart,reason:"native_send_receipt_unavailable",expiresAt:intent.expires_at});return;
    }
    if(db.prepare("SELECT 1 FROM radar_retired_scope WHERE thread_hash=?").get(hash(proof.threadId)))throw new Error("Native scope retired");
    const existing=db.prepare("SELECT * FROM radar_managed_thread WHERE thread_id=?").get(proof.threadId) as Record<string,string>|undefined;
    if(existing && (existing.account_id!==intent.account_id || existing.market_id!==intent.market_id || existing.counterpart!==intent.counterpart))throw new Error("Native thread scope diverged");
    db.prepare(`INSERT OR IGNORE INTO radar_managed_thread(thread_id,account_id,market_id,counterpart,scope,scope_id,from_at,expires_at,first_message_id,target_id,gap) VALUES(?,?,?,?,'radar',?,?,?,?,?,'Exact thread recovery pending')`).run(proof.threadId,intent.account_id,intent.market_id,intent.counterpart,id,proof.occurredAt,intent.expires_at,proof.id,intent.target_id);
    db.prepare("UPDATE radar_controlled_send SET state='confirmado',native_thread_id=?,native_message_id=? WHERE id=?").run(proof.threadId,proof.id,id);
    enqueueNativeMessage(db,proof.threadId,proof,id);
  })();
}
export function enqueueNativeMessage(db:Database.Database,threadId:string,message:NativeMessage,intentId:string|null=null) {
  const thread=db.prepare("SELECT * FROM radar_managed_thread WHERE thread_id=?").get(threadId) as Record<string,string>;
  if(!thread || message.threadId!==threadId || Date.parse(message.occurredAt)<Date.parse(thread.from_at))return false;
  const bindings=db.prepare(`SELECT id,started_at FROM radar_controlled_send WHERE account_id=?
    AND native_thread_id=? AND native_message_id=? LIMIT 2`).all(thread.account_id,threadId,message.id) as {id:string;started_at:string}[];
  if(bindings.length>1)throw new Error("Ambiguous controlled native binding; reconciliation required");
  const intent=bindings[0];
  if(intentId!==null && intent?.id!==intentId)throw new Error("Controlled native binding differs");
  queue(db,threadId,hash(`${runtimeKey()}:${threadId}:${message.id}`),message.occurredAt,{kind:"message",intentId:intent?.id??null,marketId:thread.market_id,conversationId:thread.conversation_id??null,threadId,counterpart:thread.counterpart,scope:thread.scope,scopeId:thread.scope_id,from:thread.from_at,firstMessageId:thread.first_message_id??null,dispatch:intent?{startedAt:intent.started_at,ordinal:1}:null,message});
  return true;
}
export function expireManaged(db:Database.Database,now=new Date()) {
  initializeManagedSchema(db);
  db.transaction(()=>{
    const boundary=now.toISOString();
    const old=db.prepare(`SELECT i.* FROM radar_controlled_send i WHERE
      i.native_thread_id IN (SELECT thread_id FROM radar_managed_thread WHERE expires_at<=?) OR
      (i.expires_at<=? AND NOT EXISTS(SELECT 1 FROM radar_managed_thread t WHERE t.thread_id=i.native_thread_id))`).all(boundary,boundary) as ControlledIntent[];
    cleanupControlledDerivatives(db,old,boundary);
    const threads=db.prepare("SELECT thread_id,scope_id FROM radar_managed_thread WHERE expires_at<=?").all(boundary) as {thread_id:string;scope_id:string}[];
    for(const thread of threads)db.prepare("INSERT OR IGNORE INTO radar_retired_scope(thread_hash,scope_hash,retired_at) VALUES(?,?,?)").run(hash(thread.thread_id),hash(thread.scope_id),boundary);
    db.prepare("DELETE FROM radar_managed_thread WHERE expires_at<=?").run(boundary);
    for(const intent of old)db.prepare("DELETE FROM radar_controlled_send WHERE id=?").run(intent.id);
  })();
}
export async function syncManagedThreads(accountId:string,db=getDb()) {
  initializeManagedSchema(db);expireManaged(db);
  const config=getOptionalRadarConfig();if(config?.accountId!==accountId)return 0;
  const threads=db.prepare("SELECT * FROM radar_managed_thread WHERE account_id=? AND datetime(next_sync_at)<=datetime('now') ORDER BY next_sync_at LIMIT 1").all(accountId) as Record<string,string>[];
  if(!threads.length)return 0;
  const thread=threads[0],page=await getSessionPage(accountId);let valid=true;
  try {
    await page.goto(`https://www.linkedin.com/messaging/thread/${encodeURIComponent(thread.thread_id.split(":").at(-1)!)}/`,{waitUntil:"domcontentloaded",timeout:35000});
    if(/\/login|\/checkpoint|\/authwall|\/uas\//.test(page.url())){valid=false;throw new Error("Managed runtime requires authentication");}
    const messages=await readWholeThread(page,thread.thread_id,thread.counterpart,{onPage:messages=>db.transaction(()=>{
      for(const message of messages)enqueueNativeMessage(db,thread.thread_id,message);
      const reply=messages.filter(m=>m.direction==="entrante" && Date.parse(m.occurredAt)>=Date.parse(thread.from_at)).sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt))[0];
      if(reply && thread.target_id) {
        db.prepare("UPDATE targets SET last_replied_at=?,radar_status='REPLIED' WHERE id=? AND (last_replied_at IS NULL OR last_replied_at<?)").run(reply.occurredAt,thread.target_id,reply.occurredAt);
        db.prepare("UPDATE run_profile_tracks SET state='skipped',next_step_at=NULL,error_message='Lead replied on LinkedIn' WHERE run_profile_id IN (SELECT id FROM run_profiles WHERE target_id=?) AND state NOT IN ('completed','failed','skipped')").run(thread.target_id);
      }
    })()});
    const latest=messages.reduce((v,m)=>m.occurredAt>v?m.occurredAt:v,thread.from_at),expiry=new Date(latest);expiry.setUTCMonth(expiry.getUTCMonth()+24);
    db.transaction(()=>{db.prepare("UPDATE radar_managed_thread SET expires_at=? WHERE thread_id=? AND expires_at<?").run(expiry.toISOString(),thread.thread_id,expiry.toISOString());
      for(const message of messages)enqueueNativeMessage(db,thread.thread_id,message);
      db.prepare("UPDATE radar_managed_thread SET complete=1,gap=NULL,next_sync_at=datetime('now','+15 minutes') WHERE thread_id=?").run(thread.thread_id);
      const ids=messages.filter(m=>Date.parse(m.occurredAt)>=Date.parse(thread.from_at)).map(m=>m.id).sort(),manifest=hash(ids.join("|"));
      if(thread.complete!=="1" && Number(thread.complete)!==1 || thread.manifest_hash!==manifest) {
        const observedAt=new Date().toISOString();
        queue(db,thread.thread_id,hash(`${thread.thread_id}:complete:${manifest}:${observedAt}`),observedAt,{kind:"recovery",marketId:thread.market_id,threadId:thread.thread_id,conversationId:thread.conversation_id??null,complete:true,messageIds:ids});
      }
      db.prepare("UPDATE radar_managed_thread SET manifest_hash=? WHERE thread_id=?").run(manifest,thread.thread_id);})();return messages.length;
  } catch(error) {
    const status=(error as {status?:number}).status;if(status && [401,403,429,999].includes(status))recordRuntimePause(db,status===429?"rate_limited":"challenge");
    db.prepare("UPDATE radar_managed_thread SET complete=0,gap='Native exact-thread recovery unavailable',next_sync_at=datetime('now','+15 minutes') WHERE thread_id=?").run(thread.thread_id);
    queue(db,thread.thread_id,hash(`${thread.thread_id}:gap:${new Date().toISOString()}`),new Date().toISOString(),{kind:"recovery",marketId:thread.market_id,threadId:thread.thread_id,conversationId:thread.conversation_id??null,complete:false});throw error;
  } finally {await page.close().catch(()=>{});if(valid)await saveSessionState(accountId).catch(()=>{});else await markNeedsReauth(accountId).catch(()=>{});}
}
export async function processManagedCallbacks(db:Database.Database,{fetchImpl=fetch}={}) {
  initializeManagedSchema(db);expireManaged(db);
  const abandoned=db.prepare("SELECT id FROM radar_controlled_send WHERE state='iniciado' AND datetime(started_at)<datetime('now','-15 minutes')").all() as {id:string}[];
  for(const intent of abandoned)recordControlledOutcome(db,intent.id,null);
  const callback=getRadarCallbackConfig();if(!callback)return;
  db.prepare("UPDATE radar_managed_outbox SET status='pending',locked_at=NULL WHERE status='sending' AND datetime(locked_at)<datetime('now','-5 minutes')").run();
  const rows=db.prepare("SELECT * FROM radar_managed_outbox WHERE status='pending' AND datetime(next_attempt_at)<=datetime('now') ORDER BY occurred_at,event_id LIMIT 20").all() as Record<string,string|number>[];
  for(const row of rows) {
    if(!db.prepare("UPDATE radar_managed_outbox SET status='sending',locked_at=datetime('now') WHERE event_id=? AND status='pending'").run(row.event_id).changes)continue;
    const timestamp=String(Math.floor(Date.now()/1000));
    try {
      const response=await fetchImpl(callback.url,{method:"POST",headers:{"content-type":"application/json","x-omnichannel-timestamp":timestamp,"x-omnichannel-signature":callbackSignature(callback.secret,timestamp,String(row.payload_json))},body:String(row.payload_json),signal:AbortSignal.timeout(15000)});
      const ack=await response.json();if(!response.ok || ack.normalizado!==true)throw new Error("Radar has not acknowledged durable normalized evidence");
      const acknowledged=JSON.parse(String(row.payload_json)).data;
      if(ack.motivo==="alcance_retirado" && acknowledged.kind==="message") {
        retireManagedScope({schemaVersion:1,runtimeKey:runtimeKey()!,threadId:acknowledged.threadId,scopeId:acknowledged.scopeId,retirementId:randomUUID()},db);
        continue;
      }
      db.transaction(()=>{db.prepare("UPDATE radar_managed_outbox SET status='sent',payload_json=NULL,locked_at=NULL WHERE event_id=?").run(row.event_id);
        const data=JSON.parse(String(row.payload_json)).data;if(data.intentId)db.prepare("UPDATE radar_controlled_send SET text=NULL WHERE id=? AND state='confirmado'").run(data.intentId);})();
    }catch{const attempts=Number(row.attempts)+1;db.prepare("UPDATE radar_managed_outbox SET status='pending',attempts=?,next_attempt_at=?,locked_at=NULL WHERE event_id=?").run(attempts,new Date(Date.now()+retryDelaySeconds(attempts)*1000).toISOString(),row.event_id);}
  }
}

export const managedRetirementSchema=z.object({schemaVersion:z.literal(1),runtimeKey:z.string().min(1),threadId:z.string().refine(v=>{try{nativeThreadId(v);return true;}catch{return false;}}),scopeId:z.uuid(),retirementId:z.uuid()}).strict();
export function retireManagedScope(input:z.infer<typeof managedRetirementSchema>,db=getDb(),config=getOptionalRadarConfig()) {
 initializeManagedSchema(db);
 if(!runtimeKey()||input.runtimeKey!==runtimeKey())throw new Error("Runtime retirement binding invalid");
 return db.transaction(()=>{
  const row=db.prepare('SELECT * FROM radar_managed_thread WHERE thread_id=?').get(input.threadId) as Record<string,string>|undefined;
  if(row && (row.scope_id!==input.scopeId||!config||row.account_id!==config.accountId))throw new Error('Retirement scope differs');
  const previous=db.prepare('SELECT scope_hash FROM radar_retired_scope WHERE thread_hash=?').get(hash(input.threadId)) as {scope_hash:string}|undefined;
  if(previous && previous.scope_hash!==hash(input.scopeId))throw new Error('Retirement scope differs');
  const intents=db.prepare('SELECT * FROM radar_controlled_send WHERE native_thread_id=? OR id=?').all(input.threadId,input.scopeId) as ControlledIntent[];
  if(intents.some(i=>!config || i.account_id!==config.accountId || i.native_thread_id!==input.threadId))throw new Error('Retirement scope differs');
  const retiredAt=new Date().toISOString();
  cleanupControlledDerivatives(db,intents,retiredAt);
  db.prepare('INSERT OR IGNORE INTO radar_retired_scope(thread_hash,scope_hash,retired_at) VALUES(?,?,?)').run(hash(input.threadId),hash(input.scopeId),retiredAt);
  db.prepare('DELETE FROM radar_managed_thread WHERE thread_id=?').run(input.threadId);
  db.prepare('DELETE FROM radar_controlled_send WHERE native_thread_id=? OR id=?').run(input.threadId,input.scopeId);
  return {retired:true};
 })();
}
