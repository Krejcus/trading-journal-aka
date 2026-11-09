// Real PostgreSQL, two held psql sessions; no npm database dependency.
// PSQL=/Applications/Postgres.app/Contents/Versions/18/bin/psql \
// PGHOST=/private/tmp PGPORT=56439 PGDATABASE=postgres node --test tests/sql/tradovateRequestControl.pg.mjs
// Uses an isolated random schema, never production tables. Local connections only.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const psql=process.env.PSQL??'psql';
if(!['/private/tmp','/tmp','localhost','127.0.0.1'].includes(process.env.PGHOST??''))throw new Error('Set an explicit local PGHOST for this test');
const schema=`request_control_${randomUUID().replaceAll('-','')}`;
const OWNER='11111111-1111-4111-8111-111111111111', OTHER='22222222-2222-4222-8222-222222222222';
const C1='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', C2='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', C3='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', C4='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4';
const args=['-X','-A','-t','-q','-v','ON_ERROR_STOP=1'];
const q=sql=>execFileSync(psql,args,{input:sql,encoding:'utf8',env:process.env}).trim();
const sqlString=x=>x==null?'null':`'${String(x).replaceAll("'","''")}'`;
const rpcSql=(mode,options={})=>`select ${schema}.tradovate_request_control_v1(${sqlString(options.owner??OWNER)}::uuid,${sqlString(options.connection??C1)}::uuid,${sqlString(mode)},${sqlString(options.id??null)}::uuid,${sqlString(options.purpose??'background')},${options.units??1},${options.ttl??5000},${sqlString(options.evidence??null)},${options.ms??'null'},${sqlString(options.reason??'test')},${options.captcha??false},${options.minimum??'null'},${options.fallback??'null'});`;
const rpc=(mode,options={})=>JSON.parse(q(`set role service_role;${rpcSql(mode,options)}`));
class Session {
 constructor(){this.child=spawn(psql,args,{env:process.env,stdio:['pipe','pipe','pipe']});this.pending=null;this.buffer='';this.errors='';this.child.stdout.setEncoding('utf8');this.child.stderr.setEncoding('utf8');this.child.stdout.on('data',d=>{this.buffer+=d;this.drain();});this.child.stderr.on('data',d=>this.errors+=d);this.child.on('exit',code=>{if(this.pending)this.pending.reject(new Error(`psql exited ${code}: ${this.errors}`));});}
 drain(){if(!this.pending)return;const i=this.buffer.indexOf(this.pending.marker);if(i<0)return;const result=this.buffer.slice(0,i).trim();this.buffer=this.buffer.slice(i+this.pending.marker.length).replace(/^\r?\n/,'');const p=this.pending;this.pending=null;p.resolve(result);}
 query(sql){assert.equal(this.pending,null);const marker=`END_${randomUUID().replaceAll('-','')}`;return new Promise((resolve,reject)=>{this.pending={marker,resolve,reject};this.child.stdin.write(`${sql}\n\\echo ${marker}\n`);this.drain();});}
 close(){this.child.stdin.end();}
}
let a,b;
before(async()=>{
 const migration=(await readFile(new URL('../../supabase/migrations/20261109100740_tradovate_request_control_v1.sql',import.meta.url),'utf8')).replaceAll('public.',`${schema}.`);
 q(`do $$ begin if not exists(select 1 from pg_roles where rolname='anon')then create role anon;end if;if not exists(select 1 from pg_roles where rolname='authenticated')then create role authenticated;end if;if not exists(select 1 from pg_roles where rolname='service_role')then create role service_role bypassrls;end if;end $$;
 create schema ${schema};grant usage on schema ${schema} to anon,authenticated,service_role;
 create table ${schema}.tradovate_oauth_connections(id uuid primary key,user_id uuid,connection_status text,tradovate_user_id bigint);
 grant select on ${schema}.tradovate_oauth_connections to service_role;
 insert into ${schema}.tradovate_oauth_connections values('${C1}','${OWNER}','connected',42),('${C2}','${OTHER}','connected',42),('${C3}','${OWNER}','connected',99),('${C4}','${OWNER}','connected',null);
 ${migration}`);
 a=new Session();b=new Session();await a.query('set role service_role;');await b.query('set role service_role;');
});
beforeEach(()=>q(`truncate ${schema}.tradovate_request_grants,${schema}.tradovate_request_control cascade;`));
after(async()=>{if(a)await a.query('rollback;');if(b)await b.query('rollback;');a?.close();b?.close();q(`drop schema ${schema} cascade;`);});
test('global identity merges two app owners/connections, separates a different broker',()=>{
 assert.equal(rpc('reserve',{id:randomUUID(),units:60}).allowed,true);
 assert.equal(rpc('reserve',{owner:OTHER,connection:C2,id:randomUUID(),units:60}).allowed,true);
 const denied=rpc('reserve',{id:randomUUID()});assert.equal(denied.code,'tradovate-request-budget');assert.equal(denied.snapshot.backgroundReservedMinute,120);
 assert.equal(rpc('reserve',{connection:C3,id:randomUUID()}).allowed,true);
});
test('owner+connection is verified before resolving broker identity',()=>{assert.throws(()=>rpc('read',{owner:OTHER,connection:C1}),/connection-forbidden/);assert.equal(rpc('reserve',{connection:C4,id:randomUUID()}).code,'tradovate-request-identity-unavailable');});
test('grant UUID replay is idempotent; changed payload conflicts',()=>{const id=randomUUID();const first=rpc('reserve',{id,units:4});const replay=rpc('reserve',{id,units:4});assert.equal(first.grant.validUntil,replay.grant.validUntil);assert.equal(rpc('read').snapshot.backgroundReservedMinute,4);assert.throws(()=>rpc('reserve',{id,units:5}),/grant-conflict/);});
test('expired grant cannot be revived and still consumes capacity through validUntil + window',()=>{const id=randomUUID();rpc('reserve',{id,units:64});q(`update ${schema}.tradovate_request_grants set issued_at=clock_timestamp()-interval '20 seconds',valid_until=clock_timestamp()-interval '10 seconds' where id='${id}';`);assert.equal(rpc('reserve',{id,units:64}).code,'tradovate-request-grant-expired');assert.equal(rpc('read').snapshot.backgroundReservedMinute,64);});
test('hourly background budget remains charged beyond the minute window',()=>{rpc('read');q(`insert into ${schema}.tradovate_request_grants select gen_random_uuid(),42,'${OWNER}','${C1}','background',60,5000,clock_timestamp()-interval '30 minutes 5 seconds',clock_timestamp()-interval '30 minutes',0 from generate_series(1,50);`);assert.equal(rpc('read').snapshot.backgroundReservedHour,3000);assert.equal(rpc('read').snapshot.backgroundReservedMinute,0);assert.equal(rpc('reserve',{id:randomUUID()}).code,'tradovate-request-budget');assert.equal(rpc('reserve',{id:randomUUID(),purpose:'entry'}).allowed,true);});
test('total soft4000 only gates new reservations; management grants are not offered',()=>{rpc('read');q(`insert into ${schema}.tradovate_request_grants select gen_random_uuid(),42,'${OWNER}','${C1}','entry',64,5000,clock_timestamp()-interval '30 minutes 5 seconds',clock_timestamp()-interval '30 minutes',0 from generate_series(1,62);`);assert.equal(rpc('reserve',{id:randomUUID(),units:32,purpose:'entry'}).allowed,true);assert.equal(rpc('reserve',{id:randomUUID(),purpose:'entry'}).code,'tradovate-request-budget');assert.throws(()=>rpc('reserve',{id:randomUUID(),purpose:'management'}),/invalid-request-control-reservation/);});
test('raw429 minimum one hour and shorter evidence cannot reduce it',()=>{const first=rpc('penalize',{evidence:'raw-429',ms:1,minimum:1,fallback:3600000}).snapshot;assert.ok(first.blockedUntil-first.serverNow>=3600000);const shorter=rpc('penalize',{evidence:'p-time',ms:1000}).snapshot;assert.equal(shorter.blockedUntil,first.blockedUntil);assert.equal(shorter.evidence,'raw-429');assert.equal(shorter.epoch,first.epoch);});
test('explicit broker minimum over24h is never shortened',()=>{const s=rpc('penalize',{evidence:'retry-after',ms:1000,minimum:172800000}).snapshot;assert.ok(s.blockedUntil-s.serverNow>=172800000);});
test('unrepresentable broker duration saturation8e15 remains a practical terminal stop',()=>{const s=rpc('penalize',{evidence:'p-time',ms:8000000000000000,minimum:8000000000000000}).snapshot;assert.ok(s.blockedUntil-s.serverNow>=7999999999999000);assert.equal(rpc('reserve',{id:randomUUID()}).code,'tradovate-request-cooldown');});
test('actual captcha stays terminal after blockedUntil and across another owner connection',()=>{rpc('penalize',{evidence:'captcha',ms:1000,captcha:true});q(`update ${schema}.tradovate_request_control set blocked_until=clock_timestamp()-interval '1 second';`);assert.equal(rpc('reserve',{owner:OTHER,connection:C2,id:randomUUID()}).code,'tradovate-request-captcha');assert.equal(rpc('read').snapshot.captchaRequired,true);});
test('a new epoch invalidates a previously issued grant even when replayed',()=>{const id=randomUUID();rpc('reserve',{id});rpc('penalize',{evidence:'p-time',ms:1});q(`update ${schema}.tradovate_request_control set blocked_until=clock_timestamp()-interval '1 second';`);assert.equal(rpc('reserve',{id}).code,'tradovate-request-grant-expired');});
test('invalid mode and oversized grant are rejected',()=>{assert.throws(()=>rpc(null),/invalid-request-control-mode/);assert.throws(()=>rpc('reserve',{id:randomUUID(),units:65}),/invalid-request-control-reservation/);assert.throws(()=>rpc('reserve',{id:randomUUID(),ttl:15001}),/invalid-request-control-reservation/);});
test('anon/authenticated cannot execute RPC or read authority tables; function is invoker',()=>{for(const role of ['anon','authenticated']){assert.throws(()=>q(`set role ${role};${rpcSql('read')}`),/permission denied/);assert.throws(()=>q(`set role ${role};select * from ${schema}.tradovate_request_control;`),/permission denied/);}assert.equal(q(`select prosecdef from pg_proc join pg_namespace n on n.oid=pronamespace where n.nspname='${schema}' and proname='tradovate_request_control_v1'`),'f');});
test('two held sessions serialize different owners on the same global broker row',async()=>{
 rpc('reserve',{id:randomUUID(),units:56});
 await a.query('begin;');const first=JSON.parse(await a.query(rpcSql('reserve',{id:randomUUID(),units:64})));assert.equal(first.allowed,true);
 let finished=false;const second=b.query(rpcSql('reserve',{owner:OTHER,connection:C2,id:randomUUID()})).then(text=>{finished=true;return JSON.parse(text);});
 // Deterministic evidence that session B is actually waiting on a transaction lock.
 let waiting=false;for(let i=0;i<50;i++){if(q(`select count(*) from pg_stat_activity where wait_event_type='Lock' and query like '%${schema}.tradovate_request_control_v1%'`) !== '0'){waiting=true;break;}await new Promise(r=>setTimeout(r,10));}
 assert.equal(waiting,true);assert.equal(finished,false);await a.query('commit;');assert.equal((await second).code,'tradovate-request-budget');assert.equal(rpc('read').snapshot.backgroundReservedMinute,120);
});
