import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import Database from 'better-sqlite3';
import {prepareControlledSend} from '../lib/radar/managed-conversations';
import {authorizeNativeClick,clickWithNativeAuthority,RadarAuthorityError} from '../lib/radar/cold-authority';
import {callbackSignature} from '../lib/radar/contracts';
import {sendMessage} from '../lib/linkedin/message';
const config={url:'https://radar.example/api/webhooks/v1/omnichannel-callback/abcdefghijklmnop',secret:'synthetic-test-only'};
function fixture(){const db=new Database(':memory:'),target=randomUUID(),account=randomUUID(),market=randomUUID(),p=randomUUID();const i=prepareControlledSend(db,{stepKey:randomUUID(),targetId:target,accountId:account,marketId:market,counterpart:'https://www.linkedin.com/in/ana',text:'Texto literal'});return {db,input:{intentId:i.id,targetId:target,accountId:account,marketId:market,pertenenciaId:p,threadId:null}};}
function signed(raw:string,body:Record<string,unknown>,now:number){const response=JSON.stringify({schemaVersion:1,admite:true,requestHash:createHash('sha256').update(raw).digest('hex'),organizacionId:randomUUID(),runtimeKey:'runtime_fixture',accountId:JSON.parse(raw).accountId,intentId:JSON.parse(raw).intentId,reclamoId:randomUUID(),revision:2,expiresAt:new Date(now+3000).toISOString(),...body}),ts=String(Math.floor(now/1000));return new Response(response,{headers:{'x-authority-timestamp':ts,'x-authority-signature':callbackSignature(config.secret,ts,'radar-authority-response-v1.'+response)}});}
test('exact signed server permit is consumed durably once; restart never calls authority/click again',async()=>{
 const f=fixture(),now=Date.now();let calls=0;
 const options={callback:config,runtimeKey:'runtime_fixture',now:()=>now,fetchImpl:async(url:unknown,init?:RequestInit)=>{calls++;assert.equal(String(url),config.url+'/authority');const raw=String(init?.body);const headers=init?.headers as Record<string,string>;assert.equal(headers['x-omnichannel-signature'],callbackSignature(config.secret,headers['x-omnichannel-timestamp'],'radar-authority-request-v1.'+raw));assert.equal(raw.includes('Texto literal'),false);return signed(raw,{},now);}};
 assert.equal((await authorizeNativeClick(f.db,f.input,options)).revision,2);assert.equal((f.db.prepare('select state from radar_native_authority').get() as {state:string}).state,'consumed');
 await assert.rejects(authorizeNativeClick(f.db,f.input,options),/already requested/);assert.equal(calls,1);f.db.close();
});
test('ACK loss is durable unknown and no blind permission replay',async()=>{
 const f=fixture();let calls=0;const options={callback:config,runtimeKey:'runtime_fixture',fetchImpl:async()=>{calls++;throw Error('network');}};
 await assert.rejects(authorizeNativeClick(f.db,f.input,options),RadarAuthorityError);assert.equal((f.db.prepare('select state from radar_native_authority').get() as {state:string}).state,'unknown');await assert.rejects(authorizeNativeClick(f.db,f.input,options),/already requested/);assert.equal(calls,1);f.db.close();
});
for(const [name,override] of Object.entries({expired:{expiresAt:new Date(0).toISOString()},otherAccount:{accountId:randomUUID()},otherIntent:{intentId:randomUUID()},otherRuntime:{runtimeKey:'other'},otherRequest:{requestHash:'a'.repeat(64)},future:{expiresAt:new Date(Date.now()+60000).toISOString()}}))test(`signed ${name} cannot authorize native click`,async()=>{
 const f=fixture(),now=Date.now();await assert.rejects(authorizeNativeClick(f.db,f.input,{callback:config,runtimeKey:'runtime_fixture',now:()=>now,fetchImpl:async(_u,init)=>signed(String(init?.body),override,now)}),RadarAuthorityError);f.db.close();
});
test('tampered or unsigned denial fails closed; signed Company denial never becomes a recipient fact',async()=>{
 const f=fixture();await assert.rejects(authorizeNativeClick(f.db,f.input,{callback:config,runtimeKey:'runtime_fixture',fetchImpl:async()=>new Response('{"admite":true}')}),RadarAuthorityError);
 const g=fixture(),now=Date.now();await assert.rejects(authorizeNativeClick(g.db,g.input,{callback:config,runtimeKey:'runtime_fixture',now:()=>now,fetchImpl:async(_u,init)=>signed(String(init?.body),{admite:false},now)}),/denied/);assert.equal((g.db.prepare('select state from radar_native_authority').get() as {state:string}).state,'denied');assert.equal((g.db.prepare('select count(*) n from radar_managed_outbox').get() as {n:number}).n,0);f.db.close();g.db.close();
});
test('native central send seam checks guard after compose/paste and before irreversible click',async()=>{
 const trace:string[]=[];
 const element={first(){return this;},waitFor:async()=>{},click:async()=>{trace.push('click');},press:async()=>{},pressSequentially:async()=>{}};
 const send={...element,click:async(options?:{trial?:boolean})=>{if(!options?.trial)trace.push('native-click');}};
 const page={goto:async()=>{trace.push('compose');},waitForTimeout:async()=>{},evaluate:async()=>{},locator:(selector:string)=>selector.includes('send-button')?send:element};
 await assert.rejects(sendMessage(page as never,'Ana','Literal','https://www.linkedin.com/in/ana','urn:li:fs_miniProfile:ana',async()=>{trace.push('authority');throw new RadarAuthorityError('Company replied');}),/Company replied/);
 assert.equal(trace.includes('native-click'),false);assert.equal(trace.at(-1),'authority');
 await sendMessage(page as never,'Ana','Literal','https://www.linkedin.com/in/ana','urn:li:fs_miniProfile:ana',async()=>{trace.push('authority');return {expiresAt:new Date(Date.now()+3000).toISOString()};});assert.deepEqual(trace.slice(-2),['authority','native-click']);
});

