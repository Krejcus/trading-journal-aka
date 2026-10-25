import { describe, expect, it, vi } from 'vitest';
import type { Trade } from '../types';
import { applyTradeDelta, syncOwnerTrades, TRADE_SYNC_MAX_BASE_AGE_MS, type TradeSyncChanges, type TradeSyncDeps, type TradeSyncMeta } from '../services/tradeSyncEngine';

const id = (n: number) => `aaaaaaaa-0000-4000-8000-${String(n).padStart(12, '0')}`;
const trade = (n: number, pnl = n, timestamp = n): Trade => ({ id: id(n), pnl, timestamp } as unknown as Trade);
const OWNER = 'owner-1';
const meta = (over: Partial<TradeSyncMeta> = {}): TradeSyncMeta => ({ version: 1, userId: OWNER, epoch: 1, cursor: '100', bootstrappedAt: 1_000, ...over });
const changes = (over: Partial<TradeSyncChanges> = {}): TradeSyncChanges => ({ reset: false, cursor: '120', epoch: 1, tradeIds: [], ...over });

const deps = (over: Partial<TradeSyncDeps> = {}) => {
  const saved: Array<{ meta: TradeSyncMeta; trades?: Trade[] }> = [];
  const d: TradeSyncDeps = {
    ownerId: OWNER,
    stillOwner: async () => true,
    fetchChanges: vi.fn(async () => changes()),
    readFull: vi.fn(async () => [trade(1), trade(2), trade(3)]),
    readByIds: vi.fn(async () => []),
    loadMeta: async () => meta(),
    loadTrades: async () => [trade(3), trade(2), trade(1)],
    save: async (m, t) => { saved.push({ meta: m, trades: t }); },
    now: () => 2_000,
    ...over,
  };
  return { d, saved };
};

describe('applyTradeDelta', () => {
  it('nahradí změněné, přidá nové, odebere smazané/skryté a seřadí od nejnovějšího', () => {
    const next = applyTradeDelta([trade(3), trade(2), trade(1)], [id(2), id(3), id(9)], [trade(2, 50), trade(9, 9, 9)]);
    expect(next.map(t => [t.id, t.pnl])).toEqual([[id(9), 9], [id(2), 50], [id(1), 1]]);
  });
});

describe('syncOwnerTrades', () => {
  it('bez změn vrátí základ a posune jen kurzor (žádný zápis obchodů)', async () => {
    const { d, saved } = deps();
    const result = await syncOwnerTrades(d);
    expect(result.changedIds).toEqual([]);
    expect(result.trades.map(t => t.id)).toEqual([id(3), id(2), id(1)]);
    expect(d.readFull).not.toHaveBeenCalled();
    expect(saved).toEqual([{ meta: meta({ cursor: '120', retryIds: [] }), trades: undefined }]);
  });

  it('se změnami dočte jen změněná ID a uloží nový základ i kurzor', async () => {
    const { d, saved } = deps({
      fetchChanges: vi.fn(async () => changes({ tradeIds: [id(2)] })),
      readByIds: vi.fn(async () => [trade(2, 99)]),
    });
    const result = await syncOwnerTrades(d);
    expect(d.readByIds).toHaveBeenCalledWith([id(2)]);
    expect(result.changedIds).toEqual([id(2)]);
    expect(result.trades.find(t => t.id === id(2))?.pnl).toBe(99);
    expect(saved[0].meta.cursor).toBe('120');
    expect(saved[0].trades).toHaveLength(3);
  });

  it('reset ze serveru = úplné čtení s kurzorem získaným PŘED čtením', async () => {
    const order: string[] = [];
    const { d, saved } = deps({
      fetchChanges: vi.fn(async () => { order.push('cursor'); return changes({ reset: true, cursor: '130', epoch: 2 }); }),
      readFull: vi.fn(async () => { order.push('full'); return [trade(7)]; }),
    });
    const result = await syncOwnerTrades(d);
    expect(order).toEqual(['cursor', 'full']);
    // S předchozím základem appka dostane přesný rozdíl.
    expect([...(result.changedIds ?? [])].sort()).toEqual([id(1), id(2), id(3), id(7)].sort());
    expect(saved[0].meta).toMatchObject({ cursor: '130', epoch: 2, bootstrappedAt: 2_000 });
  });

  it('chybějící/cizí/poškozený základ = úplné čtení; základ starší 24 h jen ohlásí úplné čtení na pozadí', async () => {
    for (const loadMeta of [async () => null, async () => meta({ userId: 'other' }), async () => meta({ cursor: 'x' })]) {
      const { d } = deps({ loadMeta });
      await syncOwnerTrades(d);
      expect(d.readFull).toHaveBeenCalledTimes(1);
    }
    const old = deps({ now: () => 1_000 + TRADE_SYNC_MAX_BASE_AGE_MS + 1 });
    expect((await syncOwnerTrades(old.d)).refreshDue).toBe(true);
    expect(old.d.readFull).not.toHaveBeenCalled();
    const forced = deps();
    expect((await syncOwnerTrades(forced.d, { forceFull: true })).changedIds).toEqual([]);
    expect(forced.d.readFull).toHaveBeenCalledTimes(1);
    const noTrades = deps({ loadTrades: async () => null });
    await syncOwnerTrades(noTrades.d);
    expect(noTrades.d.readFull).toHaveBeenCalledTimes(1);
  });

  it('chyba delty nebo dočtení = úplné čtení; starší DB bez funkce = úplné čtení bez základu', async () => {
    const failingChanges = deps({ fetchChanges: vi.fn().mockRejectedValueOnce(new Error('net')).mockResolvedValue(changes()) });
    await syncOwnerTrades(failingChanges.d);
    expect(failingChanges.d.readFull).toHaveBeenCalledTimes(1);
    const failingRead = deps({ fetchChanges: vi.fn(async () => changes({ tradeIds: [id(2)] })), readByIds: vi.fn().mockRejectedValue(new Error('journal-facts-incomplete')) });
    expect((await syncOwnerTrades(failingRead.d)).changedIds).toEqual([]);
    expect(failingRead.d.readFull).toHaveBeenCalledTimes(1);
    const clear = vi.fn(async () => undefined);
    const oldDb = deps({ fetchChanges: vi.fn(async () => null), clear });
    const result = await syncOwnerTrades(oldDb.d);
    expect(result.changedIds).toEqual([]);
    expect(clear).toHaveBeenCalled();
    expect(oldDb.saved).toEqual([]);
  });

  it('neplatné ID ze serveru nic nedočítá, jde na úplné čtení', async () => {
    const { d } = deps({ fetchChanges: vi.fn(async () => changes({ tradeIds: ['not-a-uuid'] })) });
    await syncOwnerTrades(d);
    expect(d.readByIds).not.toHaveBeenCalled();
    expect(d.readFull).toHaveBeenCalledTimes(1);
  });

  it('změna přihlášení během čtení se neuloží a vyhodí chybu', async () => {
    let owner = true;
    const { d, saved } = deps({
      stillOwner: async () => owner,
      fetchChanges: vi.fn(async () => changes({ tradeIds: [id(2)] })),
      readByIds: vi.fn(async () => { owner = false; return [trade(2, 5)]; }),
    });
    await expect(syncOwnerTrades(d)).rejects.toThrow('trade-list-session-changed');
    expect(saved).toEqual([]);
  });
});

