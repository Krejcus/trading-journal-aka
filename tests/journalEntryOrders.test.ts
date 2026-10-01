import { describe, expect, it } from 'vitest';
import { entryOrdersAt, episodeEntryOrders, type EntryOrderEpisode } from '../lib/journalEntryOrders';
import type { JournalEvidence, JournalProtectionEvent } from '../lib/tradovateJournalEvidence';

const T = (hhmmss: string) => Date.parse(`2026-10-01T${hhmmss}Z`);
const event = (orderId: string, at: string, kind: 'sl' | 'tp', price: number | null, extra: Partial<JournalProtectionEvent> = {}): JournalProtectionEvent => ({
  id: `${orderId}:${at}:${extra.status ?? 'confirmed'}`, orderId, commandId: null, accountId: 1, at: T(at), timeSource: 'broker',
  kind, price, quantity: 5, status: 'confirmed', operation: 'new', ...extra,
});
const cancel = (orderId: string, at: string, kind: 'sl' | 'tp') => event(orderId, at, kind, null, { status: 'cancelled', operation: 'cancel' });
const order = (id: string, action: 'Buy' | 'Sell', extra: Record<string, unknown> = {}): [string, JournalEvidence] => [`order:${id}`, {
  id: `ev-${id}`, connectionId: 'c', environment: 'demo', sessionId: 's', sequence: 1, receivedAt: 0, source: 'stream', eventType: 'Updated',
  entityType: 'order', entity: { id: Number(id), accountId: 1, contractId: 9, action, ...extra },
} as unknown as JournalEvidence];

const episode = (over: Partial<EntryOrderEpisode> = {}): EntryOrderEpisode => ({
  accountId: 1, contractId: 9, entryAt: T('07:44:26'), through: T('07:53:55'), previousExitAt: T('07:30:00'),
  entryFillAtByOrder: new Map([['300', T('07:44:26')]]), protectiveOrderIds: new Set(['301', '302']), ...over,
});

describe('episodeEntryOrders', () => {
  const protection = new Map<string, JournalProtectionEvent[]>([
    // zrušený Sell Limit (moved once) s bracketem 101/102
    ['100', [event('100', '07:37:49', 'tp', 30900), event('100', '07:39:00', 'tp', 30898, { operation: 'modify' }), cancel('100', '07:42:30', 'tp')]],
    ['101', [event('101', '07:37:49', 'sl', 30926)]],
    ['102', [event('102', '07:37:49', 'tp', 30761.25)]],
    // zrušený Sell Stop
    ['200', [event('200', '07:41:30', 'sl', 30810), cancel('200', '07:43:05', 'sl')]],
    // vyplněný vstupní limit s posunem
    ['300', [event('300', '07:43:43', 'tp', 30845), event('300', '07:43:50', 'tp', 30842.75, { operation: 'modify' })]],
    // ochrana pozice (SL/TP) — nejsou vstupy
    ['301', [event('301', '07:44:26', 'sl', 30861)]],
    ['302', [event('302', '07:44:26', 'tp', 30704)]],
    // příkaz z doby před předchozím výstupem patří předchozímu obchodu
    ['400', [event('400', '07:20:00', 'tp', 30950), cancel('400', '07:25:00', 'tp')]],
    // jiný kontrakt
    ['500', [event('500', '07:40:00', 'tp', 30900), cancel('500', '07:41:00', 'tp')]],
    // zadaný až po vstupu (přikoupení/jiný obchod) a zrušený — není pokus o tento vstup
    ['600', [event('600', '07:46:00', 'tp', 30870), cancel('600', '07:47:00', 'tp')]],
  ]);
  const latest = new Map<string, JournalEvidence>([
    order('100', 'Sell'), order('101', 'Buy', { parentId: 100 }), order('102', 'Buy', { parentId: 100 }),
    order('200', 'Sell'), order('300', 'Sell'), order('301', 'Buy', { parentId: 300 }), order('302', 'Buy', { parentId: 300 }),
    order('400', 'Sell'), order('500', 'Sell', { contractId: 8 }), order('600', 'Sell'),
  ]);
  const children = new Map([['1:100', ['101', '102']], ['1:300', ['301', '302']]]);

  it('collects the filled entry order and the cancelled attempts before it', () => {
    const orders = episodeEntryOrders(episode(), protection, latest, children);
    expect(orders.map(o => o.orderId)).toEqual(['100', '200', '300']);
    const [limit, stop, filled] = orders;
    expect(limit).toMatchObject({ side: 'Sell', type: 'Limit', quantity: 5, end: { kind: 'cancel', at: T('07:42:30') }, bracket: { sl: 30926, tp: 30761.25 } });
    expect(limit.legs.map(leg => leg.price)).toEqual([30900, 30898]);
    expect(stop).toMatchObject({ type: 'Stop', end: { kind: 'cancel' } });
    expect(stop.bracket).toBeUndefined();
    expect(filled).toMatchObject({ end: { kind: 'fill', at: T('07:44:26') } });
    expect(filled.legs.map(leg => leg.price)).toEqual([30845, 30842.75]);
  });

  it('respects the lookback when there is no previous trade', () => {
    const orders = episodeEntryOrders(episode({ previousExitAt: null }), protection, latest, children);
    expect(orders.map(o => o.orderId)).toEqual(['400', '100', '200', '300']);
  });

  it('trims orders to the replay cursor', () => {
    const orders = episodeEntryOrders(episode(), protection, latest, children);
    const at = entryOrdersAt(orders, T('07:38:30'))!;
    expect(at.map(o => o.orderId)).toEqual(['100']);
    expect(at[0].legs).toHaveLength(1);
    expect(at[0].end).toBeNull();
    expect(entryOrdersAt(undefined, 0)).toBeUndefined();
  });

  it('pairs an unlinked manual OSO bracket by creation time and keeps pending bracket prices', () => {
    const at = (iso: string) => ({ timestamp: `2026-10-01T${iso}Z` });
    const prot = new Map<string, JournalProtectionEvent[]>([
      ['700', [event('700', '07:37:49', 'tp', 30900), cancel('700', '07:47:32', 'tp')]],
      ['702', [event('702', '07:37:49', 'tp', 30761.25, { status: 'pending' })]],
      ['704', [event('704', '07:37:49', 'sl', 30926, { status: 'pending' })]],
      // jiný příkaz opačné strany o 5 s později — není bracket
      ['706', [event('706', '07:37:54', 'sl', 30999, { status: 'pending' })]],
    ]);
    const lat = new Map<string, JournalEvidence>([
      order('700', 'Sell', at('07:37:49.871')), order('702', 'Buy', at('07:37:49.877')),
      order('704', 'Buy', at('07:37:49.877')), order('706', 'Buy', at('07:37:54.000')),
    ]);
    const [limit] = episodeEntryOrders(episode({ entryFillAtByOrder: new Map(), protectiveOrderIds: new Set() }), prot, lat, new Map());
    expect(limit).toMatchObject({ orderId: '700', bracket: { sl: 30926, tp: 30761.25 } });
  });
});
