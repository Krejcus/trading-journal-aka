const esbuild = require('/Users/filipkrejca/Documents/trading-journal-aka/node_modules/esbuild');
const repo = '/Users/filipkrejca/Documents/trading-journal-aka';
const h = globalThis.__btReview = { local: new Map(), cloud: new Map(), ledger: new Map(), user: 'user-A', error: null };
const clone = x => x === undefined ? undefined : structuredClone(x);
function query(table) {
  const q = { op: 'select', filters: [], payload: null,
    select(){ return this; }, order(){ return this; }, eq(k,v){this.filters.push([k,v]);return this;},
    update(p){this.op='update';this.payload=p;return this;}, upsert(p){this.op='upsert';this.payload=p;return this;},
    insert(p){this.op='insert';this.payload=p;return this;}, delete(){this.op='delete';return this;},
    execute(single=false){
      if (h.error && this.op === 'update') return {data:null,error:h.error};
      if (table !== 'backtest_runs') {if (table==='backtest_orders' && this.op==='upsert') this.payload.forEach(x=>h.ledger.set(x.id,clone(x)));return {data:[],error:null};}
      let rows=[...h.cloud.values()].filter(x=>x.user_id===h.user && this.filters.every(([k,v])=>x[k]===v));
      if(this.op==='update') rows=rows.map(x=>{const n=clone(this.payload);h.cloud.set(n.id,n);return n;});
      if(this.op==='upsert'||this.op==='insert'){const n=clone(this.payload);h.cloud.set(n.id,n);rows=[n];}
      return {data:single ? rows[0]??null : rows,error:null};
    }, maybeSingle(){return Promise.resolve(this.execute(true));}, single(){return Promise.resolve(this.execute(true));},
    then(resolve,reject){return Promise.resolve(this.execute()).then(resolve,reject);}
  };return q;
}
h.supabase={from:query};
async function bundle(path,mock=false) {
 const r=await esbuild.build({entryPoints:[path],bundle:true,write:false,platform:'node',format:'cjs',plugins: mock ? [{name:'review-isolation',setup(b){
  b.onResolve({filter:/^(idb-keyval|\.\/supabase|\.\/storageService)$/},a=>({path:a.path,namespace:'mock'}));
  b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:a.path==='idb-keyval' ? 'export const get=async k=>structuredClone(globalThis.__btReview.local.get(k)); export const set=async(k,v)=>{globalThis.__btReview.local.set(k,structuredClone(v))}; export const del=async k=>{globalThis.__btReview.local.delete(k)};' : a.path==='./supabase' ? 'export const supabase=globalThis.__btReview.supabase' : 'export const getUserId=async()=>globalThis.__btReview.user',loader:'js'}));
 }}] : []});
 const mod={exports:{}};new Function('module','exports','require',r.outputFiles[0].text)(mod,mod.exports,require);return mod.exports;
}
async function main(){
 const svc=await bundle(repo+'/services/backtestRunService.ts',true);
 const input={accountId:'account-A',name:'private-A',initialCapital:10000,startAt:Date.UTC(2026,0,1),endAt:Date.UTC(2026,0,2)};
 const run=await svc.createBacktestRun(input);
 h.user='user-B'; const foreign=await svc.listBacktestRuns();
 console.log('CROSS_USER_LIST',JSON.stringify({currentUser:h.user,cloudOwnedRuns:[...h.cloud.values()].filter(x=>x.user_id===h.user).length,returnedNames:foreign.map(x=>x.name)}));
 h.user='user-A';h.local.clear();
 const original=[...h.cloud.values()][0];
 h.cloud.set('run-2',{...clone(original),id:'run-2'}); h.cloud.set('run-3',{...clone(original),id:'run-3'});
 const online=await svc.listBacktestRuns();h.user=null;const offline=await svc.listBacktestRuns();
 console.log('COLD_HYDRATION_INDEX',JSON.stringify({onlineCount:online.length,offlineCount:offline.length,index:h.local.get('alphatrade:backtest-runs:index:v1'),savedBlobs:[...h.local.keys()].filter(k=>k.startsWith('alphatrade:backtest-run:')).length}));
 h.user='user-A'; h.cloud.set(run.id,{...clone(original),revision:10,runtime_state:{...clone(original.runtime_state),closedTrades:[{id:'new-trade-in-other-tab'}]}});
 await svc.syncBacktestRunToCloud({...run,revision:4},3);
 console.log('CONCURRENT_CLOUD_EDIT',JSON.stringify({beforeRevision:10,beforeTrades:1,afterRevision:h.cloud.get(run.id).revision,afterTrades:h.cloud.get(run.id).runtime_state.closedTrades.length}));
 h.error={code:'08006',message:'simulated network failure'}; let rejected=false;try{await svc.syncBacktestRunToCloud({...run,revision:5},4);}catch{rejected=true;}
 console.log('SYNC_ERROR_SIGNAL',JSON.stringify({cloudRevision:h.cloud.get(run.id).revision,requestedRevision:5,promiseRejected:rejected}));
 h.error=null;
 const engine=await bundle(repo+'/services/backtestEngine.ts');
 const order=engine.createBacktestOrder({runId:run.id,instrument:'MNQ',side:'buy',type:'limit',quantity:1,limitPrice:99,now:1000});
 const cursor=svc.createBacktestLedgerCursor();
 const r1={...run,revision:5,runtimeState:engine.enqueueBacktestOrder(run.runtimeState,order)};
 await svc.syncBacktestRunToCloud(r1,4,cursor);
 const r2={...r1,revision:6,runtimeState:engine.cancelBacktestOrder(r1.runtimeState,order.id,1000)};
 await svc.syncBacktestRunToCloud(r2,5,cursor);
 console.log('SAME_CANDLE_LEDGER_CHANGE',JSON.stringify({runtimeStatus:r2.runtimeState.orders[0].status,ledgerStatus:h.ledger.get(order.id).status,sameUpdatedAt:r1.runtimeState.orders[0].updatedAt===r2.runtimeState.orders[0].updatedAt}));
 const journal=await bundle(repo+'/services/backtestOrderJournal.ts');
 const trade={instrument:'MNQ',entryTime:1000,exitTime:2000,entryPrice:100,direction:'Long'};
 const events=[{id:'entry',runId:'run',orderId:'entry',kind:'filled',instrument:'MNQ',marketTime:1000,side:'buy',quantity:1},{id:'scalein',runId:'run',orderId:'scalein',kind:'filled',instrument:'MNQ',marketTime:1500,side:'buy',quantity:1},{id:'exit',runId:'run',orderId:'exit',kind:'filled',instrument:'MNQ',marketTime:2000,side:'sell',quantity:2}];
 const management=journal.tradeManagementStats(events,trade);
 console.log('SCALE_IN_MANAGEMENT',JSON.stringify({actualPartialExits:0,reportedPartialExits:management.partialExits,label:management.label}));
 const positionRuntime={...run.runtimeState,positions:[{instrument:'MNQ',side:'long',quantity:1,averagePrice:100,openedAt:1000,entryFillIds:[],entryCommission:0}]};
 const bracket=engine.updatePositionBracket(positionRuntime,'MNQ',98,104);
 console.log('BRACKET_ADD_WITHOUT_EVENT',JSON.stringify({stop:bracket.positions[0].stopLoss,target:bracket.positions[0].takeProfit,events:bracket.orderEvents.length}));
 const source=require('fs').readFileSync(repo+'/components/Dashboard.tsx','utf8');
 const pure=source.slice(source.indexOf('const sim = useMemo(() => {')+'const sim = useMemo(() => {'.length,source.indexOf('}, [stats.trades, stats.initialBalance]);'));
 const js=await esbuild.transform(pure,{loader:'ts'});
 const fixedMath=Object.create(Math);let randomCalls=0;fixedMath.random=()=>{const n=randomCalls++%10;return n===0 ? .01 : n===1 ? .11 : .21;};
 const percentile=(sorted,p)=>sorted[Math.min(sorted.length-1,Math.max(0,Math.floor((sorted.length-1)*p)))];
 const sim=new Function('stats','SIMS','PATHS','Math','_percentile',js.code)({initialBalance:100,trades:[200,-150,0,0,0,0,0,0,0,0].map(pnl=>({pnl}))},600,36,fixedMath,percentile);
 console.log('RUIN_FALSE_POSITIVE',JSON.stringify({startBalance:100,allPaths:[100,300,150,150,150,150,150,150,150,150,150],actualRuinPct:0,reportedRuinPct:sim.ruinPct}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
