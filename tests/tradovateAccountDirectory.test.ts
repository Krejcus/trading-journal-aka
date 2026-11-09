import { describe, expect, it, vi } from 'vitest';
import { loadTradovateAccountDirectory } from '../server/tradovateAccountDirectory';

describe('worker startup directory is identity-only', () => {
  it('routes with one account/list read and never manufactures risk or balance fields',async()=>{
    const wire=vi.fn(async(_input: string | URL | Request)=>Response.json([{id:101,name:'DEMO',active:true,amount:50000}]));
    const result=await loadTradovateAccountDirectory({baseUrl:'https://broker.test/v1',accessToken:'test',fetchImpl:wire});
    expect(wire).toHaveBeenCalledTimes(1);expect(wire.mock.calls[0][0]).toBe('https://broker.test/v1/account/list');
    expect(result).toEqual({accounts:[{id:101,name:'DEMO',active:true,canTrade:true}]});
  });
  it.each([null,{},[{}],[{id:1,name:'A'},{id:1,name:'B'}],[{id:1,name:''}]])('rejects an incomplete or ambiguous directory %j',async rows=>{
    await expect(loadTradovateAccountDirectory({baseUrl:'https://broker.test/v1',accessToken:'test',fetchImpl:async()=>Response.json(rows)})).rejects.toThrow('incomplete or ambiguous');
  });
  it('propagates a governor refusal without turning it into an empty directory',async()=>{
    const refusal=new Error('request budget');await expect(loadTradovateAccountDirectory({baseUrl:'https://broker.test',accessToken:'test',fetchImpl:async()=>{throw refusal;}})).rejects.toBe(refusal);
  });
  it.each([
    [{active:true},true,true], [{active:true,readonly:true},true,false],
    [{active:false},false,false], [{},false,false], [{readonly:false},false,false],
  ] as const)('preserves startup usability from explicit broker permissions %j',async(flags,active,canTrade)=>{
    const result=await loadTradovateAccountDirectory({baseUrl:'https://broker.test/v1',accessToken:'test',fetchImpl:async()=>Response.json([{id:101,name:'DEMO',...flags}])});
    expect(result.accounts).toEqual([{id:101,name:'DEMO',active,canTrade}]);
    // This is the actual startup routing contract consumed by pilot.loadConnection.
    expect(result.accounts.some(row=>row.id===101&&row.active&&row.canTrade)).toBe(active&&canTrade);
    expect(result.accounts[0]).not.toHaveProperty('balance');expect(result.accounts[0]).not.toHaveProperty('netPositionCount');
  });
  it.each([{active:'true'},{readonly:'false'},{active:null},{readonly:0}])('rejects malformed permission facts %j',async flags=>{
    await expect(loadTradovateAccountDirectory({baseUrl:'https://broker.test/v1',accessToken:'test',fetchImpl:async()=>Response.json([{id:101,name:'DEMO',...flags}])})).rejects.toThrow('incomplete or ambiguous');
  });

});
