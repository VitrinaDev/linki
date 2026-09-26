import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import {
  enqueueNativeMessage, expireManaged, initializeManagedSchema, prepareControlledSend, processManagedCallbacks,
  recordControlledLegacyContext, recordControlledOutcome, registerManagedClaim, retireManagedScope,
} from "../lib/radar/managed-conversations";

const body="  Restricted managed outbound fixture\nverbatim  ";
const counterpart="https://www.linkedin.com/in/ana";
const config={accountId:"owned-account",workflowId:"workflow",listId:"list"};
function fixture() {
  process.env.RADAR_RUNTIME_KEY="retirement-fixture";
  const db=new Database(":memory:");db.pragma("foreign_keys=ON");
  db.exec(`CREATE TABLE targets(id TEXT PRIMARY KEY,icebreaker_context TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,account_id TEXT NOT NULL);
    CREATE TABLE run_profiles(id TEXT PRIMARY KEY,run_id TEXT REFERENCES runs(id),target_id TEXT REFERENCES targets(id));
    CREATE TABLE run_profile_tracks(id TEXT PRIMARY KEY,run_profile_id TEXT REFERENCES run_profiles(id),track TEXT,
      state TEXT,next_step_at TEXT,error_message TEXT,last_linkedin_message TEXT);`);
  initializeManagedSchema(db);
  const target=randomUUID();db.prepare("INSERT INTO targets VALUES(?,?)").run(target,body);
  return {db,target};
}
function track(db:Database.Database,target:string,account=config.accountId,state="completed") {
  const run=randomUUID(),profile=randomUUID(),id=randomUUID();
  db.prepare("INSERT INTO runs VALUES(?,?)").run(run,account);
  db.prepare("INSERT INTO run_profiles VALUES(?,?,?)").run(profile,run,target);
  db.prepare("INSERT INTO run_profile_tracks VALUES(?,?,'linkedin',?,NULL,NULL,NULL)").run(id,profile,state);
  return id;
}
function controlled(db:Database.Database,target:string,trackId:string,name="first",text=body) {
  const request={stepKey:`${trackId}:${name}`,targetId:target,accountId:config.accountId,marketId:randomUUID(),counterpart,text,trackId};
  const intent=prepareControlledSend(db,request),threadId=`urn:li:fs_conversation:${name}`;
  recordControlledOutcome(db,intent.id,{id:`urn:li:fs_event:(${name},message)`,threadId,direction:"saliente",occurredAt:new Date().toISOString(),text,type:"texto"});
  assert.equal(recordControlledLegacyContext(db,intent.id,trackId,text),true);
  const retirement={schemaVersion:1 as const,runtimeKey:"retirement-fixture",threadId,scopeId:intent.id,retirementId:randomUUID()};
  return {request,intent,threadId,retirement};
}
function source(db:Database.Database,target:string) {return (db.prepare("SELECT icebreaker_context AS body FROM targets WHERE id=?").get(target) as {body:string|null}).body;}
function copy(db:Database.Database,trackId:string) {return (db.prepare("SELECT last_linkedin_message AS body FROM run_profile_tracks WHERE id=?").get(trackId) as {body:string|null}).body;}
function count(db:Database.Database,table:string) {return (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n:number}).n;}

