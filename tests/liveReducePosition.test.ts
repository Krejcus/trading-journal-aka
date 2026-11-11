// 11. 11. 2026: částečné zavření — protokol příkazu a texty výsledku tlačítka.
import { describe, expect, it } from 'vitest';
import { buildLeaderOrderManageCommand, validateLeaderOrderManage } from '../lib/leaderOrderManage';
import { liveReduceResultText, REDUCE_CONFIRM_MIN_MS } from '../components/LiveReducePositionButton';
import { supportsCopierPositionReduce } from '../lib/copierWorkerCapabilities';

const command = (fields: Record<string, unknown> = {}) => buildLeaderOrderManageCommand({
  groupId: 'g1', operationId: 'manage:reduce0001', leaderAccountId: 61038658, entryOperationId: 'entry:base0001', symbol: 'MNQZ6',
  action: 'reduce-position', expect: { price: 27_900, quantity: 2 }, scope: 'position', reduceQuantity: 1, ...fields,
} as never);

describe('částečné zavření: protokol', () => {
  it('platný příkaz projde; bez rozsahu pozice, bez množství nebo na celou pozici neprojde', () => {
    expect(() => validateLeaderOrderManage(command())).not.toThrow();
    expect(() => validateLeaderOrderManage(command({ scope: undefined }))).toThrow();
    expect(() => validateLeaderOrderManage(command({ reduceQuantity: undefined }))).toThrow();
    expect(() => validateLeaderOrderManage(command({ reduceQuantity: 2 }))).toThrow();
    expect(() => validateLeaderOrderManage(command({ reduceQuantity: 0 }))).toThrow();
  });
  it('jiné akce pole reduceQuantity nést nesmí', () => {
    expect(() => validateLeaderOrderManage(command({ action: 'close-position' }))).toThrow();
  });
  it('tlačítko se nabízí jen s capability workeru', () => {
    expect(supportsCopierPositionReduce({ capabilities: ['manual-position-reduce-v1'] })).toBe(true);
    expect(supportsCopierPositionReduce({ capabilities: ['manual-entry-scale-in-v1'] })).toBe(false);
    expect(supportsCopierPositionReduce(null)).toBe(false);
  });
});

describe('částečné zavření: texty výsledku', () => {
  it('potvrzeno, zablokováno a nejistý výsledek mají odlišný tón', () => {
    expect(liveReduceResultText({ status: 'acknowledged', blockers: [], reason: 'lístek 1 ks zavřen' })).toEqual({ tone: 'ok', text: 'lístek 1 ks zavřen' });
    expect(liveReduceResultText({ status: 'blocked', blockers: [{ code: 'x', text: 'Nic se neodeslalo.' }] })).toMatchObject({ tone: 'warn' });
    expect(liveReduceResultText({ status: 'unknown', blockers: [] })).toMatchObject({ tone: 'error' });
    expect(REDUCE_CONFIRM_MIN_MS).toBeGreaterThanOrEqual(350);
  });
});
