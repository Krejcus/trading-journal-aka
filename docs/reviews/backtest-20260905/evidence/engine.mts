import assert from 'node:assert/strict';
import {createBacktestRuntime,createBacktestOrder,enqueueBacktestOrder,processBacktestCandle,updatePositionBracket} from '/Users/filipkrejca/Documents/trading-journal-aka/services/backtestEngine.ts';
import {DEFAULT_BACKTEST_CONFIG} from '/Users/filipkrejca/Documents/trading-journal-aka/services/backtestTypes.ts';
import {managedPositionBoxes} from '/Users/filipkrejca/Documents/trading-journal-aka/services/backtestManagedPosition.ts';

const t=Date.UTC(2026,7,10,12,0)/1000;
const bar=(time:number,open:number,high:number,low:number,close:number)=>({time,open,high,low,close,volume:100});
const add=(s:any,input:any)=>enqueueBacktestOrder(s,createBacktestOrder({runId:'audit',instrument:'MNQ',quantity:1,now:t,...input}));
const step=(s:any,b:any,config=DEFAULT_BACKTEST_CONFIG)=>processBacktestCandle(s,'audit','MNQ',b,config);
const results:any[]=[];

// Resting limit: crossing down from 100 through 99 and then 98 is unavoidable.
let s=add(createBacktestRuntime(10000),{side:'buy',type:'limit',limitPrice:99,stopLoss:98,takeProfit:104});
s=step(s,bar(t+60,100,100,96,97));
assert.equal(s.positions.length,1); assert.equal(s.closedTrades.length,0);
results.push({case:'limit ignores certain stop on entry bar',actual:{positions:s.positions,closed:s.closedTrades.length},expected:'closed stop-loss at 98 on t+60'});
s=step(s,bar(t+120,100,104,100,104));
assert.equal(s.closedTrades[0].reason,'take-profit');
results.push({case:'the ignored stop becomes a profitable trade',actual:s.closedTrades[0],expected:'loss at 98 on previous bar'});

// A stop entry and same-bar target cross in known order too.
s=add(createBacktestRuntime(10000),{side:'buy',type:'stop',stopPrice:101,stopLoss:98,takeProfit:102});
s=step(s,bar(t+60,100,104,100,103));
assert.equal(s.positions.length,1); assert.equal(s.closedTrades.length,0);
results.push({case:'stop entry ignores certain same-bar TP',actual:{positions:s.positions.length,closed:s.closedTrades.length},expected:'closed take-profit at 102'});

// Workspace executeOrder places limit without advancing, then market calls whole engine.
const current=bar(t,100,102,98,100);
s=add(createBacktestRuntime(10000),{side:'buy',type:'limit',limitPrice:99});
s=add(s,{side:'buy',type:'market'}); s=step(s,current);
assert.equal(s.orders[0].status,'filled'); assert.equal(s.positions[0].quantity,2);
results.push({case:'market click fills fresh limit retroactively',actual:{orders:s.orders.map(x=>({type:x.type,status:x.status})),position:s.positions[0]},expected:'fresh limit stays pending; only market order fills at close'});

// Buy at known close then close on same candle. Only second click tests historical low.
s=add(createBacktestRuntime(10000),{side:'buy',type:'market',stopLoss:99,takeProfit:104});
s=step(s,current);
s=add(s,{side:'sell',type:'market',reduceOnly:true}); s=step(s,current);
assert.equal(s.closedTrades[0].reason,'stop-loss'); assert.equal(s.fills.length,3);
results.push({case:'manual close replays pre-entry stop and charges ghost exit',actual:{closed:s.closedTrades[0],fillCount:s.fills.length,commissions:s.commissions,balance:s.balance},expected:'one manual exit at 100; 2 fills, commission 0.74, balance 9999.26'});

// The target gets filled at 104 before high 120; high cannot be live MFE.
s=add(createBacktestRuntime(10000),{side:'buy',type:'market',stopLoss:98,takeProfit:104});
s=step(s,bar(t,100,100,100,100)); s=step(s,bar(t+60,100,120,100,119));
assert.equal(s.closedTrades[0].exitPrice,104); assert.equal(s.closedTrades[0].mfePoints,20);
results.push({case:'MFE contains price after position was closed',actual:s.closedTrades[0],expected:'live-position MFE 4 points = 2R, not 20 points = 10R'});

// Synthetic managed plan; first closedTrade is only a partial close.
s=add(createBacktestRuntime(10000),{side:'buy',type:'market',quantity:2});
s=step(s,bar(t,100,100,100,100));
s.managedPositionPlans=[{id:'plan',orderId:s.orders[0].id,instrument:'MNQ',tool:'LongPosition',startTime:t,entryPrice:100,targetPrice:104,stopPrice:98,style:{color:"#ffffff",width:1,dashed:false,fill:"#ffffff20"}}];
s=add(s,{side:'sell',type:'market',quantity:1,reduceOnly:true,now:t+60}); s=step(s,bar(t+60,101,101,101,101));
const boxes=managedPositionBoxes(s);
assert.equal(s.positions[0].quantity,1); assert.equal(boxes[0].state,'closed');
results.push({case:'partial close freezes managed position box',actual:{remaining:s.positions[0].quantity,boxes},expected:'box stays active for remaining contract'});

// Reduce-only request larger than exposure should execute/charge only available size.
s=add(createBacktestRuntime(10000),{side:'buy',type:'market'});s=step(s,bar(t,100,100,100,100));
s=add(s,{side:'sell',type:'market',quantity:5,reduceOnly:true,now:t+60});s=step(s,bar(t+60,101,101,101,101));
assert.equal(s.fills[1].quantity,5); assert.equal(s.closedTrades[0].quantity,1);
results.push({case:'oversized reduce-only fill and fees exceed closed quantity',actual:{fill:s.fills[1],closed:s.closedTrades[0],balance:s.balance,commissions:s.commissions},expected:'fill quantity 1, exit fee .37, balance 10001.26'});

// Configured slippage is also applied to TP limit, beyond allowed sell limit.
const slipping={...DEFAULT_BACKTEST_CONFIG,slippageTicks:{MNQ:1,NQ:1}};
s=add(createBacktestRuntime(10000),{side:'buy',type:'market',stopLoss:98,takeProfit:104});
s=step(s,bar(t,100,100,100,100),slipping);s=step(s,bar(t+60,101,104,101,104),slipping);
assert.equal(s.closedTrades[0].exitPrice,103.75);
results.push({case:'take-profit limit fills worse than its limit',actual:{exit:s.closedTrades[0].exitPrice,target:s.closedTrades[0].takeProfit},expected:'sell limit TP at least 104'});

console.log(JSON.stringify(results,null,2));
