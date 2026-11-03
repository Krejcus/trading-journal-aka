// C7 (3. 11. 2026, docs/reviews/trading-gaps-designs/safety.md): „Zrušit vše“ = zrušit VLASTNÍ čekající
// vstupy, nikdy ochranu pozice ani cizí příkaz. Čisté helpery (výběr, výsledek stavem, dvoukrok,
// sekvenční odeslání) + skutečný controller v sólo skupině (manual-only local-only DEMO).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrokerAccountRiskSnapshot, BrokerOrder } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { manualOnlyDemoSafety, type CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker, type MockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';
import { validateLeaderOrderManage, type LeaderOrderManageCommand, type LeaderOrderManageResult } from '../lib/leaderOrderManage';
import {
  buildCancelPendingCommand,
  cancelEntryVerdict,
  cancelOwnPendingEntries,
  cancelPendingAvailability,
  cancelPendingConfirmKey,
  cancelPendingConfirmStep,
  cancelPendingConfirmText,
  cancelEntryOutcome,
  cancelPendingSummary,
  classifyCancelPendingResult,
  dashboardCancelTarget,
  legsProtectFill,
  legsProtectionProblem,
  selectOwnPendingEntries,
  type PendingEntryRecordView,
  type PendingOrderView,
  type PendingOwnEntry,
} from '../lib/liveCancelPending';
import { COPIER_MANUAL_ORDER_CANCEL_PENDING_CAPABILITY, supportsCopierManualOrderCancelPending } from '../lib/copierWorkerCapabilities';

const LEADER = 61038658;
const SYM = 'MNQZ6';

describe('C7 — výběr vlastních čekajících vstupů (čistě)', () => {
  const record = (id: string, overrides: Partial<PendingEntryRecordView> = {}): PendingEntryRecordView => ({
    operationId: `entry:${id}`, status: 'acknowledged', createdAt: 10, tag: `me${id}`,
    entryBrokerOrderId: `${id}E`, stopBrokerOrderId: `${id}S`, targetBrokerOrderId: `${id}T`,
    request: { accountId: LEADER, symbol: SYM, side: 'Buy', quantity: 2, orderType: 'Limit' }, ...overrides,
  });
  const order = (id: string, overrides: Partial<PendingOrderView> = {}): PendingOrderView => ({
    brokerOrderId: id, accountId: LEADER, symbol: SYM, side: 'Buy', orderType: 'Limit', status: 'working',
    quantity: 2, filledQuantity: 0, limitPrice: 24_980, ...overrides,
  });
  /** Čekající OSO: vstup working s fillem 0, nohy pozastavené (pending) s parentem. */
  const pendingOso = (id: string) => [
    order(`${id}E`),
    order(`${id}S`, { side: 'Sell', orderType: 'Stop', status: 'pending', stopPrice: 24_970, limitPrice: undefined, parentOrderId: `${id}E` }),
    order(`${id}T`, { side: 'Sell', orderType: 'Limit', status: 'pending', limitPrice: 25_010, parentOrderId: `${id}E` }),
  ];
  /** Vyplněný vstup otevřené pozice: nohy pracují (ochrana). */
  const filledPosition = (id: string) => [
    order(`${id}S`, { side: 'Sell', orderType: 'Stop', stopPrice: 24_970, limitPrice: undefined, parentOrderId: `${id}E` }),
    order(`${id}T`, { side: 'Sell', orderType: 'Limit', limitPrice: 25_010, parentOrderId: `${id}E` }),
  ];
  const ids = (entries: readonly PendingOwnEntry[]) => entries.map(entry => entry.entryBrokerOrderId);

  it('vybere vlastní přijatý Limit/Stop s fillem 0; cena a počet z příkazu u brokera („co jsem viděl“)', () => {
    const view = selectOwnPendingEntries({
      leaderAccountId: LEADER,
      records: [record('a'), record('b', { createdAt: 20, scaleIn: true, request: { accountId: LEADER, symbol: SYM, side: 'Sell', quantity: 1, orderType: 'Stop' } })],
      openOrders: [...pendingOso('a'), order('bE', { side: 'Sell', orderType: 'Stop', quantity: 1, stopPrice: 25_020, limitPrice: undefined })],
    });
    expect(view.entries).toEqual([
      { entryOperationId: 'entry:a', entryBrokerOrderId: 'aE', symbol: SYM, side: 'Buy', quantity: 2, orderType: 'Limit', price: 24_980, scaleIn: false, createdAt: 10 },
      { entryOperationId: 'entry:b', entryBrokerOrderId: 'bE', symbol: SYM, side: 'Sell', quantity: 1, orderType: 'Stop', price: 25_020, scaleIn: true, createdAt: 20 },
    ]);
    // Pozastavené nohy čekajícího vstupu odejdou s parentem — nejsou ochrana pozice.
    expect(view.context).toMatchObject({ foreignOrders: 0, protectiveLegs: 0, partialEntries: 0, otherOwnOrders: 0 });
  });

  it('NIKDY nevybere nohu pozice: ochranné nohy jen spočítá, ani záznam s id nohy jako vstupem ji nevybere', () => {
    const view = selectOwnPendingEntries({
      leaderAccountId: LEADER,
      records: [
        record('a'),
        record('p', { createdAt: 5 }),
        // Poškozený / podvržený záznam: „vstup“ = id SL nohy jiného obchodu.
        record('x', { entryBrokerOrderId: 'pS', stopBrokerOrderId: 'xS', targetBrokerOrderId: 'xT' }),
        // Noha s parentem, i kdyby ji záznam vydával za vstup.
        record('y', { entryBrokerOrderId: 'yLeg', stopBrokerOrderId: 'yS', targetBrokerOrderId: 'yT' }),
        // Noha BEZ `parentId` (skutečný záznam z DEMO: TP přikoupení) — pozná se jen podle id vlastní nohy.
        record('q', { createdAt: 6 }),
        record('z', { entryBrokerOrderId: 'qT', stopBrokerOrderId: 'zS', targetBrokerOrderId: 'zT' }),
      ],
      openOrders: [...pendingOso('a'), ...filledPosition('p'), order('yLeg', { parentOrderId: 'other' }),
        order('qS', { side: 'Sell', orderType: 'Stop', stopPrice: 24_970, limitPrice: undefined, parentOrderId: 'qE' }),
        order('qT', { side: 'Buy', orderType: 'Limit', limitPrice: 25_010 })],
    });
    expect(ids(view.entries)).toEqual(['aE']);
    expect(ids(view.entries)).not.toContain('pS');
    expect(ids(view.entries)).not.toContain('pT');
    expect(ids(view.entries)).not.toContain('yLeg');
    expect(ids(view.entries)).not.toContain('qT');
    expect(view.context.protectiveLegs).toBe(4);
  });

  it('cizí příkaz (bez stopy appky) nikdy nevybere — jen ho spočítá pro text; vlastní tag cizí není', () => {
    const view = selectOwnPendingEntries({
      leaderAccountId: LEADER,
      records: [record('a'), record('u', { status: 'unknown', entryBrokerOrderId: undefined, stopBrokerOrderId: undefined, targetBrokerOrderId: undefined, lateEntryBrokerOrderId: undefined })],
      openOrders: [...pendingOso('a'), order('F1', { tag: 'tv-123' }), order('F2', { side: 'Sell', orderType: 'Stop', stopPrice: 24_900, limitPrice: undefined }),
        order('uLegLike', { tag: 'meus' })],
    });
    expect(ids(view.entries)).toEqual(['aE']);
    expect(view.context).toMatchObject({ foreignOrders: 2, otherOwnOrders: 1 });
  });

  it('částečně vyplněný vstup se nevybere (INV-TRAD-02); Market, holý, nepřijatý, změněný mimo appku ani rušený taky ne', () => {
    const base = { leaderAccountId: LEADER, openOrders: [] as PendingOrderView[] };
    expect(selectOwnPendingEntries({ ...base, records: [record('a')], openOrders: [order('aE', { filledQuantity: 1 })] }))
      .toMatchObject({ entries: [], context: { partialEntries: 1 } });
    expect(selectOwnPendingEntries({ ...base, records: [record('a', { request: { ...record('a').request, orderType: 'Market' } })], openOrders: [order('aE', { orderType: 'Market' })] }).entries).toEqual([]);
    expect(selectOwnPendingEntries({ ...base, records: [record('a', { bare: true })], openOrders: [order('aE')] }).entries).toEqual([]);
    for (const status of ['sending', 'unknown', 'abandoned', 'rejected', 'waived']) {
      expect(selectOwnPendingEntries({ ...base, records: [record('a', { status })], openOrders: [order('aE')] }).entries).toEqual([]);
    }
    // Bez obou nohou by worker odmítl `not-own-entry` — nenabízet.
    expect(selectOwnPendingEntries({ ...base, records: [record('a', { targetBrokerOrderId: undefined })], openOrders: [order('aE')] }).entries).toEqual([]);
    // Změna typu / strany / symbolu mimo appku.
    expect(selectOwnPendingEntries({ ...base, records: [record('a')], openOrders: [order('aE', { orderType: 'Stop', stopPrice: 24_990 })] }))
      .toMatchObject({ entries: [], context: { otherOwnOrders: 1 } });
    expect(selectOwnPendingEntries({ ...base, records: [record('a')], openOrders: [order('aE', { side: 'Sell' })] }).entries).toEqual([]);
    expect(selectOwnPendingEntries({ ...base, records: [record('a')], openOrders: [order('aE', { symbol: 'MNQH7' })] }).entries).toEqual([]);
    // Běží zrušení workerem / nevyřešená změna.
    expect(selectOwnPendingEntries({ ...base, records: [record('a', { cancelStatus: 'sending' })], openOrders: [order('aE')] }).entries).toEqual([]);
    expect(selectOwnPendingEntries({ ...base, records: [record('a')], openOrders: [order('aE')], excluded: id => id === 'entry:a' }).entries).toEqual([]);
    // Zrušení „odeslané“, ale vstup dál pracuje: uživatel smí znovu (nový příkaz, čerstvé čtení — ne slepé opakování).
    expect(ids(selectOwnPendingEntries({ ...base, records: [record('a', { cancelStatus: 'sent' })], openOrders: [order('aE')] }).entries)).toEqual(['aE']);
  });

  it('jen leader: jiný účet, leader null a ukončený příkaz se ignorují', () => {
    expect(selectOwnPendingEntries({ leaderAccountId: LEADER, records: [record('a')], openOrders: [order('aE', { accountId: 1 })] }).entries).toEqual([]);
    expect(selectOwnPendingEntries({ leaderAccountId: null, records: [record('a')], openOrders: [order('aE')] }).entries).toEqual([]);
    expect(selectOwnPendingEntries({ leaderAccountId: LEADER, records: [record('a', { request: { ...record('a').request, accountId: 1 } })], openOrders: [order('aE')] }).entries).toEqual([]);
    expect(selectOwnPendingEntries({ leaderAccountId: LEADER, records: [record('a')], openOrders: [order('aE', { status: 'canceled' })] }).entries).toEqual([]);
  });
});

