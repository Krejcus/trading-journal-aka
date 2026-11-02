import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { buildJournalLiveView } from '../lib/journalLivePosition';
import { liveChartPosition, type LiveChartPosition } from '../lib/liveChartPosition';
import { devLiveCopyFixtureSnapshot } from '../lib/devLiveCopyFixture';
import { LivePhoneAccountsSheet, LivePhoneGroupPnl } from '../components/day/LivePhoneAccounts';

// P&L skupiny v hlavičce telefonu a list „Účty v obchodě“ (oponentura 2. 11.):
// neznámé se nikdy neukáže jako známé — staré P&L řádku = „—“, neověřené
// příkazy ≠ „bez SL“, rozdělený TP ≠ „bez TP“, bez poplatků ≠ „po poplatcích“.

const now = Date.UTC(2026, 10, 2, 14, 0, 0);
const fresh = new Date(now - 2_000).toISOString();
const old = new Date(now - 30_000).toISOString();
const base = devLiveCopyFixtureSnapshot.accounts[0];
const account = (id: number, entry: number, openPnl: number, pnlAt: string, patch: Record<string, unknown> = {}) => ({
  ...base, id, name: `ACC${id}`,
  unrealizedPnl: openPnl, unrealizedPnlSource: 'broker', unrealizedPnlUpdatedAt: pnlAt,
  positionsAvailability: 'available', ordersAvailability: 'available', positionsUpdatedAt: fresh, ordersUpdatedAt: fresh,
  positions: [{ accountId: id, symbol: 'MNQZ6', netPosition: 2, netPrice: entry, unrealizedPnl: openPnl, realizedPnl: 0, updatedAt: fresh }],
  ...patch,
}) as typeof base;
let nextId = 1;
const order = (accountId: number, patch: Record<string, unknown>) => ({
  id: nextId++, accountId, accountName: '', symbol: 'MNQZ6', action: 'Sell', orderType: 'Stop', quantity: 2,
  price: null, stopPrice: null, status: 'Working', working: true, placedAt: fresh, updatedAt: fresh, ...patch,
}) as never;
const group = { id: 'g', name: 'Skupina', enabled: true, leaderAccountId: 1, followers: [{ accountId: 2, mode: 'on-submit', multiplier: 1, enabled: true }] } as never;
const solo = { id: 'g', name: 'Skupina', enabled: true, leaderAccountId: 1, followers: [] } as never;
const bracket = (id: number) => [order(id, { orderType: 'Stop', stopPrice: 21470 }), order(id, { orderType: 'Limit', price: 21500 })];

const position = (input: Parameters<typeof buildJournalLiveView>[0]) => liveChartPosition(buildJournalLiveView(input), 'group');
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const sheet = (p: LiveChartPosition) => text(renderToStaticMarkup(createElement(LivePhoneAccountsSheet, { position: p, onClose: () => {} })));
const header = (p: LiveChartPosition) => renderToStaticMarkup(createElement(LivePhoneGroupPnl, { position: p, onOpen: () => {} }));

describe('LIVE graf telefonu: P&L skupiny a list účtů', () => {
  it('řádek účtu se starou kotvou P&L ukáže „—“, ne poslední známé číslo (jako souhrn)', () => {
    const p = position({
      accounts: [account(1, 21480, 40, fresh), account(2, 21481, 777.77, old)],
      orders: [...bracket(1), ...bracket(2)], feeRates: new Map(), group, target: 'group', now,
    });
    expect(p.summary?.openPnl).toBeNull();
    expect(p.summary?.rows.find(row => row.accountId === 2)?.openPnl).toBeNull();
    expect(p.summary?.rows.find(row => row.accountId === 1)?.openPnl).not.toBeNull();
    expect(sheet(p)).not.toContain('777.77');
    expect(text(header(p))).toContain('P&amp;L —');
  });

  it('neověřené příkazy účtu = „SL ?“, nikdy „bez SL“', () => {
    const p = position({
      accounts: [account(1, 21480, 40, fresh, { ordersUpdatedAt: new Date(now - 60_000).toISOString() })],
      orders: bracket(1), feeRates: new Map(), group: solo, target: 'group', now,
    });
    expect(p.summary?.rows[0].ordersVerified).toBe(false);
    expect(p.summary?.protection).toBe('SL ?/1 · TP ?/1');
    expect(sheet(p)).toContain('SL ?');
    expect(sheet(p)).not.toMatch(/bez (SL|TP)/);
  });

  it('rozdělený TP s plným krytím = „TP víc cen“, ne „bez TP“; bez poplatků žádné „po poplatcích“', () => {
    const p = position({
      accounts: [account(1, 21480, 40, fresh)],
      orders: [order(1, { orderType: 'Stop', stopPrice: 21470 }), order(1, { orderType: 'Limit', price: 21500, quantity: 1 }), order(1, { orderType: 'Limit', price: 21520, quantity: 1 })],
      feeRates: new Map(), group: solo, target: 'group', now,
    });
    const html = sheet(p);
    expect(html).toContain('TP víc cen');
    expect(html).not.toContain('bez TP');
    expect(html).not.toContain('po poplatcích');
  });

  it('zdvojený SL (krytí 4 při pozici 2) se v řádku označí podílem, ne jako obyčejný SL', () => {
    const p = position({
      accounts: [account(1, 21480, 40, fresh)],
      orders: [order(1, { orderType: 'Stop', stopPrice: 21470 }), order(1, { orderType: 'Stop', stopPrice: 21470 }), order(1, { orderType: 'Limit', price: 21500 })],
      feeRates: new Map(), group: solo, target: 'group', now,
    });
    expect(p.summary?.rows[0].stopCoverage).toBe(4);
    expect(sheet(p)).toMatch(/SL [^T]*\( ?4 ?\/ ?2 ?\)/);
  });

  it('neověřený pohled: hlavička jen slovy (žádné $ ani částky), ověřený flat = nic (název skupiny)', () => {
    const issue: LiveChartPosition = { key: 'issue', symbol: null, lines: [], summary: null, issue: 'Kopie dobíhá…' };
    const html = header(issue);
    expect(text(html)).toContain('Kopie dobíhá…');
    expect(text(html)).not.toMatch(/\$|\d+\.\d\d/);
    expect(header({ key: 'none', symbol: null, lines: [], summary: null, issue: null })).toBe('');
  });

  it('klíč pozice se nemění jen s kotvou P&L (PC graf se nepřekresluje v klidném trhu)', () => {
    const input = (pnlAt: string) => ({ accounts: [account(1, 21480, 40, pnlAt)], orders: bracket(1), feeRates: new Map(), group: solo, target: 'group' as const, now });
    expect(position(input(fresh)).key).toBe(position(input(new Date(now - 1_000).toISOString())).key);
  });
});
