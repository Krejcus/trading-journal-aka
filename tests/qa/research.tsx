import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import LabPage from '../../components/LabPage';
import BacktestSessionsManager from '../../components/BacktestSessionsManager';
import {appendResearchRule} from '../../services/backtestResearchCases';
import {setChartAppearanceUserId} from '../../services/chartAppearanceScope';
import {storageService} from '../../services/storageService';
import {createBacktestRuntime} from '../../services/backtestEngine';
import {DEFAULT_BACKTEST_CONFIG,type BacktestRun} from '../../services/backtestTypes';
import type {Account,Trade,LabExperiment} from '../../types';
import {qaState} from './state';
import '../../index.css';
setChartAppearanceUserId('qa-local-user');
const start=Date.parse('2026-08-03T14:00:00Z'), created=Date.now()-600000;
const research=await appendResearchRule({definition:{hypothesis:'Pravidlo snižuje průměrnou ztrátu.',rule:'Vstup až po potvrzení levelu.',falsification:'Expectancy pod nulou po cílovém vzorku.',targetPositions:5,timeZone:'UTC',...(new URLSearchParams(location.search).has('wide') ? {} : {development:{from:'2026-08-01',through:'2026-08-20'}}),validation:{from:'2026-08-21',through:'2026-08-31'}},recordedAt:created,operationId:'qa-rule-v1',reason:'První předem zapsaná hypotéza.'});
let stored:LabExperiment[]=[{id:'qa-case',world:'backtest',title:'QA test pravidel',hypothesis:research.revisions[0].definition.hypothesis,rule:research.revisions[0].definition.rule,targetTrades:5,startTs:created,createdAt:created,status:'running',clock:'recorded',baselineTradeIds:[],research}];
storageService.getLabExperiments=async()=>structuredClone(stored);
const account={id:'qa-account',name:'QA synthetic session',type:'Backtest',status:'Active',currency:'USD',initialBalance:50000} as Account;
const rows:Trade[]=Array.from({length:12},(_,i)=>({id:`qa-exit-${i}`,accountId:account.id,backtestRunId:'qa-run',instrument:'MNQ',signal:'QA',direction:'Long',pnl:[150,-60,80,-40,50,-20][i%6],riskAmount:100,runUp:10,drawdown:0,duration:'1m',durationMinutes:1,timestamp:start+i*86400000,date:new Date(start+i*86400000).toISOString(),recordedAt:created+1000+i,backtestResearch:{id:'binding',experimentId:'qa-case',revisionId:'qa-rule-v1',revisionHash:research.revisions[0].hash,role:'development'}}));
const runtime=createBacktestRuntime(50000);
runtime.closedTrades=rows.map((row,i)=>({id:String(row.id),runId:'qa-run',positionId:i<2?'qa-position-0':`qa-position-${i}`,instrument:'MNQ',entryTime:row.timestamp/1000-60,exitTime:row.timestamp/1000,pnl:row.pnl,direction:'Long',quantity:1,entryPrice:100,exitPrice:101,commission:0,grossPnl:row.pnl,reason:'manual'} as typeof runtime.closedTrades[number]));
qaState.savedRun={id:'qa-run',accountId:account.id,name:account.name,status:'paused',initialCapital:50000,baseCurrency:'USD',startAt:start,endAt:start+13*86400000,executionSymbol:'MNQ',replayInterval:'1m',cursorAt:start,config:{...DEFAULT_BACKTEST_CONFIG},workspaceState:{layoutId:'1'},runtimeState:runtime,revision:0,schemaVersion:1,createdAt:created,updatedAt:created,lastOpenedAt:created} as BacktestRun;
function Harness(){const [experiments,setExperiments]=useState(stored);const [mode,setMode]=useState('lab');const [accounts,setAccounts]=useState([account]);const [fail,setFail]=useState(false);const [lastRun,setLastRun]=useState<BacktestRun>();
return <div style={{background:'#070d1a',color:'#e2e8f0',minHeight:'100vh',padding:24}}><nav style={{display:'flex',gap:12,marginBottom:20}}><button onClick={()=>setMode('lab')}>QA Lab</button><button onClick={()=>setMode('sessions')}>QA Sessions</button><button onClick={()=>setFail(true)}>QA fail next save</button></nav>
{mode==='lab'?<LabPage trades={rows} accounts={accounts} theme="dark" dashboardMode="backtesting" preps={[]} reviews={[]} experiments={experiments} onUpdateExperiments={async next=>{if(fail){setFail(false);throw new Error('QA simulated save failure');}stored=structuredClone(next);setExperiments(stored);}}/>:<BacktestSessionsManager theme="dark" accounts={accounts} trades={rows} onUpdate={setAccounts} onOpenRun={setLastRun}/>}
<details><summary>QA stored evidence</summary><pre data-testid="qa-case-state">{JSON.stringify({cases:experiments.map(item=>({id:item.id,revisions:item.research?.revisions.map(v=>({id:v.id,parentId:v.parentId,version:v.version,rule:v.definition.rule}))})),lastRun},null,2)}</pre></details></div>}
createRoot(document.getElementById('root')!).render(<Harness/>);