describe('syncOwnerTrades — bez zbytečné práce a s opravami', () => {
  it('hlášené ID beze změny obsahu: nezapisuje obchody a vrátí stejnou referenci', async () => {
    const base = [trade(3), trade(2), trade(1)];
    const { d, saved } = deps({
      loadTrades: async () => base,
      fetchChanges: vi.fn(async () => changes({ tradeIds: [id(2)] })),
      readByIds: vi.fn(async () => [trade(2)]),
    });
    const result = await syncOwnerTrades(d);
    expect(result.trades).toBe(base);
    expect(result.changedIds).toEqual([]);
    expect(saved).toEqual([{ meta: meta({ cursor: '120', retryIds: [] }), trades: undefined }]);
  });

  it('obchod s chybou snímků se uloží k opakování a přidá do další delty', async () => {
    const broken = { ...trade(2, 9), copierSnapshotLoadError: true } as unknown as Trade;
    const first = deps({ fetchChanges: vi.fn(async () => changes({ tradeIds: [id(2)] })), readByIds: vi.fn(async () => [broken]) });
    await syncOwnerTrades(first.d);
    expect(first.saved[0].meta.retryIds).toEqual([id(2)]);
    const second = deps({ loadMeta: async () => meta({ retryIds: [id(2)] }), readByIds: vi.fn(async () => [trade(2, 9)]) });
    await syncOwnerTrades(second.d);
    expect(second.d.readByIds).toHaveBeenCalledWith([id(2)]);
    expect(second.saved[0].meta.retryIds).toEqual([]);
  });

  it('změněná epizoda dočte i obchody, které ji v základu měly (vazba mohla zmizet)', async () => {
    const linked = { ...trade(1), copierEpisodeId: 'ep-1' } as unknown as Trade;
    const { d } = deps({
      loadTrades: async () => [trade(3), trade(2), linked],
      fetchChanges: vi.fn(async () => changes({ episodeIds: ['ep-1'] })),
      readByIds: vi.fn(async () => [trade(1)]),
    });
    const result = await syncOwnerTrades(d);
    expect(d.readByIds).toHaveBeenCalledWith([id(1)]);
    expect(result.changedIds).toEqual([id(1)]);
  });

  it('normalizace celého seznamu (skrytí nahrazeného) se počítá do změn', async () => {
    const { d } = deps({
      fetchChanges: vi.fn(async () => changes({ tradeIds: [id(2)] })),
      readByIds: vi.fn(async () => [trade(2, 50)]),
      normalize: trades => trades.filter(t => t.id !== id(1)),
    });
    const result = await syncOwnerTrades(d);
    expect([...(result.changedIds ?? [])].sort()).toEqual([id(1), id(2)].sort());
    expect(result.trades.map(t => t.id)).toEqual([id(3), id(2)]);
  });
});