test("retirement clears exact source and completed track after ACK redaction, and rejects late copies and retries",async()=>{
  const {db,target}=fixture(),trackId=track(db,target),c=controlled(db,target,trackId);
  process.env.RADAR_CALLBACK_URL="http://example.invalid/callback";process.env.RADAR_CALLBACK_SECRET="synthetic-local-only";
  try {
    await processManagedCallbacks(db,{fetchImpl:async()=>new Response(JSON.stringify({normalizado:true}),{status:200})});
    assert.equal((db.prepare("SELECT text FROM radar_controlled_send WHERE id=?").get(c.intent.id) as {text:null}).text,null);
    assert.equal(retireManagedScope(c.retirement,db,config).retired,true);
    assert.equal(source(db,target),null);assert.equal(copy(db,trackId),null);
    for(const table of ["radar_managed_thread","radar_managed_outbox","radar_controlled_send"])assert.equal(count(db,table),0);
    assert.equal(recordControlledLegacyContext(db,c.intent.id,trackId,body),false);
    assert.equal(prepareControlledSend(db,c.request).state,"retirado");
    assert.equal(prepareControlledSend(db,c.request).send,false);
    assert.equal(retireManagedScope(c.retirement,db,config).retired,true);
    const graves=JSON.stringify(db.prepare("SELECT * FROM radar_retired_scope").all())+JSON.stringify(db.prepare("SELECT * FROM radar_retired_send").all());
    for(const sensitive of [body,c.threadId,c.intent.id,c.request.stepKey])assert.equal(graves.includes(sensitive),false);
  } finally {db.close();delete process.env.RADAR_CALLBACK_URL;delete process.env.RADAR_CALLBACK_SECRET;}
});

test("another live native thread sharing the target preserves its source and its own copy",()=>{
  const {db,target}=fixture(),firstTrack=track(db,target),secondTrack=track(db,target);
  const first=controlled(db,target,firstTrack,"first"),second=controlled(db,target,secondTrack,"second");
  retireManagedScope(first.retirement,db,config);
  assert.equal(source(db,target),body);assert.equal(copy(db,firstTrack),null);assert.equal(copy(db,secondTrack),body);
  assert.equal(count(db,"radar_managed_thread"),1);
  retireManagedScope(second.retirement,db,config);
  assert.equal(source(db,target),null);assert.equal(copy(db,secondTrack),null);db.close();
});

test("multiple threads sharing an owned track preserve the live thread's identical copy",()=>{
  const {db,target}=fixture(),trackId=track(db,target,config.accountId,"in_progress");
  const first=controlled(db,target,trackId,"first"),second=controlled(db,target,trackId,"second");
  retireManagedScope(first.retirement,db,config);
  assert.equal(copy(db,trackId),body);
  assert.equal((db.prepare("SELECT state FROM run_profile_tracks WHERE id=?").get(trackId) as {state:string}).state,"in_progress");
  retireManagedScope(second.retirement,db,config);
  assert.equal(copy(db,trackId),null);
  assert.equal((db.prepare("SELECT state FROM run_profile_tracks WHERE id=?").get(trackId) as {state:string}).state,"skipped");db.close();
});

test("retirement preserves changed context, changed track text, another account and unrelated targets",()=>{
  const {db,target}=fixture(),owned=track(db,target),foreign=track(db,target,"other-account","in_progress");
  const otherTarget=randomUUID();db.prepare("INSERT INTO targets VALUES(?,?)").run(otherTarget,body);
  const unrelated=track(db,otherTarget),c=controlled(db,target,owned);
  db.prepare("UPDATE targets SET icebreaker_context='New unrelated context' WHERE id=?").run(target);
  db.prepare("UPDATE run_profile_tracks SET last_linkedin_message=? WHERE id IN (?,?)").run(body,foreign,unrelated);
  db.prepare("UPDATE run_profile_tracks SET last_linkedin_message='New unrelated message' WHERE id=?").run(owned);
  retireManagedScope(c.retirement,db,config);
  assert.equal(source(db,target),"New unrelated context");assert.equal(copy(db,owned),"New unrelated message");
  assert.equal(copy(db,foreign),body);assert.equal(source(db,otherTarget),body);assert.equal(copy(db,unrelated),body);
  assert.equal((db.prepare("SELECT state FROM run_profile_tracks WHERE id=?").get(foreign) as {state:string}).state,"in_progress");db.close();
});

test("wrong-account tracks and unproven legacy message bodies cannot be registered",()=>{
  const {db,target}=fixture(),foreign=track(db,target,"other-account"),owned=track(db,target);
  const request={stepKey:"step",targetId:target,accountId:config.accountId,marketId:randomUUID(),counterpart,text:body};
  assert.throws(()=>prepareControlledSend(db,request),/ownership required/);
  assert.throws(()=>prepareControlledSend(db,{...request,trackId:foreign}),/ownership required/);
  const c=controlled(db,target,owned);db.prepare("UPDATE radar_controlled_send SET text=NULL WHERE id=?").run(c.intent.id);
  assert.throws(()=>recordControlledLegacyContext(db,c.intent.id,owned,"Different after ACK"),/message differs/);
  assert.equal(copy(db,owned),body);db.close();
});

