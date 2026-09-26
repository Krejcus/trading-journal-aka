import { describe, expect, it } from 'vitest';
import { eventsDoneAt, historyAt, initialRiskPoints, protectionValueAt, tradeFillGroups, tradeTimelineEvents } from '../lib/tradeReplay';
import { journalProtectionSegments } from '../lib/journalProtectionSegments';
import type { TradeExecutionHistory } from '../lib/tradeExecutionHistory';

// Skutečný ranní short z 23. 9. 2026 (účet 66142381): vstup 13 MNQ, SL trailovaný
// kopírkou 12×, stop 1 + 1 + 11 lotů ve dvou milisekundách.
const t = (hms: string, ms = 0) => Date.parse(`2026-09-23T${hms}Z`) + ms;
const fill = (id: string, at: number, side: 'Buy' | 'Sell', quantity: number, price: number, role: 'entry' | 'exit') =>
  ({ id, orderId: id, accountId: 1, contractId: 4470324, at, timeSource: 'broker' as const, side, quantity, price, fees: quantity * 0.5,
    feeCurrencyId: 1, role, allocatedQuantity: quantity });
let n = 0;
const prot = (at: number, kind: 'sl' | 'tp', price: number, status: 'confirmed' | 'pending', operation: 'new' | 'modify') =>
  ({ id: `p${++n}`, orderId: kind === 'sl' ? '072' : '070', commandId: null, accountId: 1, at, timeSource: 'broker' as const,
    kind, price, quantity: 13, status, operation });

const SL_MOVES: Array<[string, number]> = [['07:35:04', 31062], ['08:00:40', 31049.75], ['08:01:53', 31049.75], ['08:02:21', 31055.5], ['08:02:48', 31043],
  ['08:03:04', 31043], ['08:03:19', 31042], ['08:03:44', 31037.75], ['08:04:29', 31034.25], ['08:05:33', 31033.25], ['08:06:05', 31029.5],
  ['08:06:10', 31028.75], ['08:06:30', 31033.75], ['08:06:41', 31033.25], ['08:07:01', 31036.25]];

const history: TradeExecutionHistory = {
  connectionId: 'c', environment: 'demo', accountId: 1,
  fills: [
    fill('e1', t('07:35:04', 503), 'Sell', 13, 31043.5, 'entry'),
    fill('x1', t('08:07:05', 598), 'Buy', 1, 31036.25, 'exit'),
    fill('x2', t('08:07:05', 667), 'Buy', 1, 31036.25, 'exit'),
    fill('x3', t('08:07:05', 667), 'Buy', 11, 31036.5, 'exit'),
  ],
  protection: [
    prot(t('07:34:53'), 'tp', 30989.5, 'pending', 'new'),
    prot(t('07:34:53'), 'sl', 31062, 'pending', 'new'),
    prot(t('07:35:04', 520), 'tp', 30989.5, 'confirmed', 'modify'),
    prot(t('07:38:13'), 'tp', 30983.25, 'confirmed', 'modify'),
    ...SL_MOVES.map(([hms, price], index) => prot(t(hms, index === 0 ? 520 : 0), 'sl', price, 'confirmed', 'modify')),
  ],
  gaps: [], grossPnl: 183, fees: 13, netPnl: 170, complete: true, issues: [],
  position: { id: 'pos', status: 'closed', openedAt: t('07:35:04', 503), closedAt: t('08:07:05', 667), openQuantity: 0, peakQuantity: 13, observedThrough: t('08:07:05', 667) },
};

// cs-CZ odděluje tisíce nezlomitelnou mezerou — pro porovnání ji sjednotíme.
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ');

