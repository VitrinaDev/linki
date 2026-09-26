import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {Locator} from 'playwright';
import {z} from 'zod';
import {getRadarCallbackConfig} from './config';
import {callbackSignature} from './contracts';
export class RadarAuthorityError extends Error {
 constructor(message:string,readonly noClick=true){super(message);}
}
export type NativeClickDeadline = Readonly<{expiresAt:string}>;
export type NativeClickAuthority = () => Promise<NativeClickDeadline>;

/** Never detach a late click: Playwright owns cancellation and actionability. */
export async function clickWithNativeAuthority(locator:Pick<Locator,'click'>,authorize:NativeClickAuthority,now:()=>number=Date.now):Promise<void> {
 const permit=await authorize();
 let physicalAttempt=false;
 const deadline=Date.parse(permit.expiresAt);
 const remaining=()=>{
  const budget=Math.floor(deadline-now());
  if(!Number.isFinite(budget)||budget<=0||budget>5000)throw new RadarAuthorityError('Native click permission expired; reconciliation required');
  return budget;
 };
 try {
  await locator.click({trial:true,timeout:remaining()});
  // Actionability may have consumed most of the permission. Both physical
  // mouse events are dispatched without an intervening delay, inside the
  // freshly bounded Playwright operation; force never bypasses its checks.
  const timeout=remaining();
  physicalAttempt=true;
  await locator.click({timeout,delay:0});
 }catch(error){
  if(error instanceof RadarAuthorityError)throw error;
  throw new RadarAuthorityError('Native click unavailable; reconciliation required',!physicalAttempt);
 }
}
const permitSchema=z.object({schemaVersion:z.literal(1),admite:z.literal(true),requestHash:z.string().regex(/^[a-f0-9]{64}$/),organizacionId:z.uuid(),runtimeKey:z.string(),accountId:z.uuid(),intentId:z.uuid(),reclamoId:z.uuid(),revision:z.number().int().nonnegative(),expiresAt:z.iso.datetime({offset:true})}).strict();
const hash=(v:string)=>createHash('sha256').update(v).digest('hex');
export function initializeAuthoritySchema(db:Database.Database) {
 db.exec(`CREATE TABLE IF NOT EXISTS radar_native_authority (
 intent_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,requested_at TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('requested','denied','consumed','unknown')),
 claim_id TEXT,revision INTEGER,reason TEXT);
 CREATE TABLE IF NOT EXISTS radar_controlled_invitation (
 id TEXT PRIMARY KEY,step_key TEXT NOT NULL UNIQUE,target_id TEXT NOT NULL,market_id TEXT NOT NULL,account_id TEXT NOT NULL,counterpart TEXT NOT NULL,message_hash TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'iniciado');`);
}
export function prepareNativeInvitation(db:Database.Database,input:{stepKey:string;targetId:string;marketId:string;accountId:string;counterpart:string}) {
 initializeAuthoritySchema(db);
 const prior=db.prepare('SELECT * FROM radar_controlled_invitation WHERE step_key=?').get(input.stepKey) as {id:string;target_id:string;market_id:string;account_id:string;counterpart:string}|undefined;
 if(prior) {if(prior.target_id!==input.targetId||prior.market_id!==input.marketId||prior.account_id!==input.accountId||prior.counterpart!==input.counterpart)throw new RadarAuthorityError('Controlled invitation binding differs');return {id:prior.id,send:false};}
 const id=randomUUID();db.prepare('INSERT INTO radar_controlled_invitation(id,step_key,target_id,market_id,account_id,counterpart,message_hash) VALUES(?,?,?,?,?,?,?)').run(id,input.stepKey,input.targetId,input.marketId,input.accountId,input.counterpart,hash('connection.request'));
 return {id,send:true};
}
export async function authorizeNativeClick(db:Database.Database,input:{intentId:string;targetId:string;pertenenciaId:string;marketId:string;accountId:string;threadId:string|null;action?:'message'|'connection'},options:{fetchImpl?:typeof fetch;now?:()=>number;callback?:{url:string;secret:string};runtimeKey?:string}={}) {
 initializeAuthoritySchema(db);
 const clock=options.now??Date.now,runtimeKey=options.runtimeKey??process.env.RADAR_RUNTIME_KEY;
 const config=options.callback??getRadarCallbackConfig();
 if(!config||!runtimeKey)throw new RadarAuthorityError('Radar native authority unavailable');
 if(input.action==='connection'&&input.threadId!==null)throw new RadarAuthorityError('Invitation cannot claim managed continuation');
 const intent=db.prepare(input.action==='connection'?'SELECT * FROM radar_controlled_invitation WHERE id=?':'SELECT * FROM radar_controlled_send WHERE id=?').get(input.intentId) as {id:string;step_key:string;target_id:string;market_id:string;account_id:string;counterpart:string;message_hash:string;state:string}|undefined;
 if(!intent||intent.state!=='iniciado'||intent.target_id!==input.targetId||intent.market_id!==input.marketId||intent.account_id!==input.accountId)throw new RadarAuthorityError('Controlled native authority binding differs');
 const request={schemaVersion:1,...(input.action?{action:input.action}:{}),runtimeKey,intentId:intent.id,targetId:input.targetId,pertenenciaId:input.pertenenciaId,marketId:input.marketId,accountId:input.accountId,counterpart:intent.counterpart,threadId:input.threadId,stepHash:hash(intent.step_key),messageHash:intent.message_hash.replace(/^linki_managed_/, '')};
 const raw=JSON.stringify(request),requestHash=hash(raw);
 // A lost ACK can mean a consumed permission. Restart never repeats the request/click.
 const inserted=db.prepare("INSERT OR IGNORE INTO radar_native_authority(intent_id,request_hash,requested_at,state) VALUES(?,?,?,'requested')").run(intent.id,requestHash,new Date(clock()).toISOString());
 if(!inserted.changes)throw new RadarAuthorityError('Native permission already requested; reconciliation required');
 const url=new URL(config.url);
 if(!/\/api\/webhooks\/v1\/omnichannel-callback\/[a-z0-9]{16,}\/?$/.test(url.pathname))throw new RadarAuthorityError('Tenant authority callback unavailable');
 url.pathname=url.pathname.replace(/\/$/,'')+'/authority';
 try {
  const timestamp=String(Math.floor(clock()/1000));
  const response=await (options.fetchImpl??fetch)(url,{method:'POST',headers:{'content-type':'application/json','x-omnichannel-timestamp':timestamp,'x-omnichannel-signature':callbackSignature(config.secret,timestamp,'radar-authority-request-v1.'+raw)},body:raw,signal:AbortSignal.timeout(5000)});
  const body=await response.text(),responseTimestamp=response.headers.get('x-authority-timestamp'),signature=response.headers.get('x-authority-signature');
  if(!responseTimestamp||!/^\d+$/.test(responseTimestamp)||Math.abs(clock()-Number(responseTimestamp)*1000)>5000||!signature)throw new RadarAuthorityError('Native authority response expired or unsigned');
  const expected=callbackSignature(config.secret,responseTimestamp,'radar-authority-response-v1.'+body);
  if(signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))throw new RadarAuthorityError('Native authority response signature differs');
  const value=JSON.parse(body);
  if(!response.ok||value.admite!==true){db.prepare("UPDATE radar_native_authority SET state='denied',reason='authority_denied' WHERE intent_id=? AND state='requested'").run(intent.id);throw new RadarAuthorityError('Radar Company authority denied native send');}
  const permit=permitSchema.parse(value);
  if(permit.requestHash!==requestHash||permit.runtimeKey!==runtimeKey||permit.accountId!==input.accountId||permit.intentId!==intent.id||Date.parse(permit.expiresAt)<=clock()||Date.parse(permit.expiresAt)>clock()+5000)throw new RadarAuthorityError('Native authority permit binding expired or differs');
  // Commit consumption immediately before the irreversible click. No cached permit is reusable.
  const consumed=db.prepare("UPDATE radar_native_authority SET state='consumed',claim_id=?,revision=? WHERE intent_id=? AND request_hash=? AND state='requested'").run(permit.reclamoId,permit.revision,intent.id,requestHash);
  if(consumed.changes!==1)throw new RadarAuthorityError('Native authority consumption raced');
  return permit;
 } catch(error) {
  db.prepare("UPDATE radar_native_authority SET state='unknown',reason='authority_unavailable' WHERE intent_id=? AND state='requested'").run(intent.id);
  if(error instanceof RadarAuthorityError)throw error;
  throw new RadarAuthorityError('Native authority unavailable; reconciliation required');
 }
}