describe('C7 — výsledek zrušení jen stavem u brokera (čistě)', () => {
  it('úspěch jen canceled s fillem 0; jakýkoli fill = rejected s kódem, nikdy „zrušeno“', () => {
    expect(cancelEntryVerdict({ status: 'canceled', quantity: 2, filledQuantity: 0 })).toMatchObject({ status: 'acknowledged', code: 'canceled' });
    expect(cancelEntryVerdict({ status: 'canceled', quantity: 2, filledQuantity: 1 })).toMatchObject({ status: 'rejected', code: 'entry-partially-filled', filled: 1 });
    expect(cancelEntryVerdict({ status: 'filled', quantity: 2, filledQuantity: 2 })).toMatchObject({ status: 'rejected', code: 'entry-filled', filled: 2 });
    // Order(Filled) bez všech fillů (INV-TRAD-02) — pořád vyplněný, ne zrušený.
    expect(cancelEntryVerdict({ status: 'filled', quantity: 2, filledQuantity: 1 })).toMatchObject({ status: 'rejected', code: 'entry-filled' });
    expect(cancelEntryVerdict({ status: 'rejected', quantity: 2, filledQuantity: 0 })).toMatchObject({ status: 'waived', code: 'entry-ended' });
    expect(cancelEntryVerdict({ status: 'working', quantity: 2, filledQuantity: 0 })).toBeNull();
    expect(cancelEntryVerdict({ status: 'pending', quantity: 2, filledQuantity: 0 })).toBeNull();
    expect(cancelEntryVerdict(null)).toBeNull();
  });

  it('ochrana po vyplnění: obě nohy working a kryjí PŘESNĚ fill (opačná strana, stejný symbol); jinak nepotvrzená', () => {
    const leg = (status: string, quantity = 2, filledQuantity = 0) => ({ status, quantity, filledQuantity });
    expect(legsProtectFill([leg('working'), leg('working')], 2)).toBe(true);
    expect(legsProtectFill([leg('working', 1), leg('working', 1)], 1)).toBe(true);
    expect(legsProtectFill([leg('working', 1), leg('working')], 2)).toBe(false);
    // Oponentura diffu (P2): přerostlé nohy (TP 2 nad pozicí 1) nejsou ochrana — TP by pozici otočil.
    expect(legsProtectFill([leg('working'), leg('working')], 1)).toBe(false);
    expect(legsProtectFill([leg('working', 2, 1), leg('working', 2, 1)], 1)).toBe(true);
    expect(legsProtectionProblem([leg('working'), leg('working')], 1)).toBe('nohy nesedí s pozicí (qty 2/2 vs fill 1)');
    const entry = { side: 'Buy', symbol: SYM };
    const sell = (overrides: Record<string, unknown> = {}) => ({ ...leg('working', 1), side: 'Sell', symbol: SYM, ...overrides });
    expect(legsProtectFill([sell(), sell()], 1, entry)).toBe(true);
    expect(legsProtectFill([sell(), sell({ side: 'Buy' })], 1, entry)).toBe(false);
    expect(legsProtectFill([sell(), sell({ symbol: 'MNQH7' })], 1, entry)).toBe(false);
    expect(legsProtectFill([leg('canceled'), leg('working')], 1)).toBe(false);
    expect(legsProtectFill([leg('pending'), leg('working')], 1)).toBe(false);
    expect(legsProtectFill([null, leg('working')], 1)).toBe(false);
    expect(legsProtectFill([leg('working')], 1)).toBe(false);
    expect(legsProtectFill([], 1)).toBe(false);
  });
});

