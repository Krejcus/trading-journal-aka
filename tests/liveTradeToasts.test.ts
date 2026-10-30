import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { copyEventToast, newCopyEvents, TRADE_TOAST_MS } from '../lib/liveTradeToasts';
import type { CopierCopyEvent } from '../services/copierRuntimeController';

const event = (patch: Partial<CopierCopyEvent>): CopierCopyEvent => ({
  id: 'e1', at: 1_000, kind: 'entry', symbol: 'MNQZ6', side: 'Short', quantity: 1, followers: 3, ...patch,
});

describe('LIVE graf: notifikace obchodů (karta B)', () => {
  it('mizí po 2 s', () => expect(TRADE_TOAST_MS).toBe(2_000));

  it('události kopírky → karta: typ, čísla, P&L, tečky leader + kopie', () => {
    expect(copyEventToast(event({ kind: 'order-placed', price: 28975.5, stopPrice: 28984.25, targetPrice: 28958 })))
      .toMatchObject({ badge: 'Zadáno', line: 'SELL 1 @ 28975.50 · SL 28984.25 · TP 28958.00', accounts: 4, sticky: false });
    expect(copyEventToast(event({ kind: 'entry' }))).toMatchObject({ badge: 'Vyplněno', line: 'SHORT 1 MNQZ6' });
    expect(copyEventToast(event({ kind: 'sl-moved', price: 28975.5, levelPnlUsd: 0 }))).toMatchObject({ badge: 'BE', title: 'SL na break-even', pnl: null });
    expect(copyEventToast(event({ kind: 'sl-moved', price: 28980, levelPnlUsd: -9 }))).toMatchObject({ badge: 'SL', pnl: -9 });
    expect(copyEventToast(event({ kind: 'exit', exitReason: 'tp', pnlUsd: 35 }))).toMatchObject({ title: 'TP zasažen', pnl: 35, tone: 'green' });
    expect(copyEventToast(event({ kind: 'exit', exitReason: 'sl', pnlUsd: -20.5 }))).toMatchObject({ title: 'SL zasažen', tone: 'red' });
    expect(copyEventToast(event({ kind: 'follower-cut', accountId: 70423188 }))).toMatchObject({ sticky: true, accounts: 0 });
  });

  it('žádná událost se neukáže dvakrát (staré z prvního načtení komponenta jen zapamatuje)', () => {
    const events = [event({ id: 'old', at: 500 }), event({ id: 'new', at: 2_000 })];
    expect(newCopyEvents(events, new Set(['old'])).map(item => item.id)).toEqual(['new']);
    expect(newCopyEvents(events, new Set(['old', 'new']))).toEqual([]);
  });

  it('tečky nikdy netvrdí „zkopírováno“: za vypnuté kopírky jen leader šedě', () => {
    const toasts = readFileSync('components/LiveTradeToasts.tsx', 'utf8');
    expect(toasts).toMatch(/copierArmed \? toast\.accounts : 1/);
    expect(toasts).toMatch(/Kopírka je vypnutá — followeři se nekopírují/);
  });
});
