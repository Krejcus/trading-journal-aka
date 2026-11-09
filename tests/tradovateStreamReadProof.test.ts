import { describe, expect, it } from 'vitest';
import { createTradovateStreamReadProof } from '../services/tradovateStreamReadProof';

describe('account continuity requires a complete fenced read, not cache agreement', () => {
  function fixture() {
    let now = 1000, session = 'socket-1';
    const proof = createTradovateStreamReadProof<number[]>(() => session, () => now);
    const pair = (id = 1) => { proof.accept(id, proof.capture(id), 'positions', [7]); proof.accept(id, proof.capture(id), 'orders'); };
    return { proof, pair, advance: (ms: number) => { now += ms; }, reconnect: () => { session = 'socket-2'; } };
  }
  it('never creates a proof from just one complete list', () => {
    const f = fixture(); expect(f.proof.get(1)).toBeNull(); f.proof.accept(1,f.proof.capture(1),'positions',[]);
    expect(f.proof.get(1)).toBeNull(); f.proof.accept(1,f.proof.capture(1),'orders'); expect(f.proof.get(1)?.positions).toEqual([]);
  });
  it('keeps original timestamps and refreshes both parts on a new read pair', () => {
    const f = fixture(); f.pair(); f.advance(10_000); expect(f.proof.get(1)?.at).toBe(1000);
    f.proof.accept(1,f.proof.capture(1),'positions',[8]); expect(f.proof.get(1)?.at).toBe(1000);
    f.proof.accept(1,f.proof.capture(1),'orders'); expect(f.proof.get(1)).toEqual({at:11000,positions:[8]});
  });
  it('rejects a trade arriving during REST and a late event arriving after REST', () => {
    const f = fixture(), old = f.proof.capture(1); f.proof.invalidate(1);
    f.proof.accept(1,old,'positions',[]); f.proof.accept(1,old,'orders'); expect(f.proof.get(1)).toBeNull();
    f.pair(); expect(f.proof.get(1)).not.toBeNull(); f.proof.invalidate(1); expect(f.proof.get(1)).toBeNull();
    f.proof.accept(1,old,'positions',[]); f.proof.accept(1,old,'orders'); expect(f.proof.get(1)).toBeNull();
  });
  it('unknown scope invalidates all accounts, account-scoped events retain other completed proofs', () => {
    const f = fixture(); f.pair(1); f.pair(2); const inFlight = f.proof.capture(3);
    f.proof.invalidate(2); expect(f.proof.get(1)).not.toBeNull(); expect(f.proof.get(2)).toBeNull();
    f.proof.accept(3,inFlight,'positions',[]); f.proof.accept(3,inFlight,'orders'); expect(f.proof.get(3)).toBeNull();
    f.proof.invalidate(); expect(f.proof.get(1)).toBeNull();
  });
  it('a new socket cannot inherit a previous socket baseline or its pending reads', () => {
    const f = fixture(); f.pair(); const old=f.proof.capture(1); f.reconnect(); expect(f.proof.get(1)).toBeNull();
    f.proof.accept(1,old,'positions',[]); f.proof.accept(1,old,'orders'); expect(f.proof.get(1)).toBeNull();
  });
  it('older completions in the same millisecond cannot replace a newer position/order proof',()=>{
    const f=fixture(),older=f.proof.capture(1),newer=f.proof.capture(1);
    f.proof.accept(1,newer,'positions',[9]);f.proof.accept(1,newer,'orders');
    f.proof.accept(1,older,'positions',[]);f.proof.accept(1,older,'orders');expect(f.proof.get(1)?.positions).toEqual([9]);
  });
  it('joining an older physical flight cannot give it a newer observation order',()=>{
    const f=fixture(),physicalA=f.proof.captureRead(),physicalB=f.proof.captureRead();
    f.proof.accept(1,f.proof.capture(1,physicalB),'positions',[9]);f.proof.accept(1,f.proof.capture(1,physicalB),'orders');
    const lateJoiner=f.proof.capture(1,physicalA);f.proof.accept(1,lateJoiner,'positions',[]);
    expect(f.proof.get(1)?.positions).toEqual([9]);
  });

});
