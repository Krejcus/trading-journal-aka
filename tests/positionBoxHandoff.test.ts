import { describe, expect, it, vi } from 'vitest';
import { installWorkspaceDrawingSync } from '../services/chartDrawingSync';
import type { Drawing, DrawingEngine } from '@getcandlekit/charts';
import { positionBoxAcknowledgement, withPositionBoxAcknowledgement } from '../services/positionBoxHandoff';
import type { PositionDrawing } from '../services/chartPositionDrawing';

const drawing = (): PositionDrawing => ({
  id: 'manual-position', tool: 'LongPosition',
  points: [{ time: 120, price: 100 }, { time: 600, price: 110 }, { time: 600, price: 95 }],
  style: { color: '#787b86', width: 1, dashed: false, fill: null },
});
const engine = (current: PositionDrawing | undefined) => {
  const remove = vi.fn();
  return { api: { getById: () => current, remove } as unknown as DrawingEngine, remove };
};

describe('position box handoff after broker acknowledgement', () => {
  it.each(['rejected', 'unknown', 'blocked', 'abandoned'])('keeps the source for %s', async status => {
    const source = vi.fn();
    expect(await withPositionBoxAcknowledgement(async () => ({ status, id: 'same' }), source)).toEqual({ status, id: 'same' });
    expect(source).not.toHaveBeenCalled();
  });
  it('waits for ACK, preserving the original result and operation payload', async () => {
    let resolve!: (result: { status: string; orderId: string }) => void;
    const send = new Promise<{ status: string; orderId: string }>(done => { resolve = done; });
    const source = vi.fn();
    const waiting = withPositionBoxAcknowledgement(() => send, source);
    expect(source).not.toHaveBeenCalled();
    const result = { status: 'acknowledged', orderId: 'accepted' };
    resolve(result);
    expect(await waiting).toBe(result);
    expect(source).toHaveBeenCalledOnce();
  });
  it('does not consume a source when sending throws', async () => {
    const source = vi.fn();
    await expect(withPositionBoxAcknowledgement(async () => { throw Error('offline'); }, source)).rejects.toThrow('offline');
    expect(source).not.toHaveBeenCalled();
  });
  it('does not turn an accepted order into a failure when the chart was closed', async () => {
    expect(await withPositionBoxAcknowledgement(async () => ({ status: 'acknowledged' }), () => { throw Error('disposed'); })).toEqual({ status: 'acknowledged' });
  });
  it('removes only the exact unchanged manual drawing', () => {
    const source = drawing(); const same = engine(structuredClone(source));
    positionBoxAcknowledgement(same.api, source)();
    expect(same.remove).toHaveBeenCalledWith(source.id);
    const changed = structuredClone(source); const next = engine(changed);
    const acknowledge = positionBoxAcknowledgement(next.api, source);
    changed.points[0].price = 101;
    acknowledge();
    expect(next.remove).not.toHaveBeenCalled();
  });
  it('removes all linked copies synchronously so remount cannot resurrect a duplicate', () => {
    const source = drawing(); const first = engine(structuredClone(source)); const second = engine(structuredClone(source));
    positionBoxAcknowledgement(first.api, source, () => [first.api, second.api])();
    expect(first.remove).toHaveBeenCalledOnce();
    expect(second.remove).toHaveBeenCalledWith(source.id);
  });
  it('does not resurrect the consumed source when linked panes remount before deferred sync flushes', () => {
    const makePane = () => {
      let drawings: Drawing[] = [drawing()]; const listeners = new Set<() => void>();
      const emit = () => listeners.forEach(listener => listener());
      return {getDrawings:()=>drawings,getById:(id:string)=>drawings.find(d=>d.id===id),
        remove:(id:string)=>{drawings=drawings.filter(d=>d.id!==id);emit();},
        import:(json:string)=>{drawings=JSON.parse(json);emit();},
        onChange:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener);};}};
    };
    const first=makePane(), second=makePane();
    const stop=installWorkspaceDrawingSync([first,second],()=>()=>{});
    positionBoxAcknowledgement(first as unknown as DrawingEngine,drawing(),()=>[second as unknown as DrawingEngine])();
    stop();
    const remounted=installWorkspaceDrawingSync([first,second]);
    expect(first.getDrawings()).toEqual([]); expect(second.getDrawings()).toEqual([]);
    remounted();
  });
  it('preserves all copies if a user edited the source in another linked pane while awaiting ACK', () => {
    const source = drawing(); const first = engine(structuredClone(source)); const changed = structuredClone(source); changed.points[1].price += 1;
    const second = engine(changed);
    positionBoxAcknowledgement(first.api, source, () => [second.api])();
    expect(first.remove).not.toHaveBeenCalled(); expect(second.remove).not.toHaveBeenCalled();
  });
  it('preserves generated and already removed drawings', () => {
    const auto = { ...drawing(), id: 'auto-managed-position-order' };
    const generated = engine(auto); positionBoxAcknowledgement(generated.api, auto)();
    expect(generated.remove).not.toHaveBeenCalled();
    const gone = engine(undefined); positionBoxAcknowledgement(gone.api, drawing())();
    expect(gone.remove).not.toHaveBeenCalled();
  });
});
