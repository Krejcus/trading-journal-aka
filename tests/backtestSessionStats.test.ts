import { describe, expect, it } from 'vitest';
import { backtestSessionStats } from '../services/backtestSessionStats';
import { createBacktestRuntime } from '../services/backtestEngine';
import type { BacktestClosedTrade, BacktestPosition } from '../services/backtestTypes';

const exit = (pnl:number, i:number, positionId=`position-${i}`):BacktestClosedTrade => ({
  id:`exit-${i}`,runId:'run',positionId,instrument:'MNQ',direction:'Long',quantity:1,
  entryPrice:100,exitPrice:100+pnl/2,entryTime:1000+i*60,exitTime:1030+i*60,
  grossPnl:pnl+0.74,commission:0.74,pnl,reason:'manual',
});
function sample(pnls:number[]) {
  const runtimeState=createBacktestRuntime(50000);
  runtimeState.closedTrades=pnls.map((pnl,i)=>exit(pnl,i));
  return {id:'run',accountId:'account',baseCurrency:'USD',runtimeState};
}

describe('session performance from the canonical replay ledger',()=>{
  it('computes win rate including BE, net profit factor, average and realized drawdown',()=>{
    const run=sample([100,-40,0,60,-20]); const original=structuredClone(run);
    const stats=backtestSessionStats(run);
    expect(stats).toMatchObject({count:5,wins:2,losses:2,breakeven:1,winRate:40,averagePnl:20,maxDrawdown:40,excludedExits:0});
    expect(stats.profitFactor).toBeCloseTo(160/60);
    expect(run).toEqual(original);
  });
  it('counts partial exits once and classifies their combined net result',()=>{
    const run=sample([100,-120,80]);
    run.runtimeState.closedTrades[1].positionId='position-0';
    expect(backtestSessionStats(run)).toMatchObject({count:2,wins:1,losses:1,winRate:50,profitFactor:4,averagePnl:30,maxDrawdown:120});
  });
  it('excludes partial realizations of a position which remains open',()=>{
    const run=sample([100,-20]);
    run.runtimeState.positions=[{positionId:'position-0',instrument:'MNQ',side:'long',quantity:1,averagePrice:100,openedAt:1000,entryFillIds:[],entryCommission:0} satisfies BacktestPosition];
    expect(backtestSessionStats(run)).toMatchObject({count:1,wins:0,losses:1,winRate:0,averagePnl:-20,maxDrawdown:20,excludedExits:1});
  });
  it('distinguishes no trades, all BE and winners without losses',()=>{
    expect(backtestSessionStats(sample([]))).toMatchObject({count:0,winRate:null,profitFactor:null,profitFactorState:'no-results',averagePnl:null,maxDrawdown:null});
    expect(backtestSessionStats(sample([0,0]))).toMatchObject({count:2,winRate:0,breakeven:2,profitFactor:null,profitFactorState:'no-results',averagePnl:0,maxDrawdown:0});
    expect(backtestSessionStats(sample([10,20]))).toMatchObject({count:2,winRate:100,profitFactor:null,profitFactorState:'no-losses',averagePnl:15,maxDrawdown:0});
  });
  it('does not invent legacy identities or count duplicate exits',()=>{
    const run=sample([100,50]);
    run.runtimeState.closedTrades[0].positionId=undefined;
    expect(backtestSessionStats(run)).toMatchObject({count:1,averagePnl:50,excludedExits:1});
    run.runtimeState.closedTrades.push(structuredClone(run.runtimeState.closedTrades[1]));
    expect(backtestSessionStats(run)).toMatchObject({count:0,winRate:null,excludedExits:3});
  });
  it('invalid data cannot turn an incomplete losing position into a winner',()=>{
    const run=sample([100,-120,80]);
    run.runtimeState.closedTrades[1].positionId='position-0';
    run.runtimeState.closedTrades[1].pnl=NaN;
    expect(backtestSessionStats(run)).toMatchObject({count:1,wins:1,averagePnl:80,excludedExits:2});
  });
  it('uses net pnl once, regardless of gross P&L or commission display fields',()=>{
    const run=sample([10,-5]);
    run.runtimeState.closedTrades.forEach(t=>{t.commission=100;t.grossPnl=999;});
    expect(backtestSessionStats(run)).toMatchObject({winRate:50,profitFactor:2,averagePnl:2.5});
  });
});