describe('C7 — výsledek zrušení i po odmítnutí / bez účinku (čistě, oponentura diffu P2/P3)', () => {
  const order = (status: string, filledQuantity = 0, quantity = 2) => ({ status, quantity, filledQuantity });
  it('odmítnuté zrušení se rozhodne stavem: fill = rejected s kódem; zrušený jinak = waived „ne tímto“; čekající = rejected „dál čeká“', () => {
    const rejection = 'cancelOrder rejected: TooLateToCancel';
    expect(cancelEntryOutcome(order('filled', 2), { settled: false, brokerRejection: rejection })).toMatchObject({ status: 'rejected', code: 'entry-filled', filled: 2 });
    expect(cancelEntryOutcome(order('canceled', 1), { settled: false, brokerRejection: rejection })).toMatchObject({ status: 'rejected', code: 'entry-partially-filled', filled: 1 });
    const elsewhere = cancelEntryOutcome(order('canceled'), { settled: false, brokerRejection: rejection });
    expect(elsewhere).toMatchObject({ status: 'waived', code: 'canceled-elsewhere' });
    expect(elsewhere?.reason).toContain('ne tímto příkazem');
    const still = cancelEntryOutcome(order('working'), { settled: false, brokerRejection: rejection });
    expect(still).toMatchObject({ status: 'rejected', code: 'cancel-not-effective', open: true });
    expect(still?.reason).toContain('vstup dál čeká');
    expect(cancelEntryOutcome(order('working', 1), { settled: false, brokerRejection: rejection })).toMatchObject({ status: 'rejected', code: 'entry-partially-filled', open: true, filled: 1 });
    expect(cancelEntryOutcome(null, { settled: true, brokerRejection: rejection })).toBeNull();
  });
  it('bez odmítnutí: vstup dál pracuje = nerozhodnuto, po ustálení „zrušení se neprojevilo“; konec jako cancelEntryVerdict', () => {
    expect(cancelEntryOutcome(order('working'), { settled: false })).toBeNull();
    expect(cancelEntryOutcome(order('pending'), { settled: false })).toBeNull();
    const settled = cancelEntryOutcome(order('working'), { settled: true });
    expect(settled).toMatchObject({ status: 'rejected', code: 'cancel-not-effective' });
    expect(settled?.reason).toContain('neprojevilo');
    expect(cancelEntryOutcome(order('canceled'), { settled: false })).toMatchObject({ status: 'acknowledged', code: 'canceled' });
    expect(cancelEntryOutcome(order('filled', 2), { settled: false })).toMatchObject({ status: 'rejected', code: 'entry-filled' });
  });
});

