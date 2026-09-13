import {describe,expect,it} from 'vitest';
import {sharedResultStats,formatSharedMetric} from '../lib/sharedTradeStats';
import {formatCurrency,formatPnL} from '../utils/formatPnL';
describe('shared statistics with unknown outcomes',()=>{
  it('does not rank or total a partially known sample',()=>{
    const stats=sharedResultStats([{pnl:20},{pnl:-10},{pnl:Number.NaN}]);
    expect(stats).toMatchObject({count:3,complete:false,pnl:null,winRate:null,profitFactor:null});
    expect(formatSharedMetric(stats.winRate,1,'%')).toBe('—');
  });
  it('excludes missed trades and uses only wins/losses in win rate',()=>{
    expect(sharedResultStats([{pnl:20},{pnl:-10},{pnl:0},{pnl:Number.NaN,executionStatus:'Missed'}]))
      .toMatchObject({count:3,complete:true,pnl:10,winRate:50,profitFactor:2});
    expect(sharedResultStats([{pnl:0}])).toMatchObject({pnl:0,winRate:null});
    expect(sharedResultStats([])).toMatchObject({count:0,pnl:null,winRate:null});
  });
  it('formats unavailable and overflow values as unknown across currencies and percentages',()=>{
    for(const value of [Number.NaN,Infinity,-Infinity]){
      expect(formatCurrency(value,'USD')).toBe('—');
      expect(formatPnL(value,'percent',50000)).toBe('—');
      expect(formatSharedMetric(value)).toBe('—');
    }
  });
});
