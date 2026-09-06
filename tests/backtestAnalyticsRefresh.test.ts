import { describe, expect, it } from 'vitest';
import { planBacktestAnalyticsRefresh, backtestAnalyticsArePending, type BacktestAnalyticsRefreshInput, type BacktestRefreshTrade } from '../services/backtestAnalyticsRefresh';
import { backtestClosedTradeToTrade } from '../services/backtestIntel';
import type { BacktestClosedTrade } from '../services/backtestTypes';
const T = Date.UTC(2026,8,4,12)/1000;
const bar = (minute:number,high=101) => ({time:T+minute*60,open:100,high,low:100,close:100,volume:1});
const closed: BacktestClosedTrade = {id:'closed',runId:'run',positionId:'opening',instrument:'MNQ',direction:'Long',quantity:1,entryPrice:100,exitPrice:101,entryTime:T,exitTime:T+60,grossPnl:2,pnl:2,commission:0,reason:'manual',initialStopLoss:99,initialTakeProfit:102,riskAmount:2};
const mappingOptions = {accountId:'account',timeZone:'UTC',orderEvents:[],flatTimeZone:'UTC',flatByMinute:12*60+2};
const known=[bar(-1),bar(0),bar(1)];
const current:BacktestRefreshTrade = {...backtestClosedTradeToTrade(closed,{...mappingOptions,candles:known,replayHorizonTime:T+60}),notes:'My review',isValid:false,tags:['patience'],ltfConfluence:['manual'],autoConfluence:{htf:[],ltf:[]}};
const input:BacktestAnalyticsRefreshInput={trades:[current],closedTrades:[closed],candlesByInstrument:{MNQ:known},mappingOptions,replayHorizonTime:T+60};
const commit = (trade:BacktestRefreshTrade,candidate:ReturnType<typeof planBacktestAnalyticsRefresh>[number]):BacktestRefreshTrade => ({...trade,...candidate.updates,backtestAnalyticsRefresh:candidate.stamp});

describe('progressive derived analytics refresh',()=>{
 it('creates an idempotent stamp while preserving all review data',()=>{
  const [first]=planBacktestAnalyticsRefresh(input);
  expect(first.stamp.complete).toBe(false);
  expect(first.updates).not.toHaveProperty('notes');
  expect(first.updates).not.toHaveProperty('isValid');
  expect(first.updates).not.toHaveProperty('tags');
  expect(first.updates.ltfConfluence).toContain('manual');
  const saved=commit(current,first);
  expect(saved).toMatchObject({notes:'My review',isValid:false,tags:['patience']});
  expect(planBacktestAnalyticsRefresh({...input,trades:[saved]})).toEqual([]);
 });
 it('ignores prefetched future contents in both output and source hash',()=>{
  const first=planBacktestAnalyticsRefresh(input);
  expect(planBacktestAnalyticsRefresh({...input,candlesByInstrument:{MNQ:[...known,bar(2,1000)]}})).toEqual(first);
 });
 it('a new revealed bar completes every variant without manual review action',()=>{
  const saved=commit(current,planBacktestAnalyticsRefresh(input)[0]);
  const [next]=planBacktestAnalyticsRefresh({...input,trades:[saved],candlesByInstrument:{MNQ:[...known,bar(2,110)]},replayHorizonTime:T+120});
  expect(next.stamp.complete).toBe(true);
  expect(next.updates.excursionComplete).toBe(true);
  expect(backtestAnalyticsArePending(next.recalculated)).toBe(false);
  expect(next.updates.excursion?.mfePotentialR).toBe(1);
 });
 it('advancing the clock without new available data does not enqueue duplicate work',()=>{
  const saved=commit(current,planBacktestAnalyticsRefresh(input)[0]);
  expect(planBacktestAnalyticsRefresh({...input,trades:[saved],replayHorizonTime:T+120})).toEqual([]);
 });
 it('filled data holes retry at the same horizon; end of data stays pending',()=>{
  const sparse={...input,candlesByInstrument:{MNQ:[bar(-1),bar(0),bar(2)]},replayHorizonTime:T+120};
  const [first]=planBacktestAnalyticsRefresh(sparse);
  expect(first.stamp.complete).toBe(false);
  const [retry]=planBacktestAnalyticsRefresh({...sparse,trades:[commit(current,first)],candlesByInstrument:{MNQ:[...known,bar(2)]}});
  expect(retry.stamp.complete).toBe(true);
 });
 it('completed results ignore irrelevant later bars, but detect corrections to consumed data',()=>{
  const full={...input,candlesByInstrument:{MNQ:[...known,bar(2)]},replayHorizonTime:T+120};
  const saved=commit(current,planBacktestAnalyticsRefresh(full)[0]);
  expect(planBacktestAnalyticsRefresh({...full,trades:[saved],replayHorizonTime:T+600,candlesByInstrument:{MNQ:[...known,bar(2),bar(10,1000)]}})).toEqual([]);
  expect(planBacktestAnalyticsRefresh({...full,trades:[saved],candlesByInstrument:{MNQ:[bar(-1),bar(0),bar(1,101.5),bar(2)]}})).toHaveLength(1);
 });
 it('new schema version invalidates an old completed stamp',()=>{
  const saved=commit(current,planBacktestAnalyticsRefresh(input)[0]);
  saved.backtestAnalyticsRefresh={...saved.backtestAnalyticsRefresh!,schemaVersion:7,complete:true};
  expect(planBacktestAnalyticsRefresh({...input,trades:[saved]})).toHaveLength(1);
 });
 it('does not refresh foreign accounts, mismatched runs or not-yet-closed trades',()=>{
  expect(planBacktestAnalyticsRefresh({...input,trades:[{...current,accountId:'foreign'}]})).toEqual([]);
  expect(planBacktestAnalyticsRefresh({...input,trades:[{...current,backtestRunId:'other-run'}]})).toEqual([]);
  expect(planBacktestAnalyticsRefresh({...input,replayHorizonTime:T})).toEqual([]);
  expect(planBacktestAnalyticsRefresh({...input,replayHorizonTime:NaN})).toEqual([]);
 });
 it('a batch budget progresses after the first candidate is durably committed',()=>{
  const second={...closed,id:'second'};const secondTrade={...current,id:'second'};
  const pair={...input,trades:[current,secondTrade],closedTrades:[closed,second],maxTrades:1};
  const [first]=planBacktestAnalyticsRefresh(pair);
  expect(first.tradeId).toBe('closed');
  expect(planBacktestAnalyticsRefresh({...pair,trades:[commit(current,first),secondTrade]}).map(value=>value.tradeId)).toEqual(['second']);
 });
 it('lacking an initial stop is terminal unavailability, not an endless pending refresh',()=>{
  const [candidate]=planBacktestAnalyticsRefresh({...input,closedTrades:[{...closed,initialStopLoss:undefined,riskAmount:undefined}]});
  expect(candidate.stamp.complete).toBe(true);
 });
});