describe('C7 — UI helpery (čistě)', () => {
  const entry = (id: string, overrides: Partial<PendingOwnEntry> = {}): PendingOwnEntry => ({
    entryOperationId: `entry:${id}0000000`, entryBrokerOrderId: `${id}E`, symbol: SYM, side: 'Buy', quantity: 1,
    orderType: 'Limit', price: 24_980, scaleIn: false, createdAt: 1, ...overrides,
  });

  it('dvoukrok: druhé klepnutí se stejnou sadou až po 350 ms a do 4 s; změna sady = znovu od začátku', () => {
    const key = cancelPendingConfirmKey([entry('a')]);
    const first = cancelPendingConfirmStep(null, { key, now: 1_000 });
    expect(first).toEqual({ confirmed: false, next: { key, armedAt: 1_000 } });
    // Dvojklik se nepočítá a okno se jím neposune.
    expect(cancelPendingConfirmStep(first.next, { key, now: 1_200 })).toEqual({ confirmed: false, next: first.next });
    expect(cancelPendingConfirmStep(first.next, { key, now: 1_350 })).toEqual({ confirmed: true, next: null });
    expect(cancelPendingConfirmStep(first.next, { key, now: 5_001 })).toEqual({ confirmed: false, next: { key, armedAt: 5_001 } });
    // Vstup se mezi klepnutími změnil (vyplnil / jiná cena / nový vstup) → nepotvrdí.
    const changed = cancelPendingConfirmKey([entry('a', { price: 24_975 })]);
    expect(cancelPendingConfirmStep(first.next, { key: changed, now: 1_500 })).toEqual({ confirmed: false, next: { key: changed, armedAt: 1_500 } });
    expect(cancelPendingConfirmStep(first.next, { key: cancelPendingConfirmKey([entry('a'), entry('b')]), now: 1_500 }).confirmed).toBe(false);
    expect(cancelPendingConfirmStep(first.next, { key: '', now: 1_500 })).toEqual({ confirmed: false, next: null });
    // Pořadí položek klíč nemění.
    expect(cancelPendingConfirmKey([entry('a'), entry('b')])).toBe(cancelPendingConfirmKey([entry('b'), entry('a')]));
  });

  it('text potvrzení říká, co zůstává; tlačítko jen s capability nad čerstvým stavem', () => {
    const context = { foreignOrders: 2, protectiveLegs: 2, partialEntries: 1, otherOwnOrders: 0, blockedReason: null };
    expect(cancelPendingConfirmText([entry('a')], context)).toBe('Zrušit 1 čekající vstup? SL/TP otevřené pozice zůstávají. Cizí příkazy: 2 — zruš v Tradovate nebo Flatten. Částečně vyplněný vstup se neruší — zavři × / Flatten.');
    // Věta o pozici jen když ochranné nohy opravdu jsou (oponentura diffu, P3).
    expect(cancelPendingConfirmText([entry('a'), entry('b')], null)).toBe('Zrušit 2 čekající vstupy? Jejich SL/TP se zruší s nimi.');
    expect(cancelPendingConfirmText([entry('a')], { ...context, protectiveLegs: 0, foreignOrders: 0, partialEntries: 0 })).toBe('Zrušit 1 čekající vstup? Jeho SL/TP se zruší s ním.');
    expect(cancelPendingConfirmText([entry('a')], { ...context, foreignOrders: 0, partialEntries: 0 })).toBe('Zrušit 1 čekající vstup? SL/TP otevřené pozice zůstávají.');
    const base = { capability: true, statusFresh: true, restored: false, relayConnected: true, entries: [entry('a')], context };
    expect(cancelPendingAvailability(base)).toEqual({ show: true, enabled: true, reason: null });
    expect(cancelPendingAvailability({ ...base, capability: false }).show).toBe(false);
    expect(cancelPendingAvailability({ ...base, entries: [] }).show).toBe(false);
    expect(cancelPendingAvailability({ ...base, restored: true })).toMatchObject({ show: true, enabled: false });
    expect(cancelPendingAvailability({ ...base, statusFresh: false }).enabled).toBe(false);
    expect(cancelPendingAvailability({ ...base, relayConnected: false }).enabled).toBe(false);
    expect(cancelPendingAvailability({ ...base, context: { ...context, blockedReason: 'Ruční vstup má neznámý výsledek' } })).toMatchObject({ enabled: false, reason: 'Ruční vstup má neznámý výsledek' });
  });

  it('Dashboard „Zrušit příkaz“ jen u vlastního čekajícího vstupu leadera; jinde se neukáže', () => {
    const entries = [entry('a', { entryBrokerOrderId: '1234' })];
    expect(dashboardCancelTarget({ accountId: LEADER, orderId: 1234 }, { capability: true, leaderAccountId: LEADER, entries })).toBe(entries[0]);
    expect(dashboardCancelTarget({ accountId: LEADER, orderId: 999 }, { capability: true, leaderAccountId: LEADER, entries })).toBeNull();
    expect(dashboardCancelTarget({ accountId: 7, orderId: 1234 }, { capability: true, leaderAccountId: LEADER, entries })).toBeNull();
    expect(dashboardCancelTarget({ accountId: LEADER, orderId: 1234 }, { capability: false, leaderAccountId: LEADER, entries })).toBeNull();
    expect(dashboardCancelTarget({ accountId: LEADER, orderId: 1234 }, { capability: true, leaderAccountId: null, entries })).toBeNull();
  });

  it('capability: bez ní UI nic nenabídne', () => {
    expect(supportsCopierManualOrderCancelPending({ capabilities: [COPIER_MANUAL_ORDER_CANCEL_PENDING_CAPABILITY] })).toBe(true);
    expect(supportsCopierManualOrderCancelPending({ capabilities: ['manual-order-manage-v1', 'manual-order-close-v1'] })).toBe(false);
    expect(supportsCopierManualOrderCancelPending(null)).toBe(false);
  });

  const ack = (command: LeaderOrderManageCommand, overrides: Partial<LeaderOrderManageResult> = {}): LeaderOrderManageResult => ({
    type: 'leader-order-managed', operationId: command.operationId, action: 'cancel-entry', status: 'acknowledged', checkedAt: 1, blockers: [], ...overrides,
  });

  it('sekvenčně, každý s vlastním operationId, výsledek po položkách; chyba jedné nezastaví další, nic se neopakuje', async () => {
    let counter = 0;
    let inFlight = 0;
    const sent: LeaderOrderManageCommand[] = [];
    const send = vi.fn(async (command: LeaderOrderManageCommand) => {
      inFlight += 1;
      expect(inFlight).toBe(1); // nikdy dvě najednou
      sent.push(command);
      await new Promise(resolve => setTimeout(resolve, 5));
      inFlight -= 1;
      if (command.entryOperationId === 'entry:b0000000') throw new Error('relay 409 busy');
      if (command.entryOperationId === 'entry:c0000000') {
        return ack(command, { status: 'rejected', blockers: [{ code: 'entry-filled', text: 'Vstup se vyplnil (1) dřív, než ho broker zrušil — pozice je otevřená; zavři ji × nebo Flattenem.' }] });
      }
      if (command.entryOperationId === 'entry:d0000000') return ack(command, { status: 'blocked', blockers: [{ code: 'entry-not-pending', text: 'Vstup už nečeká.' }] });
      if (command.entryOperationId === 'entry:e0000000') throw new Error('copy-command entry-busy: jiná změna se zpracovává');
      return ack(command);
    });
    const entries = [entry('a'), entry('b'), entry('c'), entry('d'), entry('e'), entry('a')];
    const results = await cancelOwnPendingEntries({
      entries, groupId: 'g', leaderAccountId: LEADER, newOperationId: () => `manage:cancelpend${String(++counter).padStart(4, '0')}`, send,
    });
    expect(send).toHaveBeenCalledTimes(5); // duplicitní vstup jen jednou, žádné opakování
    expect(new Set(sent.map(command => command.operationId)).size).toBe(5);
    for (const command of sent) {
      expect(validateLeaderOrderManage(command)).toMatchObject({ action: 'cancel-entry', expect: { price: 24_980, quantity: 1 }, groupId: 'g', leaderAccountId: LEADER });
      expect(command.newPrice).toBeUndefined();
    }
    // Oponentura diffu (P3): výjimka po převzetí workerem (relay timeout) není „neodesláno“ — jen známé vzory.
    expect(results.map(item => item.outcome)).toEqual(['canceled', 'unknown', 'filled', 'not-pending', 'blocked']);
    expect(results[1].text).toContain('Výsledek neznámý (relay 409 busy)');
    expect(results[4].text).toContain('Neodesláno');
    const summary = cancelPendingSummary(results);
    expect(summary.tone).toBe('error');
    expect(summary.text).toContain('Zrušeno 1 z 5.');
    expect(summary.text).toContain('pozice je otevřená');
  });

  it('výsledek workeru → položka pravdivě: fill nikdy není „zrušeno“, chybějící výsledek = neznámý', () => {
    const command = buildCancelPendingCommand(entry('a'), { groupId: 'g', leaderAccountId: LEADER, operationId: 'manage:cancelpend0001' });
    expect(classifyCancelPendingResult(ack(command)).outcome).toBe('canceled');
    expect(classifyCancelPendingResult(ack(command, { status: 'rejected', blockers: [{ code: 'entry-partially-filled', text: 'z části' }] })).outcome).toBe('partially-filled');
    expect(classifyCancelPendingResult(ack(command, { status: 'unknown', reason: 'ověřuji' })).outcome).toBe('unknown');
    expect(classifyCancelPendingResult(ack(command, { status: 'rejected', reason: 'odmítnuto' })).outcome).toBe('rejected');
    expect(classifyCancelPendingResult(ack(command, { status: 'blocked', blockers: [{ code: 'busy', text: 'Běží změna celé pozice' }] })).outcome).toBe('blocked');
    expect(classifyCancelPendingResult(ack(command, { action: 'close-position' })).outcome).toBe('unknown');
    expect(classifyCancelPendingResult(null).outcome).toBe('unknown');
  });
});

// ── Skutečný controller (sólo skupina) ──────────────────────────────────────

const START = Date.UTC(2026, 10, 3, 15, 0, 0);
const REF = 25_000;
const ENTRY = 24_980;
const SL = 24_970;
const TP = 25_010;
const group = (): CopyGroupConfig => ({
  id: `manual-demo-${LEADER}`, name: 'Ruční DEMO test', enabled: true, leaderAccountId: LEADER,
  followers: [], localOnly: true, manualOnly: true, manualEntryMaxContracts: 5, safety: manualOnlyDemoSafety(),
});
const risk = (at: number): BrokerAccountRiskSnapshot => ({
  accountId: LEADER, at, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000, minNetLiq: null, dailyLossAutoLiq: null, trailingMaxDrawdown: null,
} as unknown as BrokerAccountRiskSnapshot);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let active: CopierRuntimeController | null = null;
afterEach(() => { active?.stop(); active = null; });