describe('průběh obchodu', () => {
  const events = tradeTimelineEvents(history).map(event => ({ ...event, title: plain(event.title), detail: plain(event.detail) }));

  it('sloučí dílčí plnění výstupu do jedné události a pozná stop', () => {
    const exit = events.find(event => event.kind === 'exit')!;
    expect(exit.title).toBe('Výstup · stop');
    expect(exit.detail).toContain('Buy 13');
    expect(exit.detail).toContain('3 plnění');
    expect(events.filter(event => event.kind === 'exit' || event.kind === 'partial')).toHaveLength(1);
  });

  it('příkaz, vstup s rizikem a posun TP jsou samostatné události', () => {
    expect(events[0]).toMatchObject({ kind: 'order', title: 'Příkaz odeslán' });
    expect(events[0].detail).toContain('SL 31 062,00');
    const entry = events.find(event => event.kind === 'entry')!;
    expect(entry.title).toBe('Vstup · Sell 13');
    expect(entry.detail).toContain('riziko 18,50 b.');
    expect(events.find(event => event.kind === 'tp')!.detail).toBe('30 989,50 → 30 983,25');
  });

  it('hlášení bez změny ceny nejsou posun — SL se posunul 12×, ne 14×', () => {
    const sl = events.filter(event => event.kind === 'sl');
    expect(sl).toHaveLength(12);
    expect(new Set(sl.map(event => event.seriesKey)).size).toBe(1);
    expect(sl[0].title).toBe('SL 31 049,75');
    expect(sl.at(-1)!.title).toBe('SL 31 036,25');
  });

  it('potvrzení SL přímo při vstupu se nepočítá jako posun', () => {
    expect(events.some(event => event.kind === 'sl' && event.price === 31062)).toBe(false);
  });

  it('dva posuny za sebou ještě nejsou série', () => {
    const short = { ...history, protection: history.protection.filter(event => event.kind !== 'sl' || event.at <= t('08:02:21')) };
    const sl = tradeTimelineEvents(short).filter(event => event.kind === 'sl');
    expect(sl).toHaveLength(2);
    expect(sl.every(event => event.seriesKey === undefined && event.title === 'SL posunut')).toBe(true);
  });

  it('šipky: výstup 1 + 1 + 11 lotů je jedna šipka Buy 13 s průměrnou cenou', () => {
    const groups = tradeFillGroups(history);
    expect(groups.map(group => [group.role, group.side, group.quantity])).toEqual([['entry', 'Sell', 13], ['exit', 'Buy', 13]]);
    expect(groups[1].price).toBeCloseTo((31036.25 * 2 + 31036.5 * 11) / 13, 6);
  });

  it('počáteční riziko je vzdálenost vstupu od SL platného při vstupu', () => {
    expect(initialRiskPoints(history)).toBe(18.5);
    expect(initialRiskPoints({ ...history, protection: [] })).toBeNull();
  });
});

describe('stav obchodu v čase (přehrávání)', () => {
  it('v 10:03:19 je pozice otevřená a čáry SL/TP končí právě tam', () => {
    const at = t('08:03:19');
    const state = historyAt(history, at);
    expect(state.fills.map(fill => fill.id)).toEqual(['e1']);
    expect(state.position).toMatchObject({ status: 'open', closedAt: null, observedThrough: at });
    expect(state.netPnl).toBeNull();
    const segments = journalProtectionSegments(state);
    expect(Math.max(...segments.map(segment => segment.to))).toBe(at);
    expect(segments.filter(segment => segment.kind === 'sl').at(-1)!.price).toBe(31042);
  });

  it('po výstupu vrací celou historii', () => {
    const state = historyAt(history, t('08:10:00'));
    expect(state.fills).toHaveLength(4);
    expect(state.position?.status).toBe('closed');
    expect(state.netPnl).toBe(170);
  });

  it('starší historie bez pozice dostane konec čar v okamžiku přehrávání', () => {
    const legacy = { ...history, position: undefined };
    const at = t('08:00:00');
    expect(historyAt(legacy, at).position).toMatchObject({ status: 'open', observedThrough: at });
    expect(historyAt(legacy, t('08:10:00')).position).toBeUndefined();
  });

  it('počítadlo událostí na tlačítku Průběh', () => {
    const events = tradeTimelineEvents(history);
    expect(eventsDoneAt(events, null)).toBe(events.length);
    expect(eventsDoneAt(events, t('07:36:00'))).toBe(2);
  });
});

describe('hodnota SL/TP v místě kurzoru', () => {
  it('short 13 MNQ: původní SL = riziko, trailovaný SL pod vstupem = zamčený zisk', () => {
    const risk = protectionValueAt(history, 31062, t('07:40:00'), 2)!;
    expect(risk.quantity).toBe(13);
    expect(risk.points).toBeCloseTo(-18.5);
    expect(risk.usd).toBeCloseTo(-481);
    const locked = protectionValueAt(history, 31036.25, t('08:07:02'), 2)!;
    expect(locked.points).toBeCloseTo(7.25);
    expect(locked.usd).toBeCloseTo(188.5);
  });
  it('TP pro otevřenou velikost; po částečném výstupu už jen zbytek', () => {
    expect(protectionValueAt(history, 30983.25, t('07:40:00'), 2)!.usd).toBeCloseTo(60.25 * 2 * 13);
    const partial = protectionValueAt(history, 30983.25, t('08:07:05', 600), 2)!;
    expect(partial.quantity).toBe(12);
    expect(partial.averageEntry).toBeCloseTo(31043.5);
  });
  it('před vstupem plán prvního příkazu, po uzavření nic', () => {
    const planned = protectionValueAt(history, 31062, t('07:34:58'), 2)!;
    expect(planned).toMatchObject({ planned: true, quantity: 13 });
    expect(protectionValueAt(history, 31062, t('08:10:00'), 2)).toBeNull();
  });
  it('přikoupení mění průměr pozice (NQ 20 $/bod)', () => {
    const longHistory = { ...history, fills: [
      fill('a', t('10:00:00'), 'Buy', 1, 100, 'entry'), fill('b', t('10:01:00'), 'Buy', 1, 110, 'entry'), fill('c', t('10:05:00'), 'Sell', 2, 120, 'exit'),
    ] };
    const value = protectionValueAt(longHistory, 95, t('10:02:00'), 20)!;
    expect(value.averageEntry).toBe(105);
    expect(value.usd).toBe(-10 * 20 * 2);
  });
});
