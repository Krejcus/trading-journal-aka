import { afterEach, describe, expect, it } from 'vitest';
import { createMockBroker } from '../services/mockBroker';
import { createBrokerRouter } from '../services/brokerRouter';
import { createExposureCappedBroker } from '../services/exposureCappedBroker';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createTradovateRequestGovernor } from '../services/tradovateRequestControlGovernor';
import { createTradovateControlledFetch } from '../services/tradovateRequestControlFetch';
import { tradovateRequestContext } from '../server/tradovateRequestContext';
import { TradovateRemoteControlError, type TradovateRequestControlSnapshot } from '../lib/tradovateRequestControl';
let runtime: CopierRuntimeController | undefined;
afterEach(()=>runtime?.stop());

describe('automatic flat recovery is a bounded broker read',()=>{
  it('two routes share control capacity through cap/router, while an exhausted total cap still blocks new ARM',async()=>{
    let now=Date.UTC(2026,10,9,15),sequence=0;
    const grants:Array<{at:number;units:number}>=[],wire:Array<{path:string;purpose:string|undefined}>=[];
    const snapshot=():TradovateRequestControlSnapshot=>({version:1,brokerUserId:77,serverNow:now,epoch:0,blockedUntil:null,captchaRequired:false,evidence:null,reason:null,
      policyVersion:2,backgroundReservedHour:1200,backgroundReservedMinute:40,riskReservedHour:0,riskReservedMinute:0,
      controlReservedHour:grants.reduce((n,g)=>n+g.units,0),controlReservedMinute:grants.filter(g=>g.at>now-60000).reduce((n,g)=>n+g.units,0),totalReservedHour:4000+grants.length});
    const governor=createTradovateRequestGovernor({brokerUserId:77,clock:()=>now,monotonic:()=>now,uuid:()=>`recovery-${++sequence}`,store:{load:async()=>null,save:async()=>{}},
      remote:{read:async()=>snapshot(),penalize:async()=>{throw Error('no penalty fixture');},reserve:async input=>{
        if(input.purpose!=='control'||snapshot().controlReservedMinute!+input.units>24)throw new TradovateRemoteControlError('tradovate-request-budget',60000,snapshot());
        grants.push({at:now,units:input.units});return{version:1,grantId:input.grantId,brokerUserId:77,purpose:input.purpose,units:input.units,epoch:0,serverNow:now,validUntil:now+input.ttlMs};
      }}});
    await governor.initialize();await governor.sync();
    const read=async(path:string)=>{const purpose=tradovateRequestContext.current();await createTradovateControlledFetch(governor,async()=>{
      wire.push({path,purpose});return Response.json([]);
    },purpose??'background')('https://mock.invalid/v1'+path);};
    const raw=[11,22].map(()=>createMockBroker({clock:()=>now,accountRiskSnapshots:[]}));
    const routes=raw.map((broker,index)=>{
      const caps=broker.listAccountCapabilities,positions=broker.listPositions,orders=broker.listOrders;
      broker.listAccountCapabilities=async ids=>{await read('/account/list');return caps(ids);};
      broker.listPositions=async id=>{await read('/position/list');return positions(id);};
      broker.listOrders=async id=>{await read('/order/list');return orders(id);};
      broker.runWithRecoveryRequests=tradovateRequestContext.recovery;
      broker.newRiskRequestBlocker=()=>governor.newRiskBlocker();
      return {broker:createExposureCappedBroker(broker,()=>1),accountIds:[index===0?11:22]};
    });
    const broker=createBrokerRouter(routes);
    runtime=await bootstrapCopierRuntime({broker,group:{id:'bounded',name:'bounded',enabled:true,leaderAccountId:11,followers:[{accountId:22,mode:'on-submit',multiplier:1}],localOnly:true},
      store:createMemoryCopierStore(),clock:()=>now,wait:async ms=>{now+=ms;},resolveMissingOptionalAccountIds:async()=>{await read('/account/list');return[];}});
    raw.forEach(b=>b.setConnected(true));await runtime.waitForIdle();
    expect(runtime.status()).toMatchObject({armed:false,connected:true,groupFlat:true,reconciliationRequired:false,lastError:null});
    expect(wire.length).toBeGreaterThan(0);expect(wire.every(r=>r.purpose==='control')).toBe(true);
    expect(grants.length).toBe(wire.length);expect(tradovateRequestContext.current()).toBeUndefined();
    expect(()=>runtime!.arm()).toThrow(/budget/i);
    for(const b of raw){expect(b.placedRequests()).toEqual([]);expect(b.liquidateRequests()).toEqual([]);}
    // Repeated cold reconnects cannot mint capacity beyond the shared24/min.
    for(let n=0;n<4;n++){raw.forEach(b=>b.setConnected(false));raw.forEach(b=>b.setConnected(true));await runtime.waitForIdle();}
    expect(wire.length).toBeLessThanOrEqual(24);expect(grants.length).toBeLessThanOrEqual(24);
    expect(runtime.status().armed).toBe(false);expect(runtime.status().reconciliationRequired).toBe(true);
  });
});
