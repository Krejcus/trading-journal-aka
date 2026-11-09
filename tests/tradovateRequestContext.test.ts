import { describe, expect, it } from 'vitest';
import { tradovateRequestContext as context } from '../server/tradovateRequestContext';
const deferred = () => { let resolve!: () => void; const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve}; };
describe('recovery priority lease lifetime',()=>{
  it('expires deferred descendants after a successful operation',async()=>{
    const held=deferred();let child!:Promise<unknown>;
    await context.recovery(async()=>{expect(context.current()).toBe('control');child=held.promise.then(()=>context.current());});
    held.resolve();expect(await child).toBeUndefined();expect(context.current()).toBeUndefined();
  });
  it('expires deferred descendants after a rejected operation',async()=>{
    const held=deferred();let child!:Promise<unknown>;
    await expect(context.recovery(async()=>{child=held.promise.then(()=>context.current());throw Error('read failed');})).rejects.toThrow('read failed');
    held.resolve();expect(await child).toBeUndefined();
  });
  it('falls back through nested expired leases to the original parent',async()=>{
    const held=deferred();let child!:Promise<unknown>;
    await context.accepted(()=>context.recovery(async()=>{await context.recovery(async()=>{child=held.promise.then(()=>context.current());});expect(context.current()).toBe('control');}));
    held.resolve();expect(await child).toBe('management');expect(context.current()).toBeUndefined();
  });
  it.each(['management','risk'] as const)('preserves an explicit %s lifecycle descendant after its recovery parent closes',async purpose=>{
    const held=deferred();let child!:Promise<unknown>;
    await context.recovery(async()=>{const run=async()=>{await held.promise;return context.current();};child=purpose==='management'?context.accepted(run):context.risk(run);});
    held.resolve();expect(await child).toBe(purpose);
  });
});