for(const motivo of ['respuesta_empresa','opt_out_terminal'])test(`invitation checks late ${motivo} immediately before native click`,async()=>{
 const db=new Database(':memory:'),target=randomUUID(),account=randomUUID(),market=randomUUID(),pertenencia=randomUUID(),step=randomUUID();
 const {prepareNativeInvitation}=await import('../lib/radar/cold-authority');const {sendConnectionRequest}=await import('../lib/linkedin/connect');
 const controlled=prepareNativeInvitation(db,{stepKey:step,targetId:target,marketId:market,accountId:account,counterpart:'https://www.linkedin.com/in/ana'});
 const trace:string[]=[];let calls=0;
 const empty={first(){return this;},filter(){return this;},count:async()=>0,innerText:async()=>'',locator(){return this;}};
 const direct={...empty,count:async()=>1,getAttribute:async()=>'/custom-invite/ana'};
 const send={...empty,count:async()=>1,click:async()=>{trace.push('native-click');}};
 const page={goto:async()=>{trace.push('prepare');},waitForTimeout:async()=>{},locator:(selector:string)=>selector.includes('Send now')?send:selector.includes('custom-invite')?direct:empty};
 await assert.rejects(sendConnectionRequest(page as never,'https://www.linkedin.com/in/ana',async()=>{
  trace.push('authority');return await authorizeNativeClick(db,{intentId:controlled.id,targetId:target,pertenenciaId:pertenencia,marketId:market,accountId:account,threadId:null,action:'connection'},{callback:config,runtimeKey:'runtime_fixture',fetchImpl:async(_u,init)=>{calls++;const raw=String(init?.body);assert.equal(JSON.parse(raw).action,'connection');return signed(raw,{admite:false,motivo},Date.now());}});
 }),/denied/);
 assert.equal(trace.includes('native-click'),false);assert.equal(trace.at(-1),'authority');assert.equal(calls,1);assert.equal(prepareNativeInvitation(db,{stepKey:step,targetId:target,marketId:market,accountId:account,counterpart:'https://www.linkedin.com/in/ana'}).send,false);
 assert.equal((db.prepare('select count(*) n from sqlite_master where name=\'radar_managed_outbox\'').get() as {n:number}).n,0);db.close();
});

test('deferred actionability past expiry sends nothing and consumed permission cannot be requested again',async()=>{
 const f=fixture();let now=Date.now(),requests=0,physical=0;
 const authorize=()=>authorizeNativeClick(f.db,f.input,{callback:config,runtimeKey:'runtime_fixture',now:()=>now,fetchImpl:async(_url,init)=>{requests++;return signed(String(init?.body),{},now);}});
 const locator={click:async(options?:{trial?:boolean;timeout?:number;force?:boolean})=>{
  assert.equal(options?.force,undefined);
  if(options?.trial){assert.equal(options.timeout,3000);now+=options.timeout;throw new Error('Button becomes enabled only after the actionability deadline');}
  physical++;
 }};
 try {
  await assert.rejects(clickWithNativeAuthority(locator,authorize,()=>now),error=>error instanceof RadarAuthorityError&&error.noClick);
  assert.equal(physical,0);assert.equal(requests,1);
  assert.equal((f.db.prepare('select state from radar_native_authority').get() as {state:string}).state,'consumed');
  await assert.rejects(clickWithNativeAuthority(locator,authorize,()=>now),/already requested/);
  assert.equal(physical,0);assert.equal(requests,1);
 }finally{f.db.close();}
});