test("source provenance uses the rendered snapshot, preserving a newer source written before dispatch",()=>{
  const {db,target}=fixture(),trackId=track(db,target);
  db.prepare("UPDATE targets SET icebreaker_context='New context during asynchronous lookup' WHERE id=?").run(target);
  const intent=prepareControlledSend(db,{stepKey:"snapshot-step",targetId:target,accountId:config.accountId,marketId:randomUUID(),counterpart,text:body,trackId,sourceContext:body});
  const threadId="urn:li:fs_conversation:snapshot";
  recordControlledOutcome(db,intent.id,{id:"urn:li:fs_event:(snapshot,message)",threadId,direction:"saliente",occurredAt:new Date().toISOString(),text:body,type:"texto"});
  recordControlledLegacyContext(db,intent.id,trackId,body);
  retireManagedScope({schemaVersion:1,runtimeKey:"retirement-fixture",threadId,scopeId:intent.id,retirementId:randomUUID()},db,config);
  assert.equal(source(db,target),"New context during asynchronous lookup");assert.equal(copy(db,trackId),null);db.close();
});

test("a failed derivative cleanup rolls back source, message, managed outbox and tombstones together",()=>{
  const {db,target}=fixture(),trackId=track(db,target),c=controlled(db,target,trackId);
  db.exec("CREATE TRIGGER reject_copy_cleanup BEFORE UPDATE OF last_linkedin_message ON run_profile_tracks WHEN NEW.last_linkedin_message IS NULL BEGIN SELECT RAISE(ABORT,'cleanup fixture failure'); END");
  assert.throws(()=>retireManagedScope(c.retirement,db,config),/fixture failure/);
  assert.equal(source(db,target),body);assert.equal(copy(db,trackId),body);
  assert.equal(count(db,"radar_managed_thread"),1);assert.equal(count(db,"radar_managed_outbox"),1);
  assert.equal(count(db,"radar_controlled_send"),1);assert.equal(count(db,"radar_retired_scope"),0);assert.equal(count(db,"radar_retired_send"),0);
  db.exec("DROP TRIGGER reject_copy_cleanup");assert.equal(retireManagedScope(c.retirement,db,config).retired,true);db.close();
});

test("old unknown provenance stays visibly pending and never acknowledges a false cleanup",()=>{
  const {db,target}=fixture(),trackId=track(db,target),c=controlled(db,target,trackId);
  db.prepare("UPDATE radar_controlled_send SET legacy_provenance=0,source_context_hash=NULL,legacy_track_id=NULL,last_message_hash=NULL WHERE id=?").run(c.intent.id);
  initializeManagedSchema(db);initializeManagedSchema(db);
  assert.throws(()=>retireManagedScope(c.retirement,db,config),/provenance unavailable; cleanup pending/);
  assert.throws(()=>expireManaged(db,new Date("2100-01-01T00:00:00Z")),/cleanup pending/);
  assert.equal(source(db,target),body);assert.equal(copy(db,trackId),body);
  assert.equal(count(db,"radar_managed_thread"),1);assert.equal(count(db,"radar_retired_scope"),0);db.close();
});

test("an existing draft schema upgrades idempotently without guessing legacy provenance",()=>{
  const db=new Database(":memory:");
  db.exec(`CREATE TABLE radar_controlled_send(id TEXT PRIMARY KEY,step_key TEXT UNIQUE,target_id TEXT,account_id TEXT,
    market_id TEXT,counterpart TEXT,text TEXT,started_at TEXT,state TEXT,expires_at TEXT,native_thread_id TEXT,native_message_id TEXT);
    INSERT INTO radar_controlled_send(id,step_key,text) VALUES('legacy','legacy-step','Unknown legacy source');`);
  initializeManagedSchema(db);initializeManagedSchema(db);
  const old=db.prepare("SELECT legacy_provenance,source_context_hash,legacy_track_id,message_hash,last_message_hash FROM radar_controlled_send WHERE id='legacy'").get();
  assert.deepEqual(old,{legacy_provenance:0,source_context_hash:null,legacy_track_id:null,message_hash:null,last_message_hash:null});db.close();
});

