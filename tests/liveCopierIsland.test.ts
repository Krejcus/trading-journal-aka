import { describe, expect, it } from 'vitest';
import { buildLiveCopierIsland, type LiveCopierIslandInput } from '../lib/liveCopierIsland';
import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';

const account = (id: number, patch: Partial<LiveAccount> = {}): LiveAccount => ({
  id,
  entityId: null,
  name: `ACC${id}`,
  firm: 'Lucid',
  phase: null,
  accountSize: 50_000,
  balance: 50_000,
  equity: 50_000,
  realizedPnl: 0,
  weekRealizedPnl: 0,
  unrealizedPnl: 0,
  peakEquity: null,
  drawdownFloor: null,
  cushion: 2_000,
  positions: [],
  updatedAt: null,
  mapRowId: null,
  mappedAccountId: null,
  mappedAccountName: null,
  mappingStatus: null,
  ...patch,
});

const order = (patch: Partial<LiveOrder> = {}): LiveOrder => ({
  id: 1,
  accountId: 1,
  accountName: 'ACC1',
  action: 'Buy',
  orderType: 'Limit',
  quantity: 1,
  price: 29_487,
  stopPrice: null,
  status: 'Working',
  symbol: 'MNQZ6',
  placedAt: null,
  updatedAt: null,
  working: true,
  ...patch,
});

const input = (patch: Partial<LiveCopierIslandInput> = {}): LiveCopierIslandInput => ({
  statusKnown: true,
  armed: false,
  groupName: 'Hlavní',
  accounts: [account(1)],
  configuredAccountCount: 1,
  orders: [],
  leaderAccountId: 1,
  divergentAccounts: [],
  groupDailyPnl: null,
  ...patch,
});

const NOW = 1_770_000_000_000;
const price = (symbol: string, value: number, ageMs = 0) => ({ symbol, price: value, at: NOW - ageMs });

