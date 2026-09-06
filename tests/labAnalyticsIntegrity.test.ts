import { describe, expect, it } from 'vitest';
import * as app from '../services/labAnalytics';
import * as mcp from '../supabase/functions/mcp-server/labAnalytics';
import type { Trade } from '../types';
const trade = (overrides: Partial<Trade> = {}): Trade => ({ id:'trade',accountId:'account',signal:'test',pnl:100,riskAmount:100,runUp:0,drawdown:0,date:'2026-08-04T12:00:00Z',direction:'Long',timestamp:Date.UTC(2026,7,4,12),duration:'1m',durationMinutes:1,outcome:'Win', ...overrides });
const placement = (overrides:Record<string,unknown>={}) => ({ok:true,valid:true,complete:true,ambiguous:false,realizedR:2,netRealizedR:1.5,riskAmount:200,outcome:'WIN',rr:2,trail:{realizedR:3,netRealizedR:2.5,riskAmount:200,complete:true,ambiguous:false},...overrides});
const cf = (overrides:Record<string,unknown>={}) => ({available:true,complete:true,swing:placement(),...overrides});
const path = (overrides:Record<string,unknown>={}) => ({available:true,version:1,complete:true,hasGaps:false,maxAdverseR:0.5,maxFavorableR:1,timeToSlPct:{50:1},candleStops:{firstComplete:{outcome:'WIN',realizedR:1,netRealizedR:-0.25,complete:true,ambiguous:false}},...overrides});

