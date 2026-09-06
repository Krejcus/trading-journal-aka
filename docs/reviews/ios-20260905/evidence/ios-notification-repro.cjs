const {createRequire}=require('node:module');
const assert=require('node:assert/strict');
const req=createRequire('/Users/filipkrejca/Documents/trading-journal-aka/package.json');
const esbuild=req('esbuild');
const root='/Users/filipkrejca/Documents/trading-journal-aka';
const out=[];
async function moduleOf(path,mocks={}){
  global.__iosReviewMocks=mocks;
  const r=await esbuild.build({entryPoints:[root+'/'+path],bundle:true,platform:'node',format:'cjs',write:false,logLevel:'silent',plugins:[{name:'review-mocks',setup(b){b.onResolve({filter:/.*/},a=>Object.hasOwn(mocks,a.path)?{path:a.path,namespace:'review-mock'}:null);b.onLoad({filter:/.*/,namespace:'review-mock'},a=>({contents:'module.exports = global.__iosReviewMocks['+JSON.stringify(a.path)+'];',loader:'js'}));}}]});
  const m={exports:{}};new Function('require','module','exports',r.outputFiles[0].text)(req,m,m.exports);return m.exports;
}
function output(name,data){out.push({name,...data});console.log(JSON.stringify(out.at(-1)));}
function baseSnapshot(extra={}){return {armed:true,shadowMode:false,killSwitch:false,stuckOutbox:false,connected:true,reconciliationRequired:false,divergentAccounts:[],lastError:null,armExpiresAt:Date.now()+120000,entryCooldownUntil:0,dayLockUntil:0,dayLockReason:null,resumeOffer:null,autoClose:null,copyEvents:[],...extra};}
function fakeDb(initial){let marker=initial;const api={get marker(){return marker;},from(table){const q={select(){return q;},eq(){return q;},is(){return q;},then(resolve){resolve({data:table==='copier_alert_state'?(marker?[structuredClone(marker)]:[]):[{id:'phone',device_token:'a'.repeat(64),environment:'development',bundle_id:'app.alphatrade.native'}],error:null});},upsert(value){marker={...value};return Promise.resolve({error:null});},update(){return q;}};return q;}};return api;}
(async()=>{
  const planner=await moduleOf('services/nativeCopierNotificationPlan.ts');
  const at=Date.now()+120000;const snapshot=baseSnapshot({armExpiresAt:at});
  const first=planner.planCopierNotifications({previous:null,next:snapshot,slots:[],now:at-120000});
  assert.equal(first.schedule.length,1);
  const shortlyBefore=planner.planCopierNotifications({previous:snapshot,next:snapshot,slots:[{key:'arm-expiry',at,id:42}],now:at-14000});
  assert.deepEqual(shortlyBefore.cancel,[42]);assert.equal(shortlyBefore.schedule.length,0);
  output('existing expiry alert canceled 14 seconds before delivery',shortlyBefore);

  const watchdog=await moduleOf('server/copierIncidentWatchdog.ts');
  const now=Date.now();const event={id:'event-1',at:now-2000,kind:'sl-moved',symbol:'MNQ',side:'Long',quantity:1,followers:1,price:24000};
  const prev=baseSnapshot();const next=baseSnapshot({copyEvents:[{id:event.id,kind:event.kind,...watchdog.copyEventNotification(event)}]});
  const local=planner.planCopierNotifications({previous:prev,next,slots:[],now});
  const runtime={user_id:'user',device_id:'mac',last_seen_at:new Date(now).toISOString(),started_at:new Date(now-100000).toISOString(),status:{controller:{recentCopyEvents:[event]}}};
  const marker={user_id:'user',device_id:'mac',incident_key:'state:copy-events',active:false,detail:String(now-10000)};
  const server=watchdog.planCopyEventNotifications({runtimes:[runtime],alertStates:[marker],now});
  assert.equal(local.fireNow.length,1);assert.equal(server.notifications.length,1);
  output('one SL move emitted by both independent local and APNs planners',{local:local.fireNow,server:server.notifications});

  let sends=0;
  const pushes=await moduleOf('server/nativeCopierStatePush.ts',{'./apns.js':{sendApnsNotification:async()=>{sends++;return {status:'failed',error:'apns-timeout'};},sendApnsWidgetUpdate:async()=>({status:'sent'})}});
  const db=fakeDb(marker);
  const attempt=await pushes.sendImmediateCopyEventPushes({db,userId:'user',deviceId:'mac',status:runtime.status});
  const retry=await pushes.sendImmediateCopyEventPushes({db,userId:'user',deviceId:'mac',status:runtime.status});
  assert.equal(sends,1);assert.equal(attempt.sent,0);assert.equal(retry.notifications,0);
  output('failed APNs delivery still advances marker and prevents retry',{attempt,retry,sends,marker:db.marker});

  sends=0;let release;const gate=new Promise(r=>release=r);
  const concurrent=await moduleOf('server/nativeCopierStatePush.ts',{'./apns.js':{sendApnsNotification:async()=>{sends++;if(sends===2)release();await gate;return {status:'sent'};},sendApnsWidgetUpdate:async()=>({status:'sent'})}});
  const raceDb=fakeDb(marker);const args={db:raceDb,userId:'user',deviceId:'mac',status:runtime.status};
  const race=await Promise.all([concurrent.sendImmediateCopyEventPushes(args),concurrent.sendImmediateCopyEventPushes(args)]);
  assert.equal(sends,2);output('concurrent calls both send the same event',{sends,results:race});

  let pending=[];const localApi={checkPermissions:async()=>({display:'granted'}),getPending:async()=>({notifications:pending}),schedule:async input=>{pending.push(...input.notifications);},cancel:async input=>{const ids=new Set(input.notifications.map(n=>n.id));pending=pending.filter(n=>!ids.has(n.id));},removeAllDeliveredNotifications:async()=>{}};
  const locals=await moduleOf('services/nativeNotifications.ts',{'@capacitor/local-notifications':{LocalNotifications:localApi},'../utils/runtimeConfig':{isNativeBuild:true},'../utils/nativeShell':{navigateNativeShell:()=>{},openNativeTradeCapture:()=>{}},'./nativeCapabilities':{clearNativeBadgeCount:async()=>{},setNativeBadgeCount:async()=>{}}});
  const id=await locals.scheduleNativeNotification({title:'Copier: ARM vypršel',body:'scheduled risk',route:'live',actionType:'risk',delayMs:120000});
  const source=pending[0].extra.source;const count=await locals.cancelPendingNativeTestNotifications();
  assert.equal(source,'test');assert.equal(pending.length,0);assert.equal(count,1);
  output('test cleanup deletes a real copier risk alert',{id,source,canceledCount:count,remaining:pending.length});

  let permission='denied',permissionChecks=0,registers=0;const callbacks={};
  global.window={setTimeout,clearTimeout};
  const remoteMocks={'@capacitor/push-notifications':{PushNotifications:{checkPermissions:async()=>{permissionChecks++;return {receive:permission};},requestPermissions:async()=>({receive:permission}),register:async()=>{registers++;callbacks.registration?.({value:'a'.repeat(64)});},addListener:async(name,fn)=>{callbacks[name]=fn;return {remove:async()=>{delete callbacks[name];}};}}},'../utils/runtimeConfig':{isNativeBuild:true,apiUrl:p=>p},'../utils/nativeShell':{navigateNativeShell:route=>{global.__lastRoute=route;}},'./supabase':{supabase:{auth:{getSession:async()=>({data:{session:{user:{id:'user'},access_token:'fake'}}})}}},'./alphaTradeNativePlugin':{alphaTradeNativePlugin:{getPushEnvironment:async()=>({environment:'development'})}}};
  global.fetch=async()=>({ok:true});
  const remote=await moduleOf('services/nativePushNotifications.ts',remoteMocks);
  const denied=await remote.initializeNativeRemoteNotifications('user');permission='granted';const allowed=await remote.initializeNativeRemoteNotifications('user');
  assert.equal(denied,false);assert.equal(allowed,false);assert.equal(permissionChecks,1);assert.equal(registers,0);
  output('denied registration cached forever after granting permission',{denied,afterGrant:allowed,permissionChecks,registers});
  await remote.resetNativeRemoteNotificationListeners();await remote.initializeNativeRemoteNotifications('user');
  callbacks.pushNotificationActionPerformed({actionId:'OPEN_JOURNAL',notification:{data:{route:'live'}}});
  assert.equal(global.__lastRoute,'live');output('APNs OPEN_JOURNAL custom action follows payload live route',{requestedAction:'OPEN_JOURNAL',actualRoute:global.__lastRoute});

  // Same millisecond events arriving across heartbeats are skipped by at-only cursor.
  const markerAtEvent={...marker,detail:String(event.at)};
  const sameTime=watchdog.planCopyEventNotifications({runtimes:[{...runtime,status:{controller:{recentCopyEvents:[event,{...event,id:'event-2',kind:'tp-moved'}]}}}],alertStates:[markerAtEvent],now});
  assert.equal(sameTime.notifications.length,0);output('second distinct event at same millisecond is skipped',{distinctEventId:'event-2',notifications:sameTime.notifications.length});
})().catch(e=>{console.error(e);process.exitCode=1;});
