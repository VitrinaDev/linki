import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import {randomUUID} from "node:crypto";
import {parseThreadPage,readThreadPage,readWholeThread,threadFromUrl} from "../lib/linkedin/radar-thread-reader";
import {initializeManagedSchema,prepareControlledSend,recordControlledOutcome,enqueueNativeMessage,processManagedCallbacks,expireManaged,requireRadarSecret,registerManagedClaim,retireManagedScope} from "../lib/radar/managed-conversations";
const thread="urn:li:fs_conversation:thread1",self="urn:li:fs_miniProfile:self",counterpart="https://www.linkedin.com/in/ana";
function native(id:string,text:string,sender="ana") {return {entityUrn:`urn:li:fs_event:(thread1,${id})`,conversationUrn:thread,createdAt:Date.now(),from:{"com.linkedin.voyager.messaging.MessagingMember":{miniProfile:{entityUrn:sender==="self"?self:`urn:li:fs_miniProfile:${sender}`,publicIdentifier:sender}}},eventContent:{"com.linkedin.voyager.messaging.event.MessageEvent":{body:text}}};}
function db(){const d=new Database(":memory:");d.pragma("foreign_keys=ON");initializeManagedSchema(d);return d;}
test("native exact thread preserves full untrimmed text, paginates, rejects neighbours and weak identity",()=>{
 const raw={elements:[native("one","  Gracias\nconversemos  ")],paging:{start:0,count:1,total:2}};
 const result=parseThreadPage(raw,thread,self,counterpart,0,100);
 assert.equal(result.messages[0].text,"  Gracias\nconversemos  ");assert.equal(result.next,1);
 assert.throws(()=>parseThreadPage({...raw,elements:[{...native("one","x"),conversationUrn:"urn:li:fs_conversation:neighbour"}]},thread,self,counterpart,0,100),/identity/);
 assert.throws(()=>parseThreadPage({...raw,elements:[native("one","x","lookalike")]},thread,self,counterpart,0,100),/ambiguous/);
 assert.throws(()=>parseThreadPage({...raw,paging:null},thread,self,counterpart,0,100),/pagination/);
 assert.equal(threadFromUrl("https://www.linkedin.com/messaging/compose/?profileUrn=urn:x"),null);
 assert.equal(threadFromUrl("https://www.linkedin.com/messaging/thread/thread1/"),thread);
});
test("unknown native message wrappers and malformed events keep recovery partial",()=>{
 const unknown={...native("unknown","body"),eventContent:{"unknown.native.MessageV2":{body:"Message not normalized"}}};
 for(const event of [unknown,{...native("missing","body"),eventContent:null},{...native("empty","body"),eventContent:{}}]){
  const raw={elements:[event],paging:{start:0,count:1,total:1}};
  assert.throws(()=>parseThreadPage(raw,thread,self,counterpart,0,100),/unsupported.*partial/);
 }
});
test("concrete provider adapter requests only /me and exact thread events",async()=>{
 const requests:string[]=[];
 const oldFetch=globalThis.fetch,oldDocument=(globalThis as Record<string,unknown>).document;
 (globalThis as Record<string,unknown>).document={cookie:'JSESSIONID="fixture"'};
 globalThis.fetch=async(url)=>{requests.push(String(url));return new Response(JSON.stringify(String(url)==="/voyager/api/me"?{miniProfile:{entityUrn:self}}:{elements:[native("one","Completo")],paging:{start:0,count:1,total:1}}),{status:200});};
 try {
  const fake={evaluate:async(fn:(input:unknown)=>unknown,input:unknown)=>fn(input)};
  assert.equal((await readThreadPage(fake as never,thread,counterpart)).messages[0].text,"Completo");
  assert.deepEqual(requests,["/voyager/api/me","/voyager/api/messaging/conversations/thread1/events?count=100&start=0"]);
 } finally {globalThis.fetch=oldFetch;(globalThis as Record<string,unknown>).document=oldDocument;}
});
test("controlled intent commits before UI, uncertain survives restart and never permits repetition",()=>{
 const d=db();const request={stepKey:"step",targetId:randomUUID(),accountId:"account",marketId:randomUUID(),counterpart,text:"Hola"};
 const first=prepareControlledSend(d,request);assert.equal(first.send,true);
 assert.equal(prepareControlledSend(d,request).send,false);
 assert.throws(()=>prepareControlledSend(d,{...request,text:"Changed after uncertain attempt"}),/diverged/);
 recordControlledOutcome(d,first.id,null);assert.equal(prepareControlledSend(d,request).state,"incierto");
 assert.equal((d.prepare("SELECT payload_json FROM radar_managed_outbox").get() as {payload_json:string}).payload_json.includes("native_send_receipt_unavailable"),true);
 assert.equal((d.prepare("SELECT count(*) n FROM radar_managed_thread").get() as {n:number}).n,0);d.close();
});
test("native receipt imports one scoped thread, every later direction, ack redacts and retention removes derivatives",async()=>{
 process.env.RADAR_RUNTIME_KEY="fundador_test";process.env.RADAR_CALLBACK_URL="http://example.invalid/callback";process.env.RADAR_CALLBACK_SECRET="local-fixture-only";
 const d=db(),market=randomUUID(),request={stepKey:"step",targetId:randomUUID(),accountId:"account",marketId:market,counterpart,text:"Hola"};
 const first=prepareControlledSend(d,request),proof={id:"urn:li:fs_event:(thread1,first)",threadId:thread,direction:"saliente" as const,occurredAt:new Date().toISOString(),text:"Hola",type:"texto" as const};
 recordControlledOutcome(d,first.id,proof);
 enqueueNativeMessage(d,thread,proof);assert.equal((d.prepare("SELECT count(*) n FROM radar_managed_outbox").get() as {n:number}).n,1);
 enqueueNativeMessage(d,thread,{...proof,id:"urn:li:fs_event:(thread1,reply)",direction:"entrante",text:"Respuesta completa"});
 enqueueNativeMessage(d,thread,{...proof,id:"urn:li:fs_event:(thread1,later)",text:"Segunda salida completa"});
 await processManagedCallbacks(d,{fetchImpl:async()=>new Response(JSON.stringify({normalizado:false}),{status:200})});
 assert.equal((d.prepare("SELECT count(*) n FROM radar_managed_outbox WHERE payload_json IS NOT NULL").get() as {n:number}).n,3);
 d.prepare("UPDATE radar_managed_outbox SET next_attempt_at=datetime('now')").run();
 await processManagedCallbacks(d,{fetchImpl:async()=>new Response(JSON.stringify({normalizado:true}),{status:200})});
 assert.equal((d.prepare("SELECT count(*) n FROM radar_managed_outbox WHERE payload_json IS NOT NULL").get() as {n:number}).n,0);
 assert.equal((d.prepare("SELECT text FROM radar_controlled_send").get() as {text:string|null}).text,null);
 expireManaged(d,new Date("2100-01-01T00:00:00Z"));for(const t of ["radar_managed_thread","radar_managed_outbox","radar_controlled_send"])assert.equal((d.prepare(`SELECT count(*) n FROM ${t}`).get() as {n:number}).n,0);d.close();
 delete process.env.RADAR_RUNTIME_KEY;delete process.env.RADAR_CALLBACK_URL;delete process.env.RADAR_CALLBACK_SECRET;
});
test("claim scope requires Radar service authentication, never a runtime browser session",()=>{
 process.env.INTERNAL_API_SECRET="fixture-internal";assert.throws(()=>requireRadarSecret(undefined),/authentication/);assert.throws(()=>requireRadarSecret("wrong"),/authentication/);requireRadarSecret("fixture-internal");delete process.env.INTERNAL_API_SECRET;
});

