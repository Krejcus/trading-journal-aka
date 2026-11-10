import { createCopierState, type LeaderEvent } from '../services/copierEngine';
import { createRiskGateContext } from '../services/copierRiskGate';
import { createRuntime, processLeaderEvent } from '../services/copierRunner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTradovateBroker, type WebSocketLike } from '../services/tradovateBroker';
import { BrokerRequestNotSentError } from '../services/brokerPort';
import { createTradovateRequestGovernor } from '../services/tradovateRequestControlGovernor';
import { createTradovateControlledFetch } from '../services/tradovateRequestControlFetch';
import { tradovateRequestContext } from '../server/tradovateRequestContext';
import type { TradovateRequestControlSnapshot } from '../lib/tradovateRequestControl';

const response = (value: unknown) => Response.json(value);
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve: (value: T) => resolve(value) }; }
function fixture() {
  let now = 1_000_000;
  let state: TradovateRequestControlSnapshot = { version: 1, brokerUserId: 77, serverNow: now, epoch: 0, blockedUntil: null, captchaRequired: false,
    evidence: null, reason: null, backgroundReservedHour: 0, backgroundReservedMinute: 0, policyVersion: 2, riskReservedHour: 0, riskReservedMinute: 0, controlReservedHour: 0, controlReservedMinute: 0, totalReservedHour: 0 };
  const remote = {
    read: vi.fn(async () => ({ ...state, serverNow: now })),
    reserve: vi.fn(async (input: {grantId:string;purpose:'background'|'risk'|'entry'|'management'|'control';units:number;ttlMs:number}) => ({ version: 1 as const,
      brokerUserId: 77, grantId: input.grantId, purpose: input.purpose, units: input.units, serverNow: now, validUntil: now + input.ttlMs, epoch: state.epoch })),
    penalize: vi.fn(async (penalty: {retryAfterMs:number;reason:string;evidence:'raw-429'|'retry-after'|'p-time'|'captcha';captchaRequired?:boolean}) => {
      state = { ...state, serverNow: now, epoch: state.epoch + 1, blockedUntil: now + penalty.retryAfterMs,
        captchaRequired: penalty.captchaRequired === true, reason: penalty.reason, evidence: penalty.evidence }; return state;
    }),
  };
  const governor = createTradovateRequestGovernor({ brokerUserId: 77, remote, store: { load: async () => null, save: async () => undefined }, clock: () => now, monotonic: () => now, wait: async ms => { now += ms; await Promise.resolve(); } });
  return { governor, remote, clock: () => now, advance: (ms:number) => { now += ms; }, budget: () => { state.backgroundReservedHour = 3000; }, totalBudget: () => { state.totalReservedHour = 4000; } };
}
class Socket implements WebSocketLike {
  readyState = 0; onopen: (()=>void)|null = null; onmessage: ((event:{data:unknown})=>void)|null=null;
  onerror:(()=>void)|null=null; onclose:(()=>void)|null=null; sent:string[]=[];
  send(value:string) { this.sent.push(value); } close(){this.readyState=3;this.onclose?.();}
  deliver(value:unknown){this.onmessage?.({data:`a${JSON.stringify(value)}`});}
}
afterEach(() => vi.useRealTimers());
const order = { accountId: 101, tag: 'own-entry', symbol: 'MNQZ6', quantity: 1, side:'Buy' as const, orderType:'Market' as const };

