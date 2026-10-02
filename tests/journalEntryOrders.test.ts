import { describe, expect, it } from 'vitest';
import { entryOrdersAt, episodeEntryOrders, journalUntakenOrders, type EntryOrderEpisode } from '../lib/journalEntryOrders';
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
const contract: [string, JournalEvidence] = ['contract:9', { entityType: 'contract', entity: { id: 9, name: 'MNQZ6' } } as unknown as JournalEvidence];
const at = (iso: string) => ({ timestamp: `2026-10-01T${iso}Z` });

describe('episodeEntryOrders', () => {
  it('keeps only the order that opened the trade, with its price moves', () => {
    const protection = new Map<string, JournalProtectionEvent[]>([
      ['300', [event('300', '07:43:43', 'tp', 30845), event('300', '07:43:50', 'tp', 30842.75, { operation: 'modify' })]],
      ['100', [event('100', '07:37:49', 'tp', 30900), cancel('100', '07:42:30', 'tp')]],
    ]);
    const latest = new Map([order('300', 'Sell'), order('100', 'Sell')]);
    const episode: EntryOrderEpisode = { accountId: 1, contractId: 9, entryFillAtByOrder: new Map([['300', T('07:44:26')]]), protectiveOrderIds: new Set() };
    const orders = episodeEntryOrders(episode, protection, latest, new Map());
    expect(orders.map(o => o.orderId)).toEqual(['300']);
    expect(orders[0]).toMatchObject({ side: 'Sell', type: 'Limit', end: { kind: 'fill', at: T('07:44:26') } });
    expect(orders[0].legs.map(leg => leg.price)).toEqual([30845, 30842.75]);
  });
});

describe('journalUntakenOrders', () => {
  const protection = new Map<string, JournalProtectionEvent[]>([
    // zrušený Sell Limit s ručním OSO bez propojení (děti čekají = pending)
    ['700', [event('700', '07:37:49', 'tp', 30900), event('700', '07:39:00', 'tp', 30898, { operation: 'modify' }), cancel('700', '07:47:32', 'tp')]],
    ['702', [event('702', '07:37:49', 'tp', 30761.25, { status: 'pending' })]],
    ['704', [event('704', '07:37:49', 'sl', 30926, { status: 'pending' })]],
    // zrušený limit bez SL i TP — ignoruje se
    ['710', [event('710', '07:20:00', 'tp', 30950), cancel('710', '07:25:00', 'tp')]],
    // kopie kopírky u followera — patří leaderovi
    ['720', [event('720', '07:37:50', 'tp', 30900), cancel('720', '07:47:33', 'tp')]],
    ['721', [event('721', '07:37:50', 'sl', 30926, { status: 'pending' })]],
    // zadaný při otevřené pozici (přikoupení) — není nevzatý obchod
    ['730', [event('730', '07:46:00', 'tp', 30870), cancel('730', '07:47:00', 'tp')]],
    ['731', [event('731', '07:46:00', 'sl', 30890, { status: 'pending' })]],
    // příkaz obchodu
    ['740', [event('740', '07:43:43', 'tp', 30842.75)]],
    // nezrušený (stále čeká / vyplněn jinde) — není nevzatý
    ['750', [event('750', '07:30:00', 'tp', 30910)]],
  ]);
  const latest = new Map<string, JournalEvidence>([
    contract,
    order('700', 'Sell', at('07:37:49.871')), order('702', 'Buy', at('07:37:49.877')), order('704', 'Buy', at('07:37:49.877')),
    order('710', 'Sell', at('07:20:00.000')),
    order('720', 'Sell', { ...at('07:37:50.100'), accountId: 2 }), order('721', 'Buy', { ...at('07:37:50.105'), accountId: 2 }),
    order('730', 'Sell', at('07:46:00.000')), order('731', 'Buy', at('07:46:00.004')),
    order('740', 'Sell', at('07:43:43.784')), order('750', 'Sell', at('07:30:00.000')),
  ]);
  const input = {
    protectionByOrder: protection, latest, childrenByParent: new Map(),
    usedOrderIds: new Set(['740']), copiedOrderKeys: new Set(['2:720', '2:721']),
    positionWindows: [{ accountId: 1, contractId: 9, from: T('07:44:26'), to: T('07:53:55') }],
  };

  it('turns a cancelled entry with a bracket into its own untaken trade', () => {
    const untaken = journalUntakenOrders(input);
    expect(untaken.map(o => o.orderId)).toEqual(['700']);
    expect(untaken[0]).toMatchObject({
      side: 'Sell', type: 'Limit', quantity: 5, accountId: 1, contractId: 9, symbol: 'MNQZ6',
      end: { kind: 'cancel', at: T('07:47:32') }, bracket: { sl: 30926, tp: 30761.25 },
    });
    expect(untaken[0].legs.map(leg => leg.price)).toEqual([30900, 30898]);
  });
});

describe('entryOrdersAt', () => {
  it('trims orders to the replay cursor', () => {
    const orders = journalUntakenOrdersFixture();
    const trimmed = entryOrdersAt(orders, T('07:38:30'))!;
    expect(trimmed).toHaveLength(1);
    expect(trimmed[0].legs).toHaveLength(1);
    expect(trimmed[0].end).toBeNull();
    expect(entryOrdersAt(orders, T('07:30:00'))).toEqual([]);
    expect(entryOrdersAt(undefined, 0)).toBeUndefined();
  });
});

function journalUntakenOrdersFixture() {
  return [{ orderId: '700', side: 'Sell' as const, type: 'Limit' as const, quantity: 5, placedAt: T('07:37:49'),
    legs: [{ at: T('07:37:49'), price: 30900 }, { at: T('07:39:00'), price: 30898 }], end: { kind: 'cancel' as const, at: T('07:47:32') } }];
}