test("independent expiry uses the same exact cleanup while preserving a live parent's clock",()=>{
  const {db,target}=fixture(),firstTrack=track(db,target),secondTrack=track(db,target);
  const first=controlled(db,target,firstTrack,"first");controlled(db,target,secondTrack,"second");
  const boundary=new Date("2026-10-01T00:00:00Z");
  db.prepare("UPDATE radar_managed_thread SET expires_at='2026-09-30T00:00:00Z' WHERE thread_id=?").run(first.threadId);
  db.prepare("UPDATE radar_controlled_send SET expires_at='2026-09-30T00:00:00Z'").run();
  expireManaged(db,boundary);
  assert.equal(source(db,target),body);assert.equal(copy(db,firstTrack),null);assert.equal(copy(db,secondTrack),body);
  assert.equal(count(db,"radar_controlled_send"),1);assert.equal(count(db,"radar_managed_thread"),1);
  assert.equal(recordControlledLegacyContext(db,first.intent.id,firstTrack,body),false);
  assert.equal(prepareControlledSend(db,first.request).send,false);
  expireManaged(db,new Date("2100-01-01T00:00:00Z"));
  assert.equal(source(db,target),null);assert.equal(copy(db,secondTrack),null);
  assert.equal(count(db,"radar_controlled_send"),0);db.close();
});

test("every controlled outbound in one native thread replays the exact dispatch association after ACK",async()=>{
  const {db,target}=fixture(),trackId=track(db,target),marketId=randomUUID(),threadId="urn:li:fs_conversation:continuation";
  const base={targetId:target,accountId:config.accountId,marketId,counterpart,trackId};
  const first=prepareControlledSend(db,{...base,stepKey:"one",text:"First controlled message"});
  const proof={id:"urn:li:fs_event:(continuation,one)",threadId,direction:"saliente" as const,occurredAt:new Date().toISOString(),text:"First controlled message",type:"texto" as const};
  recordControlledOutcome(db,first.id,proof);
  const second=prepareControlledSend(db,{...base,stepKey:"two",text:"Later controlled message"});
  const later={...proof,id:"urn:li:fs_event:(continuation,two)",text:"Later controlled message"};
  recordControlledOutcome(db,second.id,later);
  const originals=db.prepare("SELECT event_id,payload_hash FROM radar_managed_outbox ORDER BY event_id").all();
  assert.equal(enqueueNativeMessage(db,threadId,later),true);assert.equal(enqueueNativeMessage(db,threadId,proof),true);
  process.env.RADAR_CALLBACK_URL="http://example.invalid/callback";process.env.RADAR_CALLBACK_SECRET="synthetic-local-only";
  try {
    await processManagedCallbacks(db,{fetchImpl:async()=>new Response(JSON.stringify({normalizado:true}),{status:200})});
    assert.equal(enqueueNativeMessage(db,threadId,later),true);assert.equal(enqueueNativeMessage(db,threadId,proof),true);
    recordControlledOutcome(db,second.id,later);
    assert.deepEqual(db.prepare("SELECT event_id,payload_hash FROM radar_managed_outbox ORDER BY event_id").all(),originals);
    assert.equal(count(db,"radar_managed_outbox"),2);assert.equal(count(db,"radar_managed_thread"),1);
    const stored=db.prepare("SELECT scope_id,first_message_id FROM radar_managed_thread WHERE thread_id=?").get(threadId);
    assert.deepEqual(stored,{scope_id:first.id,first_message_id:proof.id});
    assert.throws(()=>enqueueNativeMessage(db,threadId,later,first.id),/binding differs/);
    assert.throws(()=>recordControlledOutcome(db,second.id,{...later,id:"urn:li:fs_event:(continuation,rewritten)"}),/immutable/);
  } finally {db.close();delete process.env.RADAR_CALLBACK_URL;delete process.env.RADAR_CALLBACK_SECRET;}
});