// The Edge Function intentionally uses a looser raw Trade interface. Fixtures here satisfy the full app contract; run identical behavioral assertions through both runtimes.
describe.each([['app',app],['local MCP',mcp as unknown as typeof app]] as const)('%s confirmed analytics',(_,api)=>{
 it('normalizes alternative stop risk to original R and actual fixed-quantity dollars',()=>{
  const ds=api.buildLabDatasetFromTrades([trade({counterfactual:cf()})],'backtest');
  const result=api.computeCfSummary(ds);
  expect(result.variants.find(v=>v.key==='swF')).toMatchObject({r:3,usd:300,realR:1,realUsd:100,n:1});
  expect(result.variants.find(v=>v.key==='swT')).toMatchObject({r:5,usd:500,n:1});
 });
 it('rejects explicit incomplete, gaps and ambiguity while preserving a proven sibling',()=>{
  const raw=[trade({id:'pending',counterfactual:cf({swing:placement({complete:false})})}),trade({id:'gap',counterfactual:cf({swing:placement({hasGaps:true,trail:null})})}),trade({id:'ambiguous',counterfactual:cf({swing:placement({ambiguous:true,trail:null})})})];
  const result=api.computeCfSummary(api.buildLabDatasetFromTrades(raw,'backtest'));
  expect(result.variants.find(v=>v.key==='swF')).toMatchObject({n:0,excluded:3,r:0});
  expect(result.variants.find(v=>v.key==='swT')).toMatchObject({n:1,r:5});
  expect(result.excluded).toBe(3);
 });
 it('parent aggregate pending does not suppress a terminal child that ended before its gap',()=>{
  const ds=api.buildLabDatasetFromTrades([trade({counterfactual:cf({complete:false,hasGaps:true,swing:placement()})})]);
  expect(api.computeCfSummary(ds).variants.find(v=>v.key==='swF')?.n).toBe(1);
 });
 it('legacy values without explicit quality or net metadata retain their documented fallback',()=>{
  const ds=api.buildLabDatasetFromTrades([trade({counterfactual:{available:true,swing:{realizedR:2,trail:{realizedR:3},outcome:'WIN'}}})]);
  expect(api.computeCfSummary(ds).variants.find(v=>v.key==='swF')).toMatchObject({n:1,r:2,usd:200});
 });
 it('target selection and management pairs cannot select an uncertain or pending apparent winner',()=>{
  const ds=api.buildLabDatasetFromTrades([trade({counterfactual:cf({tpTargets:[{label:'valid',realizedR:3,netRealizedR:2,riskAmount:100,complete:true},{label:'fake',netRealizedR:999,ambiguous:true}],variants:[{label:'initial',netRealizedR:0.5,complete:true},{label:'pending',netRealizedR:999,complete:false}]})})]);
  expect(ds.trades[0].cf?.tpBest).toEqual({label:'valid',r:2});
  expect(api.computeCfSummary(ds).managementVariants).toEqual([{label:'initial',n:1,r:0.5,realR:1,deltaR:-0.5,excluded:0},{label:'pending',n:0,r:0,realR:0,deltaR:0,excluded:1}]);
 });
 it('incomplete and bounded excursion is excluded, and missing coverage never implies optimal exits',()=>{
  const ds=api.buildLabDatasetFromTrades([trade({counterfactual:cf(),excursion:{available:true,complete:false,mfePotentialR:10,leftOnTableR:8}}),trade({id:'bound',excursion:{available:true,complete:true,ambiguous:true,mfePotentialR:1,mfePotentialUpperR:10,leftOnTableR:8}})]);
  expect(ds.coverage).toMatchObject({withExc:0,excludedExc:2});
  const summary=api.computeCfSummary(ds);
  expect(summary.leftTotalR).toBe(0);
  expect(api.buildLeftInsight(summary)).toBeNull();
  expect(api.buildLabReport(ds).pokryti.vyrazena_excursion).toBe(2);
 });
 it('candle-stop comparisons use net results and classify a gross win after fees as a net loss',()=>{
  const ds=api.buildLabDatasetFromTrades([trade({executionPath:path()})]);
  expect(api.computeExecutionSummary(ds).candleStops.firstComplete).toMatchObject({n:1,variantR:-0.25,actualR:1,deltaR:-1.25,winratePct:0});
 });
 it('MAE bounds do not enter exact buckets, but independently confirmed candle-stop exits remain usable',()=>{
  const ds=api.buildLabDatasetFromTrades([trade({executionPath:path({terminalBarOrderingUnknown:true,maeAmbiguous:true})})]);
  const result=api.computeExecutionSummary(ds);
  expect(result.covered).toBe(0);expect(result.excluded).toBe(1);
  expect(result.candleStops.firstComplete.n).toBe(1);
 });
 it('ambiguous actual execution keeps ledger P&L but is not a confirmed paired benchmark',()=>{
  const ds=api.buildLabDatasetFromTrades([trade({outcomeAmbiguous:true,counterfactual:cf(),executionPath:path()})]);
  expect(api.computeOverview(ds).pnl).toBe(100);
  expect(api.computeCfSummary(ds).covered).toBe(0);
  expect(api.computeExecutionSummary(ds).candleStops.firstComplete.n).toBe(0);
 });
 it('a missing initial path appears in excluded coverage instead of disappearing silently',()=>{
  const ds=api.buildLabDatasetFromTrades([trade({executionPath:{available:false,version:1,hasGaps:true,complete:false},excursion:{available:false,hasGaps:true,complete:false}})]);
  expect(ds.coverage).toMatchObject({excludedPath:1,excludedExc:1});
 });
});

it('local MCP mirrors B15 recorded-time cohorts and analytic numbers exactly',()=>{
 const start=Date.UTC(2026,8,5,12);
 const raw=[trade({id:'before',recordedAt:start-1000,counterfactual:cf()}),trade({id:'after',recordedAt:start+1000,executionPath:path()}),trade({id:'unknown'})];
 const left=app.buildLabDatasetFromTrades(raw,'backtest');const right=mcp.buildLabDatasetFromTrades(raw,'backtest');
 expect(mcp.buildLabReport(right)).toEqual(app.buildLabReport(left));
 const options={startTs:start,targetTrades:1};
 expect(mcp.computeExperimentReport(right,options)).toEqual(app.computeExperimentReport(left,options));
 expect(mcp.computeExperimentReport(right,options).cohort).toEqual({clock:'recorded',beforeTradeIds:['before'],afterTradeIds:['after'],unknownTradeIds:['unknown'],unlinkedTradeIds:[]});
});