test("exact-thread recovery persists each page before a later provider gap and never declares it complete",async()=>{
 const persisted:string[]=[];
 const fake={evaluate:async(_fn:unknown,input:{start:number})=>{
  if(input.start===1)throw new Error("provider gap");
  return {me:{miniProfile:{entityUrn:self}},body:{elements:[native("first","Verbatim first page")],paging:{start:0,count:1,total:2}}};
 }};
 await assert.rejects(readWholeThread(fake as never,thread,counterpart,{onPage:messages=>persisted.push(...messages.map(m=>m.id))}),/provider gap/);
 assert.deepEqual(persisted,["urn:li:fs_event:(thread1,first)"]);
});

test("explicit claim registration keeps native/account/market identity immutable without contact enrollment",()=>{
 process.env.RADAR_RUNTIME_KEY="fixture";
 const d=db(),input={schemaVersion:1 as const,conversationId:randomUUID(),marketId:randomUUID(),threadId:thread,counterpart,claimId:randomUUID(),claimedBy:randomUUID(),from:'2024-09-26T00:00:00Z',expiresAt:'2028-09-26T00:00:00Z'},config={accountId:'account',workflowId:'workflow',listId:'list'};
 assert.equal(registerManagedClaim(input,d,config).registered,true);assert.equal(registerManagedClaim(input,d,config).duplicate,true);
 assert.throws(()=>registerManagedClaim({...input,marketId:randomUUID()},d,config),/diverged/);
 assert.throws(()=>registerManagedClaim(input,d,{...config,accountId:'other'}),/diverged/);
 assert.equal((d.prepare('select count(*) n from radar_controlled_send').get() as {n:number}).n,0);
 d.close();delete process.env.RADAR_RUNTIME_KEY;
});

test("retirement atomically removes only the exact scope, survives restart and refuses its reuse",()=>{
 process.env.RADAR_RUNTIME_KEY="fixture";const d=db(),config={accountId:'account',workflowId:'workflow',listId:'list'};
 const input={schemaVersion:1 as const,conversationId:randomUUID(),marketId:randomUUID(),threadId:thread,counterpart,claimId:randomUUID(),claimedBy:randomUUID(),from:'2024-09-26T00:00:00Z',expiresAt:'2028-09-26T00:00:00Z'};
 registerManagedClaim(input,d,config);enqueueNativeMessage(d,thread,{id:'urn:li:fs_event:(thread1,privatecopy)',threadId:thread,direction:'entrante',occurredAt:new Date().toISOString(),text:'Restricted exact thread copy',type:'texto'});
 const neighbour={...input,conversationId:randomUUID(),claimId:randomUUID(),threadId:'urn:li:fs_conversation:other'};registerManagedClaim(neighbour,d,config);
 const retire={schemaVersion:1 as const,runtimeKey:'fixture',threadId:thread,scopeId:input.claimId,retirementId:randomUUID()};
 assert.throws(()=>retireManagedScope({...retire,scopeId:randomUUID()},d,config),/differs/);
 assert.equal(retireManagedScope(retire,d,config).retired,true);assert.equal(retireManagedScope(retire,d,config).retired,true);
 assert.equal((d.prepare('select count(*) n from radar_managed_outbox').get() as {n:number}).n,0);
 assert.equal((d.prepare('select thread_id from radar_managed_thread').get() as {thread_id:string}).thread_id,neighbour.threadId);
 initializeManagedSchema(d);assert.throws(()=>registerManagedClaim(input,d,config),/retired/);
 const grave=d.prepare('select * from radar_retired_scope').get() as Record<string,string>;assert.equal(Object.values(grave).some(v=>v===thread||v===input.claimId),false);
 d.close();delete process.env.RADAR_RUNTIME_KEY;
});
