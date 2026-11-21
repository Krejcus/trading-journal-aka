import { describe, expect, it } from 'vitest';
import { liveBarAccountDay, liveBarGroupDay, liveBarGroupOf, liveBarOpenPnl, liveLimitLinePrices, rithmicAccountBarData, type LiveAccountBarData } from '../components/LiveAccountBar';

const data: LiveAccountBarData = {
  tradedAccountId: 'L',
  accounts: [
    { id: 'L', name: 'Leader', firm: 'X', realizedToday: -100 },
    { id: 'A', name: 'A', firm: 'X', realizedToday: 50 },
    { id: 'B', name: 'B', firm: 'X', realizedToday: -20 },
    { id: 'C', name: 'C', firm: 'X', realizedToday: 10 },
    { id: 'S', name: 'Solo', firm: 'Y', realizedToday: 5 },
  ],
  groups: [{ id: 'g', name: 'G', leaderId: 'L', state: 'ARMED', followers: [
    { accountId: 'A', ratio: 1, copying: true },
    { accountId: 'B', ratio: 0.5, copying: true },
    { accountId: 'C', ratio: 1, copying: false },
  ] }],
};

describe('LiveAccountBar P&L', () => {
  it('otevřený P&L má obchodovaný účet a kopírující followeři v poměru', () => {
    expect(liveBarOpenPnl(data, 'L', 40)).toBe(40);
    expect(liveBarOpenPnl(data, 'A', 40)).toBe(40);
    expect(liveBarOpenPnl(data, 'B', 40)).toBe(20);
    expect(liveBarOpenPnl(data, 'C', 40)).toBe(0); // vypnutý follower nekopíruje
    expect(liveBarOpenPnl(data, 'S', 40)).toBe(0); // mimo skupinu
  });

  it('bez pozice je otevřený P&L nula', () => {
    expect(liveBarOpenPnl(data, 'A', null)).toBe(0);
  });

  it('P&L dne účtu = realizovaný + otevřený', () => {
    expect(liveBarAccountDay(data, 'L', 40)).toBe(-60);
    expect(liveBarAccountDay(data, 'B', 40)).toBe(0);
  });

  it('P&L skupiny sčítá leadera i všechny followery', () => {
    // L -60, A 90, B 0, C 10
    expect(liveBarGroupDay(data, data.groups[0], 40)).toBe(40);
  });

  it('skupina, kterou obchodovaný účet nevede, nebo není ARMED, nedostává otevřený P&L', () => {
    const disarmed: LiveAccountBarData = { ...data, groups: [{ ...data.groups[0], state: 'DISARMED' }] };
    expect(liveBarOpenPnl(disarmed, 'A', 40)).toBe(0);
  });

  it('najde skupinu účtu jako leadera i followera', () => {
    expect(liveBarGroupOf(data, 'L')?.id).toBe('g');
    expect(liveBarGroupOf(data, 'C')?.id).toBe('g');
    expect(liveBarGroupOf(data, 'S')).toBeNull();
  });

  it('čáry DLL a MLL: cena, kde by pozice narazila na limit; po přikoupení blíž', () => {
    const base = { side: 'long' as const, averagePrice: 25000, pointValue: 2, tickSize: 0.25, realizedToday: -120, dailyLossLimit: 1000, maxLossLeft: 1840 };
    // 1 MNQ: DLL 880 USD = 440 b pod vstupem, MLL 1 840 USD = 920 b.
    expect(liveLimitLinePrices({ ...base, quantity: 1 })).toEqual({ dll: { price: 24560, amount: 880 }, mll: { price: 24080, amount: 1840 } });
    // 2 MNQ: stejné peníze, poloviční vzdálenost.
    expect(liveLimitLinePrices({ ...base, quantity: 2 })).toEqual({ dll: { price: 24780, amount: 880 }, mll: { price: 24540, amount: 1840 } });
    // Short: nad vstupem.
    expect(liveLimitLinePrices({ ...base, side: 'short', quantity: 2 }).dll?.price).toBe(25220);
    // DLL nikdy dál než MLL.
    expect(liveLimitLinePrices({ ...base, quantity: 1, maxLossLeft: 500 }).dll).toEqual({ price: 24750, amount: 500 });
    // Zaokrouhlení na tick směrem ke vstupu (long nahoru): 3 MNQ → 880/6 = 146,67 b.
    expect(liveLimitLinePrices({ ...base, quantity: 3 }).dll?.price).toBe(24853.5);
    // Bez limitů nic.
    expect(liveLimitLinePrices({ side: 'long', quantity: 1, averagePrice: 25000, pointValue: 2, tickSize: 0.25, realizedToday: 0 })).toEqual({ dll: null, mll: null });
  });
});

describe('skutečný účet Rithmicu v liště', () => {
  it('jeden účet bez skupin, realizovaný P&L ze služby', () => {
    expect(rithmicAccountBarData({ accountName: 'LT-123', system: 'LucidTrading', closedPnl: -240.5 })).toEqual({
      tradedAccountId: 'LT-123', groups: [], accounts: [{ id: 'LT-123', name: 'LT-123', firm: 'LucidTrading', realizedToday: -240.5 }],
    });
  });

  it('bez názvu účtu lišta není; starší služba bez P&L dá „—“, ne nulu', () => {
    expect(rithmicAccountBarData({ accountName: undefined, system: 'X', closedPnl: 1 })).toBeNull();
    const bar = rithmicAccountBarData({ accountName: 'A', system: null, closedPnl: undefined })!;
    expect(bar.accounts[0]).toMatchObject({ firm: 'Rithmic', realizedToday: null });
    expect(liveBarAccountDay(bar, 'A', 50)).toBeNull();
  });

  it('bez realizovaného výsledku se DLL nekreslí, MLL ano', () => {
    const out = liveLimitLinePrices({ side: 'long', quantity: 1, averagePrice: 25000, pointValue: 2, tickSize: 0.25, realizedToday: null, dailyLossLimit: 1000, maxLossLeft: 1000 });
    expect(out.dll).toBeNull();
    expect(out.mll?.price).toBe(24500);
  });
});