async function setup(options: { patchBroker?: (broker: MockBroker) => void; settleMs?: number; store?: ReturnType<typeof createMemoryCopierStore>; broker?: MockBroker; arm?: boolean } = {}) {
  const clock = { now: START };
  const broker = options.broker ?? createMockBroker({ behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [risk(START + 500)] });
  options.patchBroker?.(broker);
  const audits: string[] = [];
  const controller = await bootstrapCopierRuntime({
    broker, store: options.store ?? createMemoryCopierStore(), group: group(), clock: () => clock.now, osoCorrelationWindowMs: 50,
    manualEntryTimingsMs: { post: 300, start: 500, legWait: 300, manage: 500, settle: options.settleMs ?? 50, verify: 100 },
    manualEntryQuote: () => ({ contract: SYM, last: REF, lastAt: clock.now - 100, bid: REF - 0.25, ask: REF, quoteAt: clock.now - 50 }),
    onAudit: entries => { for (const entry of entries) audits.push(`${entry.kind}:${entry.reason ?? ''}`); },
  });
  active = controller;
  broker.setConnected(true);
  await controller.waitForIdle();
  if (options.arm !== false) {
    await controller.reconcile();
    controller.arm();
    await controller.waitForIdle();
  }
  clock.now = START + 1_000;
  await sleep(20);
  await controller.waitForIdle();
  return { broker, controller, audits, clock };
}
type Ctx = Awaited<ReturnType<typeof setup>>;