test('near-expiry readiness shrinks the physical budget and never delays mouse release',async()=>{
 let now=1000;const operations:Array<{trial?:boolean;timeout?:number;delay?:number;force?:boolean}>=[],events:Array<{type:string;at:number}>=[];
 const locator={click:async(options?:{trial?:boolean;timeout?:number;delay?:number;force?:boolean})=>{
  operations.push({...options});
  if(options?.trial){now=3999;return;}
  assert.equal(options?.delay,0);assert.equal(options?.force,undefined);
  events.push({type:'down',at:now},{type:'up',at:now});
 }};
 await clickWithNativeAuthority(locator,async()=>({expiresAt:new Date(4000).toISOString()}),()=>now);
 assert.deepEqual(operations,[{trial:true,timeout:3000},{timeout:1,delay:0}]);
 assert.deepEqual(events,[{type:'down',at:3999},{type:'up',at:3999}]);
});

test('a readiness trial that completes exactly at expiry cannot start the physical action',async()=>{
 let now=1000,physical=0;
 const locator={click:async(options?:{trial?:boolean})=>{if(options?.trial){now=4000;return;}physical++;}};
 await assert.rejects(clickWithNativeAuthority(locator,async()=>({expiresAt:new Date(4000).toISOString()}),()=>now),/permission expired/);
 assert.equal(physical,0);
});

test('physical click uncertainty preserves consumption and never claims proof of no click',async()=>{
 const f=fixture();const now=Date.now();let physical=0,requests=0;
 const authorize=()=>authorizeNativeClick(f.db,f.input,{callback:config,runtimeKey:'runtime_fixture',now:()=>now,fetchImpl:async(_url,init)=>{requests++;return signed(String(init?.body),{},now);}});
 const locator={click:async(options?:{trial?:boolean;delay?:number})=>{if(options?.trial)return;assert.equal(options?.delay,0);physical++;throw new Error('Physical acknowledgement unknown');}};
 try {
  await assert.rejects(clickWithNativeAuthority(locator,authorize,()=>now),error=>error instanceof RadarAuthorityError&&!error.noClick);
  assert.equal(physical,1);assert.equal(requests,1);
  assert.equal((f.db.prepare('select state from radar_native_authority').get() as {state:string}).state,'consumed');
  await assert.rejects(clickWithNativeAuthority(locator,authorize,()=>now),/already requested/);
  assert.equal(physical,1);assert.equal(requests,1);
 }finally{f.db.close();}
});

test('controlled invitation retains normal actionability; absent callback keeps the legacy click',async()=>{
 const {sendConnectionRequest}=await import('../lib/linkedin/connect');const operations:Array<{trial?:boolean;timeout?:number;delay?:number;force?:boolean}>=[];
 const empty={first(){return this;},filter(){return this;},count:async()=>0,innerText:async()=>'',locator(){return this;}};
 const direct={...empty,count:async()=>1,getAttribute:async()=>'/custom-invite/ana'};
 const send={...empty,count:async()=>1,click:async(options?:{trial?:boolean;timeout?:number;delay?:number;force?:boolean})=>{operations.push({...options});}};
 const page={goto:async()=>{},waitForTimeout:async()=>{},locator:(selector:string)=>selector.includes('Send now')?send:selector.includes('custom-invite')?direct:empty};
 await sendConnectionRequest(page as never,'https://www.linkedin.com/in/ana',async()=>({expiresAt:new Date(Date.now()+3000).toISOString()}));
 assert.equal(operations.length,2);assert.equal(operations[0].trial,true);
 for(const operation of operations){assert.ok(operation.timeout!>0&&operation.timeout!<=3000);assert.equal(operation.force,undefined);}
 assert.equal(operations[1].delay,0);
 operations.length=0;
 await sendConnectionRequest(page as never,'https://www.linkedin.com/in/ana');
 assert.deepEqual(operations,[{force:true}]);
});