describe('buildLiveCopierIsland', () => {
  it('neznámý stav nevydává za vypnutý', () => {
    const model = buildLiveCopierIsland(input({ statusKnown: false, armed: true }));
    expect(model.phase).toBe('unknown');
    expect(model.title).toContain('neověřen');
    // Dokud stav neznáme, ostrov nesmí nabízet zásah.
    expect(model.action).toBeNull();
  });

  it('divergence přebíjí i otevřenou pozici', () => {
    const model = buildLiveCopierIsland(input({
      armed: true,
      divergentAccounts: [1],
      accounts: [account(1, { positions: [{ accountId: 1, symbol: 'MNQZ6', netPosition: 2, netPrice: 1, realizedPnl: 0, unrealizedPnl: 10, updatedAt: null }] })],
    }));
    expect(model.phase).toBe('divergence');
    expect(model.tone).toBe('danger');
  });

  it('divergentní účet mimo snapshot ukáže aspoň ID', () => {
    const model = buildLiveCopierIsland(input({ divergentAccounts: [98765], accounts: [] }));
    expect(model.fields.some(field => field.value.includes('#98765'))).toBe(true);
  });

  it('otevřená pozice má přednost před čekajícím limitem', () => {
    const model = buildLiveCopierIsland(input({
      armed: true,
      orders: [order()],
      accounts: [account(1, {
        unrealizedPnlSource: 'broker',
        unrealizedPnl: 124.5,
        positions: [{ accountId: 1, symbol: 'MNQZ6', netPosition: 3, netPrice: 1, realizedPnl: 0, unrealizedPnl: 124.5, updatedAt: null }],
      })],
    }));
    expect(model.phase).toBe('position');
    expect(model.title).toContain('MNQZ6');
    expect(model.title).toContain('Long');
    expect(model.action).toBe('flatten');
  });

  it('nepotvrzený otevřený P&L se nezobrazí jako číslo', () => {
    const model = buildLiveCopierIsland(input({
      armed: true,
      accounts: [account(1, {
        unrealizedPnlSource: 'stale',
        unrealizedPnl: 999,
        positions: [{ accountId: 1, symbol: 'MNQZ6', netPosition: 1, netPrice: 1, realizedPnl: 0, unrealizedPnl: 999, updatedAt: null }],
      })],
    }));
    expect(model.phase).toBe('position');
    expect(model.detail?.value).toContain('Čekám na potvrzení');
    expect(model.detail?.value).not.toContain('999');
  });

  it('čekající limit se pozná a nabídne zrušení', () => {
    const model = buildLiveCopierIsland(input({ armed: true, orders: [order()] }));
    expect(model.phase).toBe('limit');
    expect(model.title).toContain('MNQZ6');
    expect(model.action).toBe('cancel');
  });

  it('vyplněný příkaz už limit nehlásí', () => {
    const model = buildLiveCopierIsland(input({ armed: true, orders: [order({ working: false, status: 'Filled' })] }));
    expect(model.phase).toBe('armed');
  });

  it('nepotvrzené denní P&L se do polí nedostane', () => {
    const withoutPnl = buildLiveCopierIsland(input({ groupDailyPnl: null }));
    const withPnl = buildLiveCopierIsland(input({ groupDailyPnl: -16.2 }));
    expect(withoutPnl.fields.some(field => field.label === 'Denní P&L')).toBe(false);
    expect(withPnl.fields.some(field => field.label === 'Denní P&L')).toBe(true);
  });

  it('kill switch nehlásí běžné vypnutí', () => {
    const model = buildLiveCopierIsland(input({ killSwitch: true }));
    expect(model.tone).toBe('danger');
    expect(model.title).toContain('Kill switch');
    expect(model.action).toBeNull();
  });

  it('vzdálenost k fillu se počítá z čerstvé ceny TradingView', () => {
    const model = buildLiveCopierIsland(input({
      armed: true, now: NOW,
      orders: [order({ price: 29_487.75 })],
      marketPrices: [price('MNQZ6', 29_500.25)],
    }));
    expect(model.phase).toBe('limit');
    // 29 500,25 − 29 487,75 = 12,5 bodu
    expect(model.extra?.value).toContain('12,5');
    expect(model.fields.some(f => f.label === 'Do fillu' && f.value.includes('12,5'))).toBe(true);
  });

  it('zastaralá cena se pro vzdálenost nepoužije', () => {
    const model = buildLiveCopierIsland(input({
      armed: true, now: NOW,
      orders: [order({ price: 29_487.75 })],
      marketPrices: [price('MNQZ6', 29_500.25, 60_000)],
    }));
    expect(model.fields.some(f => f.label === 'Do fillu')).toBe(false);
    expect(model.extra?.value ?? '').not.toContain('12,5');
  });

  it('přesný kontrakt má přednost před kontinuálním', () => {
    const model = buildLiveCopierIsland(input({
      armed: true, now: NOW,
      orders: [order({ price: 29_000 })],
      marketPrices: [price('MNQ1!', 29_050), price('MNQZ6', 29_010)],
    }));
    expect(model.fields.find(f => f.label === 'Do fillu')?.value).toContain('10');
  });

  it('SL a TP u pozice jsou přepočtené na dolary', () => {
    const model = buildLiveCopierIsland(input({
      armed: true, now: NOW,
      accounts: [account(1, {
        unrealizedPnlSource: 'broker',
        positions: [{ accountId: 1, symbol: 'MNQZ6', netPosition: 3, netPrice: 29_500, realizedPnl: 0, unrealizedPnl: 0, updatedAt: null }],
      })],
      orders: [
        order({ id: 2, action: 'Sell', orderType: 'Stop', price: null, stopPrice: 29_480 }),
        order({ id: 3, action: 'Sell', orderType: 'Limit', price: 29_560 }),
      ],
    }));
    expect(model.phase).toBe('position');
    // MNQ = 2 USD/bod · 20 bodů · 3 kontrakty = 120 USD
    expect(model.fields.find(f => f.label === 'SL')?.value).toContain('120');
    // 60 bodů · 2 · 3 = 360 USD
    expect(model.fields.find(f => f.label === 'TP')?.value).toContain('360');
  });

  it('ochranné nohy se berou jen z opačné strany než pozice', () => {
    const model = buildLiveCopierIsland(input({
      armed: true, now: NOW,
      accounts: [account(1, {
        unrealizedPnlSource: 'broker',
        positions: [{ accountId: 1, symbol: 'MNQZ6', netPosition: 1, netPrice: 29_500, realizedPnl: 0, unrealizedPnl: 0, updatedAt: null }],
      })],
      // Buy stop u long pozice není ochranná noha, je to další vstup.
      orders: [order({ id: 4, action: 'Buy', orderType: 'Stop', price: null, stopPrice: 29_400 })],
    }));
    expect(model.fields.some(f => f.label === 'SL')).toBe(false);
  });

  it('vypnutá skupina nenabízí žádný zásah do trhu', () => {
    const model = buildLiveCopierIsland(input());
    expect(model.phase).toBe('off');
    expect(model.action).toBeNull();
  });
});