/** Čekající vlastní Limit OSO (Buy 2 @ 24 980, SL 24 970, TP 25 010). */
async function placePending(ctx: Ctx, id = 'pendc701', quantity = 2) {
  const status = ctx.controller.status();
  const preview = buildLeaderEntryPreviewCommand(
    { symbol: SYM, side: 'Buy', quantity, orderType: 'Limit', price: ENTRY, stopLoss: SL, takeProfit: TP },
    { group: { ...group(), leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: `preview:${id}` },
  );
  const placed = await ctx.controller.placeLeaderEntry(buildLeaderEntryPlaceCommand(preview, `entry:${id}`), { deadlineAt: ctx.clock.now + 15_000 });
  expect(placed).toMatchObject({ status: 'acknowledged' });
  await sleep(30);
  await ctx.controller.waitForIdle();
  return placed;
}
const brokerOrder = (ctx: Ctx, id: string) => ctx.broker.orders().find(order => order.brokerOrderId === id)!;
const emitOrder = (ctx: Ctx, order: BrokerOrder, version: string) => ctx.broker.emitEvent({ type: 'order', order: { ...order, sourceVersion: version } });
/** Vstup se (z části) vyplní u brokera — jako by fill předběhl zrušení. */
function fillAtBroker(ctx: Ctx, entryId: string, filled: number, status: BrokerOrder['status']) {
  const entry = brokerOrder(ctx, entryId);
  entry.status = status;
  entry.filledQuantity = filled;
  emitOrder(ctx, entry, `9:${status}`);
  ctx.broker.emitEvent({ type: 'fill', fill: { fillId: `f-${entryId}-${filled}`, tag: entry.tag, brokerOrderId: entryId, accountId: LEADER, symbol: SYM, side: 'Buy', quantity: filled, price: ENTRY, filledAt: 3 } });
  ctx.broker.setPosition(LEADER, SYM, filled);
  ctx.broker.emitEvent({ type: 'position', position: { accountId: LEADER, symbol: SYM, netQuantity: filled } });
}
const runCancelAll = (ctx: Ctx) => {
  let counter = 0;
  return cancelOwnPendingEntries({
    entries: ctx.controller.status().pendingOwnEntries ?? [], groupId: group().id, leaderAccountId: LEADER,
    newOperationId: () => `manage:cancelall${String(++counter).padStart(4, '0')}`,
    send: command => ctx.controller.manageLeaderOrder(validateLeaderOrderManage(command), { deadlineAt: ctx.clock.now + 15_000 }),
  });
};
const actionStatus = (ctx: Ctx, operationId = 'manage:cancelall0001') => ctx.controller.status().manualOrderActions?.find(item => item.operationId === operationId);

describe('C7 — controller: status pendingOwnEntries a cancel-entry ověřené stavem', () => {
  it('status nabídne jen vlastní čekající vstup (ne nohy, ne cizí příkaz); zrušení pošle cancel jen na vstup', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    const foreign: BrokerOrder = { tag: 'tv1', brokerOrderId: 'foreign-1', accountId: LEADER, symbol: SYM, side: 'Sell', orderType: 'Stop',
      quantity: 1, filledQuantity: 0, stopPrice: 24_900, status: 'working', sourceVersion: '1:Working', updatedAt: START };
    ctx.broker.seedOrder(foreign);
    emitOrder(ctx, foreign, '1:Working');
    await sleep(20);
    await ctx.controller.waitForIdle();
    const status = ctx.controller.status();
    expect(status.pendingOwnEntries).toEqual([expect.objectContaining({
      entryOperationId: 'entry:pendc701', entryBrokerOrderId: placed.entryBrokerOrderId, quantity: 2, price: ENTRY, orderType: 'Limit', scaleIn: false,
    })]);
    const offered = (status.pendingOwnEntries ?? []).map(entry => entry.entryBrokerOrderId);
    expect(offered).not.toContain(placed.stopBrokerOrderId);
    expect(offered).not.toContain(placed.targetBrokerOrderId);
    expect(offered).not.toContain('foreign-1');
    expect(status.pendingCancelContext).toMatchObject({ foreignOrders: 1, partialEntries: 0, blockedReason: null });

    const results = await runCancelAll(ctx);
    expect(results.map(item => item.outcome)).toEqual(['canceled']);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    expect(ctx.broker.cancelRequestCount('foreign-1')).toBe(0);
    expect(ctx.broker.cancelRequestCount(placed.stopBrokerOrderId!)).toBe(0);
    expect(ctx.broker.cancelRequestCount(placed.targetBrokerOrderId!)).toBe(0);
    await sleep(20);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().pendingOwnEntries).toEqual([]);
    expect(ctx.controller.status().lastError).toBeNull();
  });

  it('za DISARMED (i po kill switch) zrušení projde — snižuje riziko', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    ctx.controller.engageKillSwitch('test');
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().pendingOwnEntries?.map(entry => entry.entryBrokerOrderId)).toEqual([placed.entryBrokerOrderId]);
    const results = await runCancelAll(ctx);
    expect(results.map(item => item.outcome)).toEqual(['canceled']);
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
  });

  it('vyplnění mezi zobrazením a příkazem: worker nic nepošle (entry-not-pending)', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    const shown = ctx.controller.status().pendingOwnEntries ?? [];
    fillAtBroker(ctx, placed.entryBrokerOrderId!, 2, 'filled');
    await sleep(20);
    await ctx.controller.waitForIdle();
    const results = await cancelOwnPendingEntries({
      entries: shown, groupId: group().id, leaderAccountId: LEADER, newOperationId: () => 'manage:cancelall0001',
      send: command => ctx.controller.manageLeaderOrder(validateLeaderOrderManage(command), { deadlineAt: ctx.clock.now + 15_000 }),
    });
    // Oponentura diffu (P3): pravdivě „pozice je otevřená“ (kód entry-filled → tón error), ne obecné „nečeká“.
    expect(results.map(item => item.outcome)).toEqual(['filled']);
    expect(results[0].result?.blockers.map(issue => issue.code)).toEqual(['entry-filled']);
    expect(results[0].text).toContain('pozice je otevřená; nic se nezrušilo');
    expect(cancelPendingSummary(results).tone).toBe('error');
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
    expect(ctx.controller.status().pendingOwnEntries).toEqual([]);
    expect(ctx.controller.status().pendingCancelContext).toMatchObject({ protectiveLegs: 2 });
  });

  it('částečně vyplněný čekající vstup: status ho nenabídne a worker ho nezruší (text „z části vyplněný“)', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    const shown = ctx.controller.status().pendingOwnEntries ?? [];
    fillAtBroker(ctx, placed.entryBrokerOrderId!, 1, 'working');
    await sleep(20);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().pendingOwnEntries).toEqual([]);
    expect(ctx.controller.status().pendingCancelContext?.partialEntries).toBe(1);
    const results = await cancelOwnPendingEntries({
      entries: shown, groupId: group().id, leaderAccountId: LEADER, newOperationId: () => 'manage:cancelall0001',
      send: command => ctx.controller.manageLeaderOrder(validateLeaderOrderManage(command), { deadlineAt: ctx.clock.now + 15_000 }),
    });
    expect(results[0]).toMatchObject({ outcome: 'partially-filled' });
    expect(results[0].text).toContain('z části vyplněný');
    expect(results[0].text).toContain('pozice 1 je otevřená');
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
  });

  it('závod: vstup se vyplní, zatímco broker zpracovává zrušení — adaptér hlásí úspěch, worker NE „zrušeno“', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    const entryId = placed.entryBrokerOrderId!;
    const real = ctx.broker.cancelOrder.bind(ctx.broker);
    // Jako Tradovate adaptér: cancelOrder čeká na canceled|filled|rejected a „uspěje“ i u filled.
    ctx.broker.cancelOrder = async (accountId, id) => { if (id === entryId) { fillAtBroker(ctx, entryId, 2, 'filled'); return; } return real(accountId, id); };
    const results = await runCancelAll(ctx);
    expect(results[0]).toMatchObject({ outcome: 'filled' });
    expect(results[0].result).toMatchObject({ status: 'rejected', blockers: [expect.objectContaining({ code: 'entry-filled' })] });
    expect(actionStatus(ctx)).toMatchObject({ status: 'rejected' });
    await sleep(20);
    await ctx.controller.waitForIdle();
    // Nohy pracují a kryjí pozici → žádný incident, jen pravdivý výsledek.
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
    expect(ctx.audits.some(line => line.includes('pozice chráněná SL/TP'))).toBe(true);
  });

  it('závod s dílčím fillem: zbytek zrušen, nohy zmizely (kaskáda NEOVĚŘENÁ) → incident bez auto-close', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    const entryId = placed.entryBrokerOrderId!;
    ctx.broker.cancelOrder = async (_accountId, id) => {
      if (id !== entryId) return;
      fillAtBroker(ctx, entryId, 1, 'canceled');
      for (const legId of [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!]) {
        const leg = brokerOrder(ctx, legId);
        leg.status = 'canceled';
        emitOrder(ctx, leg, '9:Canceled');
      }
    };
    const results = await runCancelAll(ctx);
    expect(results[0]).toMatchObject({ outcome: 'partially-filled' });
    expect(results[0].text).toContain('1/2');
    expect(ctx.broker.liquidateRequests()).toHaveLength(0);
    expect(ctx.controller.status().armed).toBe(false);
    expect(ctx.controller.status().lastError).toMatch(/při rušení vyplnil \(1\) a SL\/TP pozice nejsou potvrzené/);
  });

  it('závod s dílčím fillem, nohy zůstaly na qty 2 nad pozicí 1 (přerostlé) → incident bez auto-close (oponentura diffu, P2)', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    const entryId = placed.entryBrokerOrderId!;
    ctx.broker.cancelOrder = async (_accountId, id) => { if (id === entryId) fillAtBroker(ctx, entryId, 1, 'canceled'); };
    const results = await runCancelAll(ctx);
    expect(results[0]).toMatchObject({ outcome: 'partially-filled' });
    await sleep(20);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().armed).toBe(false);
    expect(ctx.controller.status().lastError).toMatch(/nohy nesedí s pozicí \(qty 2\/2 vs fill 1\)/);
    expect(ctx.broker.liquidateRequests()).toHaveLength(0);
    expect(ctx.audits.some(line => line.includes('pozice chráněná SL/TP'))).toBe(false);
  });

  it('závod s dílčím fillem, nohy zmenšené na 1 (přesně kryjí fill) → bez incidentu, výsledek „z části vyplněný“', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    const entryId = placed.entryBrokerOrderId!;
    ctx.broker.cancelOrder = async (_accountId, id) => {
      if (id !== entryId) return;
      fillAtBroker(ctx, entryId, 1, 'canceled');
      for (const legId of [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!]) {
        const leg = brokerOrder(ctx, legId);
        leg.quantity = 1;
        emitOrder(ctx, leg, '9:Replaced');
      }
    };
    const results = await runCancelAll(ctx);
    expect(results[0]).toMatchObject({ outcome: 'partially-filled' });
    await sleep(20);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
    expect(ctx.audits.some(line => line.includes('pozice chráněná SL/TP'))).toBe(true);
  });

  it('ověřovací čtení po zrušení selže → unknown (ne „zrušeno“); pozdější čtení ho dořeší', async () => {
    let failLookups = 1;
    const ctx = await setup({ patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        if (failLookups > 0) { failLookups -= 1; throw new Error('REST timeout'); }
        return real(accountId, id);
      };
    } });
    const placed = await placePending(ctx);
    failLookups = 1;
    const results = await runCancelAll(ctx);
    expect(results[0]).toMatchObject({ outcome: 'unknown' });
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1);
    await sleep(120);
    await ctx.controller.waitForIdle();
    expect(actionStatus(ctx)).toMatchObject({ status: 'acknowledged' });
    expect(ctx.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(1); // dořešení jen čtením, nikdy druhé zrušení
  });

  it('neznámý výsledek zrušení se dořeší čtením pravdivě: dílčí fill = rejected, ne acknowledged', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    const entryId = placed.entryBrokerOrderId!;
    ctx.broker.cancelOrder = async (_accountId, id) => {
      if (id !== entryId) return;
      fillAtBroker(ctx, entryId, 1, 'canceled');
      throw new Error('cancelOrder command 7 was not confirmed by the order stream');
    };
    const results = await runCancelAll(ctx);
    expect(results[0]).toMatchObject({ outcome: 'unknown' });
    await sleep(150);
    await ctx.controller.waitForIdle();
    expect(actionStatus(ctx)).toMatchObject({ status: 'rejected' });
    expect(actionStatus(ctx)?.reason).toContain('z části vyplnil');
  });

  it('opačné pořadí: stream ukáže Order(Canceled) s fillem 0 dřív než Fill — rozhodne autoritativní čtení, ne stream', async () => {
    // Dořešení časovačem vypnuté (10 s), aby rozhodl jen stream → čtení.
    const ctx = await setup({ settleMs: 10_000 });
    const placed = await placePending(ctx);
    const entryId = placed.entryBrokerOrderId!;
    ctx.broker.cancelOrder = async (_accountId, id) => {
      if (id === entryId) throw new Error('cancelOrder command 8 was not confirmed by the order stream');
    };
    const results = await runCancelAll(ctx);
    expect(results[0]).toMatchObject({ outcome: 'unknown' });
    // Broker (REST) už ví o dílčím fillu, stream zatím jen zrušení s fillem 0.
    const entry = brokerOrder(ctx, entryId);
    entry.status = 'canceled';
    entry.filledQuantity = 1;
    emitOrder(ctx, { ...entry, filledQuantity: 0 }, '10:Canceled');
    await sleep(40);
    await ctx.controller.waitForIdle();
    expect(actionStatus(ctx)).toMatchObject({ status: 'rejected' });
  });
});