test("a controlled outbound in a claimed native thread preserves the human scope and history boundary",()=>{
  const {db,target}=fixture(),trackId=track(db,target),marketId=randomUUID(),threadId="urn:li:fs_conversation:claimed",claimId=randomUUID();
  const from=new Date(Date.now()-86400000).toISOString(),expires=new Date(Date.now()+86400000).toISOString();
  registerManagedClaim({schemaVersion:1,conversationId:randomUUID(),marketId,threadId,counterpart,claimId,claimedBy:randomUUID(),from,expiresAt:expires},db,config);
  const intent=prepareControlledSend(db,{stepKey:"claimed-send",targetId:target,accountId:config.accountId,marketId,counterpart,trackId,text:body});
  const proof={id:"urn:li:fs_event:(claimed,message)",threadId,direction:"saliente" as const,occurredAt:new Date().toISOString(),text:body,type:"texto" as const};
  recordControlledOutcome(db,intent.id,proof);
  const original=(db.prepare("SELECT payload_hash FROM radar_managed_outbox").get() as {payload_hash:string}).payload_hash;
  db.prepare("UPDATE radar_controlled_send SET text=NULL").run();db.prepare("UPDATE radar_managed_outbox SET payload_json=NULL,status='sent'").run();
  assert.equal(enqueueNativeMessage(db,threadId,proof),true);
  assert.equal((db.prepare("SELECT payload_hash FROM radar_managed_outbox").get() as {payload_hash:string}).payload_hash,original);
  assert.deepEqual(db.prepare("SELECT scope,scope_id,from_at,first_message_id FROM radar_managed_thread").get(),{scope:"usuario",scope_id:claimId,from_at:from,first_message_id:null});
  assert.equal(count(db,"radar_managed_thread"),1);db.close();
});

test("native intent identity is unique and legacy ambiguity fails closed without selecting a body match",()=>{
  const {db,target}=fixture(),trackId=track(db,target),c=controlled(db,target,trackId);
  const proof={id:"urn:li:fs_event:(first,message)",threadId:c.threadId,direction:"saliente" as const,occurredAt:new Date().toISOString(),text:body,type:"texto" as const};
  const second=prepareControlledSend(db,{...c.request,stepKey:"other-intent"});
  assert.throws(()=>recordControlledOutcome(db,second.id,proof),/UNIQUE/);
  assert.equal((db.prepare("SELECT state FROM radar_controlled_send WHERE id=?").get(second.id) as {state:string}).state,"iniciado");
  assert.equal(count(db,"radar_managed_outbox"),1);
  db.exec("DROP INDEX radar_controlled_native_identity");
  db.prepare("UPDATE radar_controlled_send SET native_thread_id=?,native_message_id=? WHERE id=?").run(c.threadId,proof.id,second.id);
  assert.throws(()=>enqueueNativeMessage(db,c.threadId,proof),/Ambiguous controlled native binding/);
  assert.throws(()=>enqueueNativeMessage(db,c.threadId,proof,c.intent.id),/Ambiguous controlled native binding/);
  assert.throws(()=>initializeManagedSchema(db),/Ambiguous controlled native binding/);
  assert.equal(count(db,"radar_managed_outbox"),1);db.close();
});

test("a native thread owned by another account cannot absorb a controlled outcome",()=>{
  const {db,target}=fixture(),trackId=track(db,target),c=controlled(db,target,trackId);
  db.prepare("UPDATE radar_managed_thread SET account_id='other-account' WHERE thread_id=?").run(c.threadId);
  const second=prepareControlledSend(db,{...c.request,stepKey:"other-account-check"});
  assert.throws(()=>recordControlledOutcome(db,second.id,{id:"urn:li:fs_event:(first,later)",threadId:c.threadId,direction:"saliente",occurredAt:new Date().toISOString(),text:body,type:"texto"}),/scope diverged/);
  assert.equal(count(db,"radar_managed_outbox"),1);db.close();
});
