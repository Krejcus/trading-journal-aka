import { describe, expect, it, vi } from 'vitest';
import { loadTradovateAccountDirectory } from '../server/tradovateAccountDirectory';

describe('worker startup directory is identity-only', () => {
  it('routes with one account/list read and never manufactures risk or balance fields',async()=>{
    const wire=vi.fn(async(_input: string | URL | Request)=>Response.json([{id:101,name:'DEMO',amount:50000}]));
    const result=await loadTradovateAccountDirectory({baseUrl:'https://broker.test/v1',accessToken:'test',fetchImpl:wire});
    expect(wire).toHaveBeenCalledTimes(1);expect(wire.mock.calls[0][0]).toBe('https://broker.test/v1/account/list');
    expect(result).toEqual({accounts:[{id:101,name:'DEMO'}]});
  });
  it.each([null,{},[{}],[{id:1,name:'A'},{id:1,name:'B'}],[{id:1,name:''}]])('rejects an incomplete or ambiguous directory %j',async rows=>{
    await expect(loadTradovateAccountDirectory({baseUrl:'https://broker.test/v1',accessToken:'test',fetchImpl:async()=>Response.json(rows)})).rejects.toThrow('incomplete or ambiguous');
  });
  it('propagates a governor refusal without turning it into an empty directory',async()=>{
    const refusal=new Error('request budget');await expect(loadTradovateAccountDirectory({baseUrl:'https://broker.test',accessToken:'test',fetchImpl:async()=>{throw refusal;}})).rejects.toBe(refusal);
  });
});