describe('C7 — oponentura diffu: odmítnuté zrušení, pozdní výsledek, restart, replay', () => {
  const REJECTION = 'cancelOrder rejected: TooLateToCancel';
  /** Nohy obchodu u brokera zmizí (kaskáda / zrušení) — pozice bez ochrany. */
  const cancelLegs = (ctx: Ctx, placed: { stopBrokerOrderId?: string; targetBrokerOrderId?: string }, emit = true) => {
    for (const legId of [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!]) {
      const leg = brokerOrder(ctx, legId);
      leg.status = 'canceled';
      if (emit) emitOrder(ctx, leg, '9:Canceled');
    }
  };

  it('P2: vstup se vyplní a broker zrušení ODMÍTNE → výsledek stavem: „pozice je otevřená“, nohy ověřené, ne surové „rejected“', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    const entryId = placed.entryBrokerOrderId!;
    ctx.broker.cancelOrder = async (_accountId, id) => {
      if (id !== entryId) return;
      fillAtBroker(ctx, entryId, 2, 'filled');
      throw new Error(REJECTION);
    };
    const results = await runCancelAll(ctx);
    expect(results[0]).toMatchObject({ outcome: 'filled' });
    expect(results[0].result?.blockers.map(issue => issue.code)).toEqual(['entry-filled']);
    expect(results[0].text).toContain('pozice je otevřená');
    expect(cancelPendingSummary(results).tone).toBe('error');
    // Kód i ve statusu (push watchdogu pak netvrdí „vstup dál čeká“).
    expect(actionStatus(ctx)).toMatchObject({ status: 'rejected', resultCode: 'entry-filled' });
    expect(actionStatus(ctx)?.reason).not.toContain('TooLateToCancel');
    await sleep(20);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status()).toMatchObject({ armed: true, lastError: null });
    expect(ctx.audits.some(line => line.includes('pozice chráněná SL/TP'))).toBe(true);
  });

  it('P2: vstup se vyplní, broker zrušení odmítne a nohy chybí → incident bez auto-close', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    const entryId = placed.entryBrokerOrderId!;
    ctx.broker.cancelOrder = async (_accountId, id) => {
      if (id !== entryId) return;
      fillAtBroker(ctx, entryId, 2, 'filled');
      cancelLegs(ctx, placed);
      throw new Error(REJECTION);
    };
    const results = await runCancelAll(ctx);
    expect(results[0]).toMatchObject({ outcome: 'filled' });
    await sleep(20);
    await ctx.controller.waitForIdle();
    expect(ctx.controller.status().armed).toBe(false);
    expect(ctx.controller.status().lastError).toMatch(/při rušení vyplnil \(2\) a SL\/TP pozice nejsou potvrzené u brokera \(noha canceled/);
    expect(ctx.broker.liquidateRequests()).toHaveLength(0);
  });

  it('P2: broker zrušení odmítne a vstup dál čeká → rejected „vstup dál čeká“, znovu se nabídne, nic se neopakuje', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    const entryId = placed.entryBrokerOrderId!;
    let calls = 0;
    ctx.broker.cancelOrder = async (_accountId, id) => { if (id === entryId) { calls += 1; throw new Error('cancelOrder rejected: Unknown'); } };
    const results = await runCancelAll(ctx);
    expect(results[0]).toMatchObject({ outcome: 'rejected' });
    expect(results[0].text).toContain('vstup dál čeká');
    expect(calls).toBe(1);
    await sleep(120);
    await ctx.controller.waitForIdle();
    expect(calls).toBe(1);
    expect(actionStatus(ctx)).toMatchObject({ status: 'rejected' });
    expect(ctx.controller.status().pendingOwnEntries?.map(entry => entry.entryBrokerOrderId)).toEqual([entryId]);
  });

  it('P2: dvojí zrušení (vstup už zrušený jinak) a broker druhé odmítne → „zrušeno“ bez tvrzení kauzality; replay = acknowledged', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    const entryId = placed.entryBrokerOrderId!;
    ctx.broker.cancelOrder = async (_accountId, id) => {
      if (id !== entryId) return;
      const entry = brokerOrder(ctx, entryId);
      entry.status = 'canceled';
      emitOrder(ctx, entry, '9:Canceled');
      throw new Error(REJECTION);
    };
    const shown = ctx.controller.status().pendingOwnEntries ?? [];
    const command = validateLeaderOrderManage(buildCancelPendingCommand(shown[0], { groupId: group().id, leaderAccountId: LEADER, operationId: 'manage:cancelall0001' }));
    const first = await ctx.controller.manageLeaderOrder(command, { deadlineAt: ctx.clock.now + 15_000 });
    expect(first).toMatchObject({ status: 'acknowledged' });
    expect(first.reason).toContain('ne tímto příkazem');
    expect(classifyCancelPendingResult(first).outcome).toBe('canceled');
    expect(actionStatus(ctx)).toMatchObject({ status: 'waived' });
    // Idempotentní replay (ztracený ACK): známý výsledek, ne „neznámý“ (oponentura diffu, P3).
    const replay = await ctx.controller.manageLeaderOrder(command, { deadlineAt: ctx.clock.now + 15_000 });
    expect(replay).toMatchObject({ status: 'acknowledged' });
    expect(ctx.broker.cancelRequestCount(entryId)).toBe(0); // přepsaný cancelOrder; nic dalšího neodešlo
  });

  it('P3: replay stejného operationId po vyplnění během rušení vrátí kód → „pozice je otevřená“, ne „odmítnuto“', async () => {
    const ctx = await setup();
    const placed = await placePending(ctx);
    const entryId = placed.entryBrokerOrderId!;
    let calls = 0;
    ctx.broker.cancelOrder = async (_accountId, id) => { if (id === entryId) { calls += 1; fillAtBroker(ctx, entryId, 2, 'filled'); } };
    const shown = ctx.controller.status().pendingOwnEntries ?? [];
    const command = validateLeaderOrderManage(buildCancelPendingCommand(shown[0], { groupId: group().id, leaderAccountId: LEADER, operationId: 'manage:cancelall0001' }));
    const first = await ctx.controller.manageLeaderOrder(command, { deadlineAt: ctx.clock.now + 15_000 });
    expect(classifyCancelPendingResult(first).outcome).toBe('filled');
    const replay = await ctx.controller.manageLeaderOrder(command, { deadlineAt: ctx.clock.now + 15_000 });
    expect(replay).toMatchObject({ status: 'rejected', blockers: [expect.objectContaining({ code: 'entry-filled' })] });
    expect(classifyCancelPendingResult(replay).outcome).toBe('filled');
    expect(calls).toBe(1);
  });

  it('P2: pozdní definitivní odmítnutí po timeoutu se rozhodne stavem (fill → pozice otevřená), ne surovým „rejected“', async () => {
    // Dořešení časovačem vypnuté (10 s): rozhodne jen pozdní výsledek zápisu.
    const ctx = await setup({ settleMs: 10_000 });
    const placed = await placePending(ctx);
    const entryId = placed.entryBrokerOrderId!;
    let reject: ((error: Error) => void) | undefined;
    ctx.broker.cancelOrder = (_accountId, id) => (id === entryId ? new Promise<void>((_resolve, fail) => { reject = fail; }) : Promise.resolve());
    const results = await runCancelAll(ctx);
    expect(results[0]).toMatchObject({ outcome: 'unknown' });
    // Broker (REST) vstup vyplnil; stream to zatím nedoručil — rozhodne pozdní odmítnutí → čtení.
    const entry = brokerOrder(ctx, entryId);
    entry.status = 'filled';
    entry.filledQuantity = 2;
    ctx.broker.setPosition(LEADER, SYM, 2);
    reject?.(new Error(REJECTION));
    await sleep(60);
    await ctx.controller.waitForIdle();
    expect(actionStatus(ctx)).toMatchObject({ status: 'rejected' });
    expect(actionStatus(ctx)?.reason).toContain('pozice je otevřená');
    expect(actionStatus(ctx)?.reason).not.toContain('TooLateToCancel');
    expect(ctx.audits.some(line => line.includes('pozice chráněná SL/TP'))).toBe(true);
  });

  it('P3: nohy se ověří DŘÍV, než se uloží konečné „rejected“ (pád mezi tím nesmí kontrolu ztratit)', async () => {
    const seen: string[] = [];
    let legIds: string[] = [];
    let ref: Ctx | null = null;
    const ctx = await setup({ patchBroker: broker => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        if (ref && legIds.includes(id)) seen.push(actionStatus(ref)?.status ?? 'none');
        return real(accountId, id);
      };
    } });
    ref = ctx;
    const placed = await placePending(ctx);
    legIds = [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!];
    ctx.broker.cancelOrder = async (_accountId, id) => { if (id === placed.entryBrokerOrderId) fillAtBroker(ctx, id, 2, 'filled'); };
    const results = await runCancelAll(ctx);
    expect(results[0]).toMatchObject({ outcome: 'filled' });
    expect(seen.length).toBe(2);
    expect(seen.every(status => status === 'sending')).toBe(true);
  });

  async function restartWithCancelRecord(prepare: (ctx: Ctx, placed: Awaited<ReturnType<typeof placePending>>) => void, observe?: (broker: MockBroker, legIds: string[], seen: string[], ref: { ctx: Ctx | null }) => void) {
    const store = createMemoryCopierStore();
    const first = await setup({ store });
    const placed = await placePending(first);
    first.controller.stop();
    active = null;
    prepare(first, placed);
    const snapshot = await store.load();
    await store.commit({
      ...snapshot,
      safety: { ...snapshot.safety!, manualOrderActions: [...(snapshot.safety?.manualOrderActions ?? []), {
        operationId: 'manage:restart0001', payloadHash: 'abcdefgh12', entryOperationId: 'entry:pendc701', action: 'cancel-entry',
        status: 'sending', symbol: SYM, targetBrokerOrderId: placed.entryBrokerOrderId!, fromPrice: ENTRY, toPrice: null, quantity: 2,
        createdAt: first.clock.now, updatedAt: first.clock.now,
      }] },
    }, snapshot.revision);
    const seen: string[] = [];
    const ref: { ctx: Ctx | null } = { ctx: null };
    const legIds = [placed.stopBrokerOrderId!, placed.targetBrokerOrderId!];
    observe?.(first.broker, legIds, seen, ref);
    const second = await setup({ store, broker: first.broker, arm: false });
    ref.ctx = second;
    return { second, placed, seen };
  }

  it('P3: restart v `sending` (zrušení k brokerovi nedorazilo), vstup dál čeká → po ustálení rejected „neprojevilo“, nic se nepošle', async () => {
    const { second, placed } = await restartWithCancelRecord(() => undefined);
    expect(actionStatus(second, 'manage:restart0001')?.status).toBe('unknown');
    await sleep(250);
    await second.controller.waitForIdle();
    expect(actionStatus(second, 'manage:restart0001')).toMatchObject({ status: 'rejected' });
    expect(actionStatus(second, 'manage:restart0001')?.reason).toContain('neprojevilo');
    expect(second.broker.cancelRequestCount(placed.entryBrokerOrderId!)).toBe(0);
  });

  it('P3: restart po vyplnění během rušení → dořešení po startu ověří nohy (chybí → incident) dřív, než uloží „rejected“', async () => {
    const { second, seen } = await restartWithCancelRecord((ctx, placed) => {
      const entry = brokerOrder(ctx, placed.entryBrokerOrderId!);
      entry.status = 'canceled';
      entry.filledQuantity = 1;
      ctx.broker.setPosition(LEADER, SYM, 1);
      cancelLegs(ctx, placed, false);
    }, (broker, legIds, seenStatuses, ref) => {
      const real = broker.findOrderById.bind(broker);
      broker.findOrderById = async (accountId, id) => {
        if (ref.ctx && legIds.includes(id)) seenStatuses.push(actionStatus(ref.ctx, 'manage:restart0001')?.status ?? 'none');
        return real(accountId, id);
      };
    });
    await sleep(250);
    await second.controller.waitForIdle();
    expect(actionStatus(second, 'manage:restart0001')).toMatchObject({ status: 'rejected' });
    expect(actionStatus(second, 'manage:restart0001')?.reason).toContain('z části vyplnil');
    expect(second.controller.status().lastError).toMatch(/při rušení vyplnil \(1\) a SL\/TP pozice nejsou potvrzené/);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every(status => status === 'unknown')).toBe(true);
    expect(second.broker.liquidateRequests()).toHaveLength(0);
  });
});