describe('Tradovate broker final request-control integration', () => {
  it('front metadata uses exactly three bounded control reads while background is full', async () => {
    const f=fixture(); await f.governor.initialize();f.budget();f.advance(1);await f.governor.sync();
    const wire=vi.fn(async(input:string|URL|Request)=>{
      const path=new URL(String(input)).pathname;
      if(path.endsWith('/product/find'))return response({id:42,name:'MNQ'});
      if(path.endsWith('/contractMaturity/deps'))return response([{id:8,productId:42,isFront:true,archived:false,expirationDate:'2026-12-18'}]);
      if(path.endsWith('/contract/deps'))return response([{id:99,contractMaturityId:8,name:'MNQZ6'}]);
      throw Error('Unexpected path '+path);
    });
    const broker=createTradovateBroker({environment:'demo',accessToken:'token',requestControl:f.governor,fetchImpl:wire,
      requestPurpose:tradovateRequestContext.current,runWithRecoveryRequests:tradovateRequestContext.recovery});
    await expect(broker.frontContract!('MNQ',101)).resolves.toEqual({contract:'MNQZ6',expiration:'2026-12-18'});
    expect(wire).toHaveBeenCalledTimes(3);
    expect(f.remote.reserve.mock.calls.map(call=>call[0].purpose)).toEqual(['control','control','control']);
    expect(broker.newRiskRequestBlocker?.([101])).toBeNull();
    expect(tradovateRequestContext.current()).toBeUndefined();
  });

  it.each(['raw-429','captcha'] as const)('front recovery cannot cross actual%s arriving during token await', async evidence => {
    const f=fixture();await f.governor.initialize();const token=deferred<string>(),wire=vi.fn(async()=>response({id:42,name:'MNQ'}));
    const broker=createTradovateBroker({environment:'demo',getAccessToken:()=>token.promise,requestControl:f.governor,fetchImpl:wire,
      requestPurpose:tradovateRequestContext.current,runWithRecoveryRequests:tradovateRequestContext.recovery});
    const pending=broker.frontContract!('MNQ',101);await flush();
    await f.governor.penalize({evidence,reason:'actual broker refusal',retryAfterMs:evidence==='raw-429'?3_600_000:0,...(evidence==='captcha'?{captchaRequired:true}:{})});
    token.resolve('token');await expect(pending).rejects.toBeInstanceOf(BrokerRequestNotSentError);
    expect(wire).not.toHaveBeenCalled();
  });

  it.each([0,2])('front recovery never selects an ambiguous isFront set of%i',async count=>{
    const f=fixture();await f.governor.initialize();
    const wire=vi.fn(async(input:string|URL|Request)=>response(String(input).includes('/product/find')?{id:42,name:'MNQ'}:Array.from({length:count},(_,i)=>({id:8+i,productId:42,isFront:true}))));
    const broker=createTradovateBroker({environment:'demo',accessToken:'token',requestControl:f.governor,fetchImpl:wire,
      requestPurpose:tradovateRequestContext.current,runWithRecoveryRequests:tradovateRequestContext.recovery});
    await expect(broker.frontContract!('MNQ',101)).resolves.toBeNull();expect(wire).toHaveBeenCalledTimes(2);
  });

  it('actual penalty during token await stops the current write before fetch and keeps dispatch count zero', async () => {
    const f = fixture(); await f.governor.initialize();
    const token = deferred<string>(), wire = vi.fn(async () => response({ orderId: 900 }));
    const broker = createTradovateBroker({ environment:'demo', accountSpec:'DEMO', getAccessToken:()=>token.promise,
      requestControl:f.governor, fetchImpl:wire });
    const result = broker.placeOrder(order);
    await flush();
    await f.governor.penalize({ evidence:'raw-429', reason:'actual429', retryAfterMs:3_600_000 });
    token.resolve('token');
    await expect(result).rejects.toBeInstanceOf(BrokerRequestNotSentError);
    expect(wire).not.toHaveBeenCalled();
    expect(f.governor.health().counts).toMatchObject({ dispatchAttempts:0, blockedBeforeDispatch:1, transportUnknown:0 });
  });

  it('token refresh cannot dispatch under another broker principal', async () => {
    const f=fixture(); await f.governor.initialize(); let brokerUserId=77;
    const token=deferred<string>(), wire=vi.fn(async()=>response({orderId:900}));
    const broker=createTradovateBroker({environment:'demo',accountSpec:'DEMO',getAccessToken:()=>token.promise,requestControl:f.governor,
      resolveBrokerUserId:()=>brokerUserId,fetchImpl:wire});
    const result=broker.placeOrder(order); await flush(); brokerUserId=78; token.resolve('new-token');
    await expect(result).rejects.toBeInstanceOf(BrokerRequestNotSentError); expect(wire).not.toHaveBeenCalled();
  });

  it('one raw display429 blocks both OAuth adapters including management, with no second physical request', async () => {
    const f=fixture(); await f.governor.initialize(); const wire=vi.fn(async()=>new Response('',{status:429}));
    const raw=createTradovateControlledFetch(f.governor,wire);
    const adapters=[1,2].map(()=>createTradovateBroker({environment:'demo',accountSpec:'DEMO',accessToken:'token',requestControl:f.governor,fetchImpl:wire}));
    await raw('https://example.invalid/display');
    for(const broker of adapters) await expect(broker.placeOrder(order)).rejects.toBeInstanceOf(BrokerRequestNotSentError);
    expect(wire).toHaveBeenCalledTimes(1); expect(f.governor.health().state).toBe('cooldown');
    expect(f.governor.health().counts).toMatchObject({dispatchAttempts:1,responses:1,blockedBeforeDispatch:2});
  });

  it('total soft budget blocks new risk but accepted management and its verification read still dispatch', async () => {
    const f=fixture(); await f.governor.initialize(); f.budget(); await f.governor.sync();
    const wire=vi.fn(async(input:string|URL|Request)=>response(String(input).includes('/order/placeorder')?{orderId:900}:[]));
    const broker=createTradovateBroker({environment:'demo',accountSpec:'DEMO',accessToken:'token',requestControl:f.governor,fetchImpl:wire,
      requestPurpose:tradovateRequestContext.current,runWithAcceptedRequests:tradovateRequestContext.accepted});
    // Plný zobrazovací pruh odmítá jen background čtení; nové riziko blokuje až celkový strop.
    expect(broker.newRiskRequestBlocker?.([101])).toBeNull();
    await expect(broker.listPositions(101)).rejects.toBeInstanceOf(BrokerRequestNotSentError);
    f.totalBudget(); f.advance(1); await f.governor.sync();
    expect(broker.newRiskRequestBlocker?.([101])).toContain('budget');
    await expect(broker.runWithAcceptedRequests!(async()=>{await broker.placeOrder(order);return broker.listPositions(101);})).resolves.toEqual([]);
    expect(wire).toHaveBeenCalledTimes(2);
  });

  it.each([4,8])('risk for%i accounts uses documented scoped id-only dependencies plus one own USD cash batch', async count => {
    const f=fixture(); await f.governor.initialize();
    const ids=Array.from({length:count},(_,i)=>101+i); const wire=vi.fn(async(input:string|URL|Request)=>{
      const url=new URL(String(input)),path=url.pathname,accountId=Number(url.searchParams.get('masterid'));
      if(path.endsWith('/currency/list'))return response([{id:17,name:'USD'},{id:1,name:'EUR'}]);
      if(path.endsWith('/cashBalance/list'))return response([{amount:999999,currencyId:17},{accountId:999,amount:12345,currencyId:17},...ids.map(accountId=>({accountId,currencyId:17,amount:50000+accountId,realizedPnL:0,openPnL:0}))]);
      if(path.endsWith('/accountRiskStatus/deps'))return response([{id:700000+accountId,maxNetLiq:50100}]);
      if(path.endsWith('/userAccountAutoLiq/deps'))return response([{id:800000+accountId,dailyLossAutoLiq:1000,trailingMaxDrawdown:2000}]);
      throw new Error(path);
    });
    const broker=createTradovateBroker({environment:'demo',accessToken:'token',requestControl:f.governor,fetchImpl:wire,clock:f.clock});
    const rows=await broker.listAccountRiskSnapshots(ids),originalAt=rows[0].at;
    expect(wire).toHaveBeenCalledTimes(2+2*count);expect(rows.map(row=>row.accountId)).toEqual(ids);
    expect(rows[0]).toMatchObject({cashBalanceUsd:50101,realizedPnlUsd:0,highWaterNetLiq:50100,dailyLossAutoLiq:1000,minNetLiq:48100});
    f.advance(1);await f.governor.sync();await broker.listAccountRiskSnapshots(ids);expect(wire).toHaveBeenCalledTimes(3+4*count);
    expect(wire.mock.calls.filter(call=>String(call[0]).includes('/currency/list'))).toHaveLength(1);
    expect(rows[0].at).toBe(originalAt); // New reads never refresh already-issued evidence.
    expect(wire.mock.calls.some(call=>/accountRiskStatus\/list|userAccountAutoLiq\/list/.test(String(call[0])))).toBe(false);
  });

  it.each(['missing','non-usd','multiple-currencies','duplicate-usd','multiple-risk-ids','conflicting-risk-owner'] as const)('rejects ambiguous cash or scoped risk ownership:%s',async issue=>{
    const f=fixture();await f.governor.initialize();const wire=vi.fn(async(input:string|URL|Request)=>{
      const path=String(input);
      if(path.includes('/currency/list'))return response([{id:17,name:'USD'},{id:1,name:'EUR'}]);
      if(path.includes('/cashBalance/list'))return response(issue==='missing'?[]:issue==='non-usd'?[{accountId:101,currencyId:1,amount:50000}]:issue==='multiple-currencies'?[{accountId:101,currencyId:17,amount:50000},{accountId:101,currencyId:1,amount:200}]:issue==='duplicate-usd'?[{accountId:101,currencyId:17,amount:50000},{accountId:101,currencyId:17,amount:50100}]:[{accountId:101,currencyId:17,amount:50000}]);
      if(path.includes('/accountRiskStatus/deps'))return response(issue==='multiple-risk-ids'?[{id:123,maxNetLiq:50000},{id:987,maxNetLiq:60000}]:issue==='conflicting-risk-owner'?[{id:123,accountId:999,maxNetLiq:50000}]:[{id:123,maxNetLiq:50000}]);
      if(path.includes('/userAccountAutoLiq/deps'))return response([{id:987,dailyLossAutoLiq:1000,trailingMaxDrawdown:2000}]);
      throw new Error(path);
    });
    const broker=createTradovateBroker({environment:'demo',accessToken:'token',requestControl:f.governor,fetchImpl:wire,clock:f.clock});
    await expect(broker.listAccountRiskSnapshots([101])).rejects.toThrow(/ambiguous|USD|Ambiguous/);
  });

  it('USD metadata cache is bound to its organization REST host',async()=>{
    const f=fixture();await f.governor.initialize();let host='demo.tradovateapi.com';
    const wire=vi.fn(async(input:string|URL|Request)=>{
      const url=new URL(String(input)),currencyId=url.hostname==='demo.tradovateapi.com'?17:840;
      if(url.pathname.endsWith('/currency/list'))return response([{id:currencyId,name:'USD'}]);
      if(url.pathname.endsWith('/cashBalance/list'))return response([{accountId:101,currencyId,amount:50000,realizedPnL:0}]);
      if(url.pathname.endsWith('/accountRiskStatus/deps'))return response([{id:700001,maxNetLiq:50100}]);
      if(url.pathname.endsWith('/userAccountAutoLiq/deps'))return response([{id:800001,trailingMaxDrawdown:2000}]);
      throw new Error(url.pathname);
    });
    const broker=createTradovateBroker({environment:'demo',accessToken:'token',requestControl:f.governor,fetchImpl:wire,clock:f.clock,resolveApiHosts:()=>({demo:host})});
    await expect(broker.listAccountRiskSnapshots([101])).resolves.toEqual([expect.objectContaining({cashBalanceUsd:50000,minNetLiq:48100})]);
    host='demo-api.lucid.ninjatrader.com';
    await expect(broker.listAccountRiskSnapshots([101])).resolves.toEqual([expect.objectContaining({cashBalanceUsd:50000,minNetLiq:48100})]);
    expect(wire.mock.calls.filter(call=>String(call[0]).includes('/currency/list')).map(call=>new URL(String(call[0])).hostname)).toEqual(['demo.tradovateapi.com','demo-api.lucid.ninjatrader.com']);
  });

  it('risk snapshot fails closed if the organization host changes while a dependent response is held',async()=>{
    const f=fixture();await f.governor.initialize();let host='demo.tradovateapi.com';const held=deferred<Response>();
    const wire=vi.fn(async(input:string|URL|Request)=>{
      const path=String(input);if(path.includes('/currency/list'))return response([{id:17,name:'USD'}]);
      if(path.includes('/cashBalance/list'))return response([{accountId:101,currencyId:17,amount:50000}]);
      if(path.includes('/accountRiskStatus/deps'))return response([{id:700001,maxNetLiq:50100}]);
      if(path.includes('/userAccountAutoLiq/deps'))return held.promise;throw new Error(path);
    });
    const broker=createTradovateBroker({environment:'demo',accessToken:'token',requestControl:f.governor,fetchImpl:wire,clock:f.clock,resolveApiHosts:()=>({demo:host})});
    const result=broker.listAccountRiskSnapshots([101]);await flush();host='demo-api.lucid.ninjatrader.com';held.resolve(response([{id:800001,trailingMaxDrawdown:2000}]));
    await expect(result).rejects.toThrow(/source changed/);
  });

  it('WebSocket management denied after actual cooldown never falls back to REST or retries', async()=>{
    const f=fixture();await f.governor.initialize();const socket=new Socket();const wire=vi.fn(async()=>response([]));
    const broker=createTradovateBroker({environment:'demo',accessToken:'token',accountSpec:'DEMO',requestControl:f.governor,
      preferWebSocketOrderWrites:true,fetchImpl:wire,clock:f.clock,webSocketFactory:()=>socket});
    const unsubscribe=broker.subscribe(()=>undefined);
    socket.readyState=1;socket.onopen?.();socket.onmessage?.({data:'o'});await flush();socket.deliver([{i:0,s:200,d:{}}]);await flush();socket.deliver([{i:1,s:200,d:[]}]);await flush();
    const sent=socket.sent.length, requests=wire.mock.calls.length;
    await f.governor.penalize({evidence:'raw-429',retryAfterMs:3_600_000,reason:'actual broker429'});
    await expect(broker.placeOrder(order)).rejects.toBeInstanceOf(BrokerRequestNotSentError);
    expect(socket.sent).toHaveLength(sent);expect(wire).toHaveBeenCalledTimes(requests);unsubscribe();
  });

  it('terminal actual captcha does not open a new socket as a probe', async()=>{
    const f=fixture();await f.governor.initialize();await f.governor.penalize({evidence:'captcha',retryAfterMs:1000,reason:'actual captcha',captchaRequired:true});
    const factory=vi.fn(()=>new Socket());const broker=createTradovateBroker({environment:'demo',accessToken:'token',requestControl:f.governor,webSocketFactory:factory});
    const unsubscribe=broker.subscribe(()=>undefined);await flush();expect(factory).not.toHaveBeenCalled();unsubscribe();
  });

  it.each(['raw','adapter'] as const)('%s423 holds other writes while parsing and preserves an explicit short15s penalty',async source=>{
    const f=fixture();await f.governor.initialize();const body=deferred<unknown>();
    const slow=new Response('{}',{status:423,headers:{'Content-Type':'application/json'}});
    Object.defineProperty(slow,'clone',{value:()=>({json:()=>body.promise})});
    let calls=0;const wire=vi.fn(async()=>++calls===1?slow:response({orderId:900}));
    const broker=createTradovateBroker({environment:'demo',accessToken:'token',accountSpec:'DEMO',requestControl:f.governor,fetchImpl:wire});
    const first=source==='raw'?createTradovateControlledFetch(f.governor,wire)('https://example.invalid/display'):broker.listPositions(101);
    const caught=first.catch(error=>error);await flush();
    expect(f.governor.health().state).toBe('unavailable');
    await expect(broker.placeOrder(order)).rejects.toBeInstanceOf(BrokerRequestNotSentError);expect(wire).toHaveBeenCalledTimes(1);
    body.resolve({'p-ticket':'short','p-time':15});await caught;
    expect(f.governor.health()).toMatchObject({state:'cooldown',blockedUntil:1_015_000});
    f.advance(15_001);await expect(broker.placeOrder(order)).resolves.toMatchObject({accepted:true});expect(wire).toHaveBeenCalledTimes(2);
  });

  it('a stalled423 body has a bounded3s inspection then a durable conservative fallback',async()=>{
    vi.useFakeTimers();const f=fixture();await f.governor.initialize();const slow=new Response('{}',{status:423,headers:{'Content-Type':'application/json'}});
    Object.defineProperty(slow,'clone',{value:()=>({json:()=>new Promise(()=>{})})});
    const wire=vi.fn(async()=>slow);const first=createTradovateControlledFetch(f.governor,wire)('https://example.invalid/display');await flush();
    expect(f.governor.health().state).toBe('unavailable');f.advance(3001);await vi.advanceTimersByTimeAsync(3001);await first;
    expect(f.governor.health()).toMatchObject({state:'cooldown',blockedUntil:4_603_001});expect(wire).toHaveBeenCalledTimes(1);
  });

  it.each(['timeout','disconnect'] as const)('WS missing ACK after%s counts one physical unknown without a retry',async mode=>{
    vi.useFakeTimers();const f=fixture();await f.governor.initialize();const socket=new Socket();const wire=vi.fn(async()=>response([]));
    const broker=createTradovateBroker({environment:'demo',accessToken:'token',accountSpec:'DEMO',requestControl:f.governor,
      preferWebSocketOrderWrites:true,webSocketWriteTimeoutMs:10,fetchImpl:wire,clock:f.clock,webSocketFactory:()=>socket});
    const unsubscribe=broker.subscribe(()=>undefined);socket.readyState=1;socket.onopen?.();socket.onmessage?.({data:'o'});await flush();
    socket.deliver([{i:0,s:200,d:{}}]);await flush();socket.deliver([{i:1,s:200,d:[]}]);await flush();
    const before=f.governor.health().counts, fetches=wire.mock.calls.length;const write=broker.placeOrder(order).catch(error=>error);await flush();
    if(mode==='timeout')await vi.advanceTimersByTimeAsync(11);else socket.close();
    expect(await write).toBeInstanceOf(Error);expect(f.governor.health().counts.transportUnknown).toBe(before.transportUnknown+1);
    expect(wire).toHaveBeenCalledTimes(fetches);expect(f.governor.health().counts.dispatchAttempts).toBe(before.dispatchAttempts+1);unsubscribe();
  });

  it.each(['raw','adapter'] as const)('%s429 latches from headers before a slow body can permit another write', async source=>{
    const f=fixture();await f.governor.initialize();const body=deferred<unknown>();
    const slow=new Response('{}',{status:429,headers:{'Content-Type':'application/json'}});
    Object.defineProperty(slow,'clone',{value:()=>({json:()=>body.promise})});
    const wire=vi.fn(async()=>slow);const broker=createTradovateBroker({environment:'demo',accessToken:'token',accountSpec:'DEMO',requestControl:f.governor,fetchImpl:wire});
    const first=source==='raw'?createTradovateControlledFetch(f.governor,wire)('https://example.invalid/display'):broker.listPositions(101);
    const caught=first.catch(error=>error);await flush();
    await expect(broker.placeOrder(order)).rejects.toBeInstanceOf(BrokerRequestNotSentError);
    expect(wire).toHaveBeenCalledTimes(1);body.resolve({});await caught;
  });

  it.each(['canceled','replaced'] as const)('sent%s remains unknown in runner when only the later confirmation read is locally blocked',async kind=>{
    const f=fixture();await f.governor.initialize();const socket=new Socket();let writeCount=0;
    const wire=vi.fn(async(input:string|URL|Request)=>{
      const path=String(input);
      if(path.endsWith('/order/placeorder'))return response({orderId:900});
      if(path.endsWith('/order/cancelorder')||path.endsWith('/order/modifyorder')){
        writeCount++;await f.governor.penalize({evidence:'raw-429',retryAfterMs:3_600_000,reason:'another physical request was penalized'});return response({commandId:901});
      }
      return response([]);
    });
    const broker=createTradovateBroker({environment:'demo',accessToken:'token',accountSpec:'DEMO',requestControl:f.governor,fetchImpl:wire,
      webSocketFactory:()=>socket,commandConfirmationTimeoutMs:1,clock:f.clock,requestPurpose:tradovateRequestContext.current,runWithAcceptedRequests:tradovateRequestContext.accepted});
    const unsubscribe=broker.subscribe(()=>undefined);socket.readyState=1;socket.onopen?.();socket.onmessage?.({data:'o'});await flush();
    socket.deliver([{i:0,s:200,d:{}}]);await flush();socket.deliver([{i:1,s:200,d:[]}]);await flush();
    const group={id:'group',name:'Group',enabled:true,leaderAccountId:100,followers:[{accountId:101,mode:'on-submit' as const,multiplier:1}]};
    const event:LeaderEvent={id:'entry',orderId:'leader-entry',accountId:100,symbol:'MNQZ6',kind:'submitted',side:'Buy',quantity:1,orderType:'Limit',limitPrice:25000,sequence:1,receivedAt:f.clock()};
    const context=createRiskGateContext({armed:true,armedAt:f.clock(),now:f.clock(),connected:true,lastHeartbeatAt:f.clock(),shadowMode:false});
    const opened=await processLeaderEvent({event,group,runtime:createRuntime(createCopierState()),context,broker,clock:f.clock});
    const lifecycleBroker={...broker,findOrderById:async()=>({order:{...order,brokerOrderId:'900',status:'working' as const,orderType:'Limit' as const,limitPrice:25000,filledQuantity:0,updatedAt:f.clock()},completeness:'authoritative' as const,observedAt:f.clock()})};
    const changed=await processLeaderEvent({event:{...event,id:'change',kind,sequence:2,limitPrice:25001},group,runtime:opened.runtime,context,broker:lifecycleBroker,clock:f.clock});
    expect(writeCount).toBe(1);expect([...changed.runtime.cancelOutbox.values()]).toEqual([expect.objectContaining({status:'unknown'})]);
    expect([...changed.runtime.cancelOutbox.values()][0].neverSent).not.toBe(true);unsubscribe();
  });

  it.each([undefined,{}])('missing/malformed sync payload%s never claims a complete position baseline',async payload=>{
    const f=fixture();await f.governor.initialize();const socket=new Socket();const broker=createTradovateBroker({environment:'demo',connectionId:'own',accessToken:'token',accountSpecsByAccountId:{101:'DEMO'},requestControl:f.governor,
      fetchImpl:async()=>response([]),clock:f.clock,webSocketFactory:()=>socket});
    const unsubscribe=broker.subscribe(()=>undefined);socket.readyState=1;socket.onopen?.();socket.onmessage?.({data:'o'});await flush();socket.deliver([{i:0,s:200,d:{}}]);await flush();socket.deliver([{i:1,s:200,...(payload===undefined?{}:{d:payload})}]);await flush();
    expect(broker.streamCoverage?.(101)).toBeNull();unsubscribe();
  });

  it('synchronized stream coverage carries exact session and actual data time, then gaps immediately on disconnect', async()=>{
    const f=fixture();await f.governor.initialize();const socket=new Socket();
    const broker=createTradovateBroker({environment:'demo',connectionId:'own-connection',accessToken:'token',accountSpecsByAccountId:{101:'DEMO'},requestControl:f.governor,
      fetchImpl:async()=>response([]),clock:f.clock,webSocketFactory:()=>socket});
    const unsubscribe=broker.subscribe(()=>undefined);
    socket.readyState=1;socket.onopen?.();socket.onmessage?.({data:'o'});await flush();socket.deliver([{i:0,s:200,d:{}}]);await flush();socket.deliver([{i:1,s:200,d:[]}]);await flush();
    expect(broker.streamCoverage?.(101)).toBeNull(); // ACK alone has no authoritative position baseline.
    await Promise.all([broker.listPositions(101),broker.listOrders(101,{fresh:true})]);
    const baseline=broker.streamCoverage?.(101); expect(baseline).toMatchObject({connectionId:'own-connection',synchronized:true,gap:false,backlog:false});
    expect(baseline?.sessionId).toBe(baseline?.currentSessionId);expect(broker.streamPositionSnapshot?.(101)?.positions).toEqual([]);
    expect(broker.streamCoverage?.(999)).toBeNull();f.advance(1000);socket.onmessage?.({data:'h'});await flush();
    expect(broker.streamCoverage?.(101)?.lastDataAt).toBe(baseline?.lastDataAt);
    socket.close();expect(broker.streamCoverage?.(101)?.socketLive).toBe(false);unsubscribe();
  });
  it('a depleted background budget cannot prevent read-only socket recovery or risk refresh',async()=>{
    const f=fixture();await f.governor.initialize();f.budget();f.advance(1);await f.governor.sync();const socket=new Socket();
    const broker=createTradovateBroker({environment:'demo',connectionId:'own',accessToken:'token',accountSpecsByAccountId:{101:'DEMO'},requestControl:f.governor,
      requestPurpose:tradovateRequestContext.current,runWithRecoveryRequests:tradovateRequestContext.recovery,runWithRiskRequests:tradovateRequestContext.risk,
      fetchImpl:async input=>{const path=String(input);return response(path.includes('/currency/list')?[{id:1,name:'USD'}]:
        path.includes('/cashBalance/list')?[{accountId:101,currencyId:1,amount:50000}]:[]);},clock:f.clock,webSocketFactory:()=>socket});
    const unsubscribe=broker.subscribe(()=>undefined);socket.readyState=1;socket.onopen?.();socket.onmessage?.({data:'o'});await flush();
    socket.deliver([{i:0,s:200,d:{}}]);await flush();socket.deliver([{i:1,s:200,d:[]}]);await flush();
    expect(broker.usage().phase).toBe('connected');
    expect(f.remote.reserve.mock.calls.every(([input])=>input.purpose==='control')).toBe(true);
    await broker.listAccountRiskSnapshots([101]);
    expect(f.remote.reserve.mock.calls.some(([input])=>input.purpose==='risk')).toBe(true);unsubscribe();
  });

  it('parallel readback earns coverage after the slower orders complete; late trade ingress revokes it synchronously',async()=>{
    const f=fixture();await f.governor.initialize();const socket=new Socket();let hold=false;const held=deferred<Response>();
    const broker=createTradovateBroker({environment:'demo',connectionId:'own',accessToken:'token',accountSpecsByAccountId:{101:'DEMO'},requestControl:f.governor,
      fetchImpl:async input=>String(input).includes('/order/list')&&hold?held.promise:response([]),clock:f.clock,webSocketFactory:()=>socket});
    const unsubscribe=broker.subscribe(()=>undefined);socket.readyState=1;socket.onopen?.();socket.onmessage?.({data:'o'});await flush();
    socket.deliver([{i:0,s:200,d:{}}]);await flush();socket.deliver([{i:1,s:200,d:[]}]);await flush();
    hold=true;const pair=Promise.all([broker.listPositions(101),broker.listOrders(101,{fresh:true})]);await flush();
    expect(broker.streamCoverage?.(101)).toBeNull();held.resolve(response([]));await pair;
    expect(broker.streamCoverage?.(101)).toMatchObject({synchronized:true,backlog:false,mergeInProgress:false});
    socket.deliver([{e:'props',d:{entityType:'position',eventType:'Updated',entity:{accountId:101,contractId:77,netPos:1}}}]);
    expect(broker.streamCoverage?.(101)).toBeNull();expect(broker.streamPositionSnapshot?.(101)).toBeNull();unsubscribe();
  });

  it.each([null,[{}],[{id:1,accountId:101,contractId:77,ordStatus:'Working'}]])('malformed authoritative orders %j cannot establish empty-account coverage',async rows=>{
    const f=fixture();await f.governor.initialize();const broker=createTradovateBroker({environment:'demo',connectionId:'own',accessToken:'token',accountSpecsByAccountId:{101:'DEMO'},requestControl:f.governor,
      fetchImpl:async input=>response(String(input).includes('/order/list')?rows:[]),clock:f.clock});
    await expect(broker.listOrders(101,{fresh:true})).rejects.toThrow(/authoritative order baseline/);expect(broker.streamCoverage?.(101)).toBeNull();
  });

  it('DEMO 10. 11.: trade ingress drops the proof, but stream continuity since the baseline survives for the chart; new session or unknown account ends it',async()=>{
    const f=fixture();await f.governor.initialize();const socket=new Socket();
    const broker=createTradovateBroker({environment:'demo',connectionId:'own',accessToken:'token',accountSpecsByAccountId:{101:'DEMO'},requestControl:f.governor,
      fetchImpl:async input=>response(String(input).includes('/contract/items')?[{id:77,name:'MNQZ6'}]:[]),clock:f.clock,webSocketFactory:()=>socket});
    const unsubscribe=broker.subscribe(()=>undefined);socket.readyState=1;socket.onopen?.();socket.onmessage?.({data:'o'});await flush();
    socket.deliver([{i:0,s:200,d:{}}]);await flush();socket.deliver([{i:1,s:200,d:[]}]);await flush();
    // Bez REST baseline není ani doklad, ani kontinuita (ACK/heartbeat nic nedokazuje).
    expect(broker.streamContinuity?.(101)).toBeNull();
    await Promise.all([broker.listPositions(101),broker.listOrders(101,{fresh:true})]);
    const baseline=broker.streamCoverage?.(101);expect(baseline).not.toBeNull();
    expect(broker.streamContinuity?.(101)).toMatchObject({baselineAt:baseline?.baselineAt,synchronized:true,gap:false,backlog:false});
    f.advance(500);
    socket.deliver([{e:'props',d:{entityType:'position',eventType:'Updated',entity:{accountId:101,contractId:77,netPos:1}}}]);
    // Doklad (řízení REST čtení) po obchodní události zmizí hned — beze změny.
    expect(broker.streamCoverage?.(101)).toBeNull();
    await flush();
    const continuity=broker.streamContinuity?.(101);
    expect(continuity).toMatchObject({baselineAt:baseline?.baselineAt,sessionId:baseline?.sessionId,backlog:false,synchronized:true});
    expect(continuity!.lastDataAt).toBeGreaterThanOrEqual(continuity!.baselineAt);
    // Událost bez určitelného účtu = nejistota pro všechny účty.
    socket.deliver([{e:'props',d:{entityType:'order',eventType:'Updated',entity:{orderId:999999}}}]);
    expect(broker.streamContinuity?.(101)).toBeNull();
    unsubscribe();
  });

  it('stream continuity never survives a new socket session (deterministic reconnect)',async()=>{
    vi.useFakeTimers();vi.setSystemTime(new Date('2026-11-10T15:00:00.000Z'));const sockets:Socket[]=[];
    const broker=createTradovateBroker({environment:'demo',connectionId:'own',accessToken:'token',accountSpecsByAccountId:{101:'DEMO'},
      fetchImpl:async()=>response([]),reconnectDelayMs:1_000,reconnectJitterRatio:0,closeTimeoutMs:1_000,
      webSocketFactory:()=>{const next=new Socket();sockets.push(next);return next;}});
    const handshake=async(socket:Socket)=>{socket.readyState=1;socket.onopen?.();socket.onmessage?.({data:'o'});await flush();
      socket.deliver([{i:0,s:200,d:{}}]);await flush();socket.deliver([{i:1,s:200,d:[]}]);await flush();};
    const unsubscribe=broker.subscribe(()=>undefined);await handshake(sockets[0]);
    await Promise.all([broker.listPositions(101),broker.listOrders(101,{fresh:true})]);
    const before=broker.streamContinuity?.(101);expect(before).not.toBeNull();
    sockets[0].close();
    expect(broker.streamContinuity?.(101)?.socketLive).toBe(false);
    for(let i=0;i<10&&sockets.length<2;i++){await vi.advanceTimersByTimeAsync(2_000);await flush();}
    expect(sockets.length).toBeGreaterThan(1);
    await handshake(sockets[sockets.length-1]);
    // Nová session bez nové REST baseline: kontinuita z předchozí session neplatí.
    expect(broker.streamContinuity?.(101)).toBeNull();
    // Nová baseline v nové session ji obnoví (s novou session).
    await Promise.all([broker.listPositions(101),broker.listOrders(101,{fresh:true})]);
    expect(broker.streamContinuity?.(101)?.sessionId).not.toBe(before?.sessionId);
    unsubscribe();
  });

  it('a malformed trade frame ends stream continuity for every account',async()=>{
    const f=fixture();await f.governor.initialize();const socket=new Socket();
    const broker=createTradovateBroker({environment:'demo',connectionId:'own',accessToken:'token',accountSpecsByAccountId:{101:'DEMO'},requestControl:f.governor,
      fetchImpl:async()=>response([]),clock:f.clock,webSocketFactory:()=>socket});
    const unsubscribe=broker.subscribe(()=>undefined);socket.readyState=1;socket.onopen?.();socket.onmessage?.({data:'o'});await flush();
    socket.deliver([{i:0,s:200,d:{}}]);await flush();socket.deliver([{i:1,s:200,d:[]}]);await flush();
    await Promise.all([broker.listPositions(101),broker.listOrders(101,{fresh:true})]);
    expect(broker.streamContinuity?.(101)).not.toBeNull();
    socket.deliver([null]);
    expect(broker.streamContinuity?.(101)).toBeNull();
    unsubscribe();
  });

  it('late background completion and a late joiner cannot replace a newer management position proof',async()=>{
    const f=fixture();await f.governor.initialize();const socket=new Socket();let hold=false;const held=deferred<Response>();
    const broker=createTradovateBroker({environment:'demo',connectionId:'own',accessToken:'token',accountSpecsByAccountId:{101:'DEMO'},requestControl:f.governor,
      requestPurpose:tradovateRequestContext.current,clock:f.clock,webSocketFactory:()=>socket,
      fetchImpl:async input=>{const path=String(input);if(path.includes('/position/list')&&hold)return tradovateRequestContext.current()==='management'
        ? response([{accountId:101,contractId:77,netPos:1}]):held.promise;
        return response(path.includes('/contract/items')?[{id:77,name:'MNQZ6'}]:[]);}});
    const unsubscribe=broker.subscribe(()=>undefined);socket.readyState=1;socket.onopen?.();socket.onmessage?.({data:'o'});await flush();
    socket.deliver([{i:0,s:200,d:{}}]);await flush();socket.deliver([{i:1,s:200,d:[]}]);await flush();hold=true;
    const older=broker.listPositions(101);await flush();
    await tradovateRequestContext.accepted(()=>Promise.all([broker.listPositions(101),broker.listOrders(101,{fresh:true})]));
    expect(broker.streamPositionSnapshot?.(101)?.positions).toEqual([{accountId:101,symbol:'MNQZ6',netQuantity:1}]);
    const joiner=broker.listPositions(101);held.resolve(response([]));await Promise.all([older,joiner]);
    expect(broker.streamPositionSnapshot?.(101)?.positions).toEqual([{accountId:101,symbol:'MNQZ6',netQuantity:1}]);unsubscribe();
  });

  it('a recovery read context never turns a broker write into a control-permit dispatch',async()=>{
    const f=fixture();await f.governor.initialize();const broker=createTradovateBroker({environment:'demo',accessToken:'token',accountSpec:'DEMO',requestControl:f.governor,requestPurpose:tradovateRequestContext.current,fetchImpl:async()=>response({orderId:900})});
    await tradovateRequestContext.recovery(()=>broker.placeOrder(order));
    expect(f.remote.reserve).not.toHaveBeenCalled();expect(f.governor.health().counts.dispatchAttempts).toBe(1);
  });

});
