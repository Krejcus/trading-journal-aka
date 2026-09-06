import { createBacktestRuntime, createBacktestOrder, enqueueBacktestOrder, processBacktestCandle, processBacktestCandles } from '/Users/filipkrejca/Documents/trading-journal-aka/services/backtestEngine.ts';
import { DEFAULT_BACKTEST_CONFIG } from '/Users/filipkrejca/Documents/trading-journal-aka/services/backtestTypes.ts';
import { advanceReplayTimeByInterval } from '/Users/filipkrejca/Documents/trading-journal-aka/services/chartReplay.ts';
import { resolveReplayGoTo, DEFAULT_REPLAY_GO_TO_SETTINGS } from '/Users/filipkrejca/Documents/trading-journal-aka/services/replayGoTo.ts';
const base = Date.parse('2026-08-04T10:00:00Z')/1000;
const bar = (offset:number, high=100.5) => ({time:base+offset,open:100,high,low:99.5,close:100,volume:1});
const all=[bar(0),bar(60),bar(120,103),bar(180),bar(240),bar(300)];
const config={...DEFAULT_BACKTEST_CONFIG,commissionPerSide:{MNQ:0,NQ:0},slippageTicks:{MNQ:0,NQ:0}};
let seed=enqueueBacktestOrder(createBacktestRuntime(50000),createBacktestOrder({runId:'review',instrument:'MNQ',side:'buy',type:'market',quantity:1,stopLoss:98,takeProfit:102,now:base}));
seed=processBacktestCandle(seed,'review','MNQ',all[0],config);
const result=resolveReplayGoTo({kind:'date',unixSeconds:base+240},{candles:all.slice(0,2),cursorTime:base,settings:DEFAULT_REPLAY_GO_TO_SETTINGS,timeZone:'UTC',dataEndTime:base+3600});
if(result.kind!=='ok')throw new Error('GoTo error');
const cursor=result.value.cursorTime;
// BacktestWorkspace 399–406: process currently loaded bars, then mark requested cursor processed.
let actual=processBacktestCandles(seed,'review','MNQ',all.slice(0,2).filter(c=>c.time>base && c.time<=cursor),config);
const lastProcessedCursor=cursor;
// Late load appends bars; onReplayChange is not invoked because replay object did not change.
// Next normal replay step only includes bars after the committed cursor.
actual=processBacktestCandles(actual,'review','MNQ',all.filter(c=>c.time>lastProcessedCursor && c.time<=base+300),config);
const expected=processBacktestCandles(seed,'review','MNQ',all.slice(1),config);
console.log(JSON.stringify({case:'Go To through unloaded target hit',cursorIso:new Date(cursor*1000).toISOString(),actual:{closed:actual.closedTrades.length,positions:actual.positions.length,balance:actual.balance},expected:{closed:expected.closedTrades.length,positions:expected.positions.length,balance:expected.balance,reason:expected.closedTrades[0]?.reason}},null,2));
const loaded=Array.from({length:801},(_,i)=>bar(i*60));
const next=advanceReplayTimeByInterval(loaded,base,1440);
const remaining=loaded.filter(c=>c.time>base).length;
console.log(JSON.stringify({case:'1d step before loaded chunk edge',next,remainingBars:remaining,prefetchCondition:base>=loaded.at(-1)!.time || remaining<240,hasMoreSessionData:true},null,2));
const start=Date.parse('2026-07-01T00:00:00Z'),saved=Date.parse('2026-07-20T00:00:00Z');
const segment=3*86400000,prefetch=86400000;
const contextStart=Math.max(start,saved-segment+prefetch);
const oldestVisible=contextStart;
const requestedHistoryEnd=Math.min(oldestVisible,start,start);
console.log(JSON.stringify({case:'resume history missing in-session prefix',initialSegmentStart:new Date(contextStart).toISOString(),historyFetchEnd:new Date(requestedHistoryEnd).toISOString(),missingDays:(contextStart-requestedHistoryEnd)/86400000},null,2));
