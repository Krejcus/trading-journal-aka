import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  liveBareCloseErrorNotice, liveBareCloseKey, liveBareCloseLabel, liveBareCloseOffer, liveBareCloseResultNotice,
  liveBareLineEntryId, liveBareLineId, sameBareTrade,
} from '../lib/liveBareCloseUi';
import {
  DASHBOARD_CANCEL_NOT_OWN, DASHBOARD_CANCEL_NOT_WORKER_GROUP, DASHBOARD_CANCEL_OLD_WORKER, DASHBOARD_CANCEL_UNREADABLE, DASHBOARD_CANCEL_VERIFYING,
  CANCEL_PENDING_CONTEXT_UNREADABLE, CANCEL_PENDING_REST_UNVERIFIED,
  cancelPendingSeenProblem, dashboardOrderCancelView, dashboardPendingCancelForGroup, liveCancelPendingConfirmText, liveCancelPendingView,
  validPendingCancelContext, validPendingOwnEntries,
} from '../lib/liveCancelPendingUi';
import type { CancelPendingItemResult, PendingCancelContext, PendingOwnEntry } from '../lib/liveCancelPending';
import type { BareLeaderTrade } from '../lib/manualBareClose';
import type { LeaderOrderManageResult } from '../lib/leaderOrderManage';
import { createLiveManageRun } from '../hooks/useLiveManageRunner';
import {
  LIVE_COMMAND_BUSY_TEXT, createLiveBareClosePanelClick, createLiveBareCloseRun, createLiveCancelPendingClick, createLiveCancelPendingRun, runWithCommandLock,
} from '../hooks/liveCommandRuns';
import { LIVE_ACTION_CHANGED_TEXT, createLiveClickGate, liveMoveClick, liveMoveKey, liveRepeatClick } from '../lib/liveClickGate';
import { liveBareConfirmKey } from '../lib/liveBareEntry';
import { dashboardRowCancelView } from '../lib/liveCancelPendingUi';
import { livePhoneCancelPendingChipShown } from '../lib/livePhoneOrders';
import { LIVE_DESK_NOT_FRESH, LIVE_DESK_ROUTE_CHANGED, createLiveDeskCommands } from '../lib/liveDeskCommands';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import type { LeaderOrderManageCommand } from '../lib/leaderOrderManage';
import { livePositionChartLines } from '../lib/liveChartOrderLines';
import type { LiveChartPositionSummary } from '../lib/liveChartPosition';
import { resolveLiveHotkey } from '../lib/liveHotkeys';
import { LIVE_LINE_CLICK_INITIAL, cancelConfirmKey, liveLineClick, liveLineClickSync, orderLineConfirmKeys, orderLineConfirmStep, orderLineConfirmSync } from '../components/BacktestOrderLinesOverlay';
import { BareCloseButton, liveDirectErrorLocks, liveDirectResultLocks } from '../components/LiveOrderTicket';
import { DashboardOrderCancelButton, LiveCancelPendingBar, LiveCancelPendingBoundary, type LiveDashboardPendingCancel } from '../components/LivePendingCancel';
import LiveSafetyControls from '../components/LiveSafetyControls';
import { createFlattenGroupCoordinator } from '../lib/liveSafetyAction';
import { LivePhoneCancelPendingChip, LivePhonePositionBar, createLivePhoneBarGuard } from '../components/day/LivePhoneLiveActions';

const source = (file: string) => readFileSync(file, 'utf8');
const between = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  return text.slice(from, text.indexOf(end, from + start.length));
};

const TRADE: BareLeaderTrade = { entryOperationId: 'entry:bare00000001', symbol: 'MNQZ6', side: 'Buy', quantity: 2, referencePrice: 25_000.25 };
const LONG2 = { side: 'long' as const, quantity: 2, symbol: 'MNQZ6', pending: null };
const offerInput = (patch: Partial<Parameters<typeof liveBareCloseOffer>[0]> = {}): Parameters<typeof liveBareCloseOffer>[0] => ({
  capability: true, trade: TRADE, managedTrade: false, statusFresh: true, restored: false, relayConnected: true,
  armed: true, shadowMode: false, killSwitch: false, position: LONG2, ...patch,
});
const manageResult = (patch: Partial<LeaderOrderManageResult> = {}): LeaderOrderManageResult => ({
  type: 'leader-order-managed', operationId: 'manage:abcdef012345', action: 'close-position', status: 'acknowledged', checkedAt: 1, blockers: [], ...patch,
});

const entry = (id: string, patch: Partial<PendingOwnEntry> = {}): PendingOwnEntry => ({
  entryOperationId: `entry:${id.padEnd(12, '0')}`, entryBrokerOrderId: id, symbol: 'MNQZ6', side: 'Buy', quantity: 1,
  orderType: 'Limit', price: 24_990, scaleIn: false, createdAt: 1, ...patch,
});
const CONTEXT: PendingCancelContext = { foreignOrders: 1, protectiveLegs: 0, partialEntries: 0, otherOwnOrders: 0, blockedReason: null };
const viewInput = (patch: Partial<Parameters<typeof liveCancelPendingView>[0]> = {}): Parameters<typeof liveCancelPendingView>[0] => ({
  capability: true, statusFresh: true, restored: false, relayConnected: true, entries: [entry('101'), entry('102', { price: 24_980 })], context: CONTEXT, ...patch,
});

// ---------------------------------------------------------------------------
// C8 — × zavřít holý Market bez SL/TP

describe('C8 UI: nabídka × u holé pozice (jen zobrazení, worker je autorita)', () => {
  it('šťastná cesta: nabídka s klíčem akce + id cíle + tvar', () => {
    const offer = liveBareCloseOffer(offerInput());
    expect(offer).toEqual({ trade: TRADE, key: 'close-bare:entry:bare00000001:MNQZ6:Buy:2', enabled: true, reason: null });
    expect(liveBareCloseKey({ ...TRADE, entryOperationId: 'entry:other0000001' })).not.toBe(offer!.key);
    expect(liveBareCloseKey({ ...TRADE, quantity: 1 })).not.toBe(offer!.key);
  });

  it('starý worker bez capability, žádný obchod, spravovatelný obchod s nohami = žádná nabídka', () => {
    expect(liveBareCloseOffer(offerInput({ capability: false }))).toBeNull();
    expect(liveBareCloseOffer(offerInput({ trade: null }))).toBeNull();
    expect(liveBareCloseOffer(offerInput({ managedTrade: true }))).toBeNull();
    expect(liveBareCloseOffer(offerInput({ trade: { ...TRADE, referencePrice: 0 } }))).toBeNull();
    expect(liveBareCloseOffer(offerInput({ trade: { ...TRADE, entryOperationId: 'manage:x' } }))).toBeNull();
  });

  it('unknown ≠ flat: neznámá nebo nesedící pozice leadera = žádné × (zůstává Flatten)', () => {
    expect(liveBareCloseOffer(offerInput({ position: null }))).toBeNull();
    expect(liveBareCloseOffer(offerInput({ position: undefined }))).toBeNull();
    expect(liveBareCloseOffer(offerInput({ position: { ...LONG2, quantity: 1 } }))).toBeNull();
    expect(liveBareCloseOffer(offerInput({ position: { ...LONG2, side: 'short' } }))).toBeNull();
    expect(liveBareCloseOffer(offerInput({ position: { ...LONG2, symbol: 'MNQH7' } }))).toBeNull();
    expect(liveBareCloseOffer(offerInput({ position: { ...LONG2, pending: { type: 'Limit', price: 1 } } }))).toBeNull();
  });

  it('zastaralý / obnovený stav, chybějící relay a kopírka mimo ARMED (shadow, kill) = neaktivní s důvodem', () => {
    for (const patch of [{ statusFresh: false }, { restored: true }]) {
      expect(liveBareCloseOffer(offerInput(patch))).toMatchObject({ enabled: false, reason: expect.stringMatching(/ověřuje/) });
    }
    expect(liveBareCloseOffer(offerInput({ relayConnected: false }))).toMatchObject({ enabled: false, reason: expect.stringMatching(/relay/) });
    for (const patch of [{ armed: false }, { shadowMode: true }, { killSwitch: true }]) {
      expect(liveBareCloseOffer(offerInput(patch))).toMatchObject({ enabled: false, reason: expect.stringMatching(/Flattenem/) });
    }
  });

  it('sameBareTrade porovná všechno, co jde do příkazu', () => {
    expect(sameBareTrade(TRADE, { ...TRADE })).toBe(true);
    for (const patch of [{ entryOperationId: 'entry:zzzz00000000' }, { symbol: 'MNQH7' }, { side: 'Sell' as const }, { quantity: 1 }, { referencePrice: 25_001 }]) {
      expect(sameBareTrade(TRADE, { ...TRADE, ...patch })).toBe(false);
    }
    expect(sameBareTrade(null, TRADE)).toBe(false);
  });

  it('texty výsledku jsou pravdivé: unknown nikdy „zavřeno“, waived = ne tímto příkazem', () => {
    expect(liveBareCloseResultNotice(manageResult(), 5)).toMatchObject({ tone: 'ok', text: expect.stringMatching(/zavřena — ověřeno/) });
    const waived = liveBareCloseResultNotice(manageResult({ reason: 'pozice leadera už byla zavřená — ne tímto příkazem' }), 5);
    expect(waived.tone).toBe('warn');
    expect(waived.text).toMatch(/ne tímto příkazem/);
    expect(waived.text).not.toMatch(/Holá pozice zavřena/);
    for (const result of [manageResult({ status: 'unknown', reason: 'Zavření odesláno, stav leadera zatím neověřený' }), null, manageResult({ action: 'move-stop' })]) {
      const notice = liveBareCloseResultNotice(result, 5);
      expect(notice.tone).toBe('warn');
      expect(notice.text).toMatch(/^Neověřeno — zkontroluj Tradovate/);
      expect(notice.text).not.toMatch(/zavřen[ao]\b/i);
    }
    expect(liveBareCloseResultNotice(manageResult({ status: 'rejected', reason: 'TooLate' }), 5)).toMatchObject({ tone: 'bad', text: expect.stringMatching(/Broker zavření odmítl \(TooLate\)/) });
    expect(liveBareCloseResultNotice(manageResult({ status: 'blocked', blockers: [{ code: 'shape', text: 'Pozice nesedí.' }] }), 5)).toEqual({ tone: 'bad', text: 'Neodesláno: Pozice nesedí.', at: 5 });
  });

  it('výjimka: prokazatelně neodesláno vs. neověřeno', () => {
    expect(liveBareCloseErrorNotice(new Error('Stav kopírky není čerstvě ověřený — nic se neodeslalo.'), 1).text).toMatch(/^Neodesláno/);
    expect(liveBareCloseErrorNotice(new Error('relay timeout'), 1)).toMatchObject({ tone: 'warn', text: expect.stringMatching(/^Neověřeno — zkontroluj Tradovate \(relay timeout\)/) });
  });
});

describe('C8 UI: odeslání jde sdíleným zámkem jednoho příkazu, právě jednou, bez opakování', () => {
  const setup = (busy = false) => {
    const busyRef = { current: busy };
    const close = vi.fn(async (_seen: BareLeaderTrade) => manageResult());
    const report = vi.fn();
    const run = createLiveBareCloseRun({ close: () => close, busyRef, setPendingMove: () => {}, report });
    return { busyRef, close, report, run };
  };

  it('zámek obsazený (× / BE / Zrušit z jiného ovládání) → nic neodejde', async () => {
    const { run, close, report, busyRef } = setup(true);
    expect(await run(TRADE)).toMatchObject({ called: false, status: 'not-sent' });
    expect(close).not.toHaveBeenCalled();
    expect(report.mock.calls[0][0].text).toMatch(/Čeká se na výsledek předchozí změny — nic se neodeslalo/);
    expect(busyRef.current).toBe(true);
  });

  it('volný zámek → jediné volání s obchodem, který uživatel viděl; zámek drží po dobu letu', async () => {
    const { run, close, busyRef } = setup(false);
    let lockedDuring = false;
    close.mockImplementation(async () => { lockedDuring = busyRef.current; return manageResult(); });
    const outcome = await run(TRADE);
    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith(TRADE);
    expect(lockedDuring).toBe(true);
    expect(busyRef.current).toBe(false);
    expect(outcome.notice).toMatchObject({ tone: 'ok' });
  });

  it('souběh: × holé pozice letí → správa z čáry se stejným zámkem neodejde', async () => {
    const { run, close, busyRef } = setup(false);
    let release!: () => void;
    close.mockImplementation(() => new Promise(resolve => { release = () => resolve(manageResult()); }));
    const lineManage = vi.fn(async () => manageResult({ action: 'move-stop' }));
    const lineRun = createLiveManageRun({ manage: () => lineManage, busyRef, setPendingMove: () => {}, report: () => {} });
    const inFlight = run(TRADE);
    expect(await lineRun('move-stop', 24_980, 25_000, 'stopLoss')).toMatchObject({ called: false, status: 'not-sent' });
    expect(lineManage).not.toHaveBeenCalled();
    release();
    await inFlight;
  });

  it('výjimka po odeslání = neověřeno (nikdy zavřeno), nic se neopakuje; neznámý výsledek = „Neověřeno“', async () => {
    const thrown = setup(false);
    thrown.close.mockImplementation(async () => { throw new Error('relay timeout'); });
    const outcome = await thrown.run(TRADE);
    expect(outcome).toMatchObject({ called: true, status: 'unknown' });
    expect(outcome.notice.text).toMatch(/^Neověřeno — zkontroluj Tradovate/);
    expect(thrown.close).toHaveBeenCalledTimes(1);
    const unknown = setup(false);
    unknown.close.mockImplementation(async () => manageResult({ status: 'unknown' }));
    expect((await unknown.run(TRADE)).notice.text).toMatch(/^Neověřeno/);
    const missing = createLiveBareCloseRun({ close: () => null, busyRef: { current: false }, setPendingMove: () => {}, report: () => {} });
    expect(await missing(TRADE)).toMatchObject({ called: false, status: 'not-sent' });
  });
});

describe('C8 UI: × na čáře PC a Shift+X — id cíle v klíči, jedním klikem', () => {
  const summary: LiveChartPositionSummary = {
    kind: 'position', side: 'long', quantity: 2, entry: 25_000.25, stop: null, target: null, openPnl: 4, mark: 25_001.25, entryType: 'Market',
  } as unknown as LiveChartPositionSummary;

  it('holá pozice s nabídkou: × bez BE; bez nabídky žádné ×', () => {
    const [line] = livePositionChartLines(summary, { manageable: false, entryAvg: null, pointValue: 2, bareClose: { entryOperationId: TRADE.entryOperationId } });
    expect(line).toMatchObject({ id: liveBareLineId(TRADE.entryOperationId), cancellable: true, cancelAction: 'close-position' });
    expect(line.confirmCancel).toBeUndefined();
    expect(line.actions).toBeUndefined();
    expect(liveBareLineEntryId(line.id)).toBe(TRADE.entryOperationId);
    expect(liveBareLineEntryId('live-position:entry')).toBeNull();
    const [plain] = livePositionChartLines(summary, { manageable: false, entryAvg: null, pointValue: 2 });
    expect(plain).toMatchObject({ id: 'live-position:entry', cancellable: false });
    // Klíč × nese id cíle: jiný holý vstup = jiný klíč.
    const [other] = livePositionChartLines(summary, { manageable: false, entryAvg: null, pointValue: 2, bareClose: { entryOperationId: 'entry:other0000001' } });
    expect(cancelConfirmKey(other)).not.toBe(cancelConfirmKey(line));
  });

  it('Shift+X míří na čáru holé pozice prvním stiskem; dvojstisk nic; busy nic', () => {
    const lines = livePositionChartLines(summary, { manageable: false, entryAvg: null, pointValue: 2, bareClose: { entryOperationId: TRADE.entryOperationId } });
    const guard = { current: null };
    const state = { lines, breakEven: null, hasDraft: false, busy: false };
    expect(resolveLiveHotkey({ kind: 'close-position' }, state, guard, 1_000)).toMatchObject({ kind: 'run', line: { id: liveBareLineId(TRADE.entryOperationId) } });
    expect(resolveLiveHotkey({ kind: 'close-position' }, state, guard, 1_200)).toMatchObject({ kind: 'none' });
    expect(resolveLiveHotkey({ kind: 'close-position' }, { ...state, busy: true }, guard, 2_500)).toMatchObject({ kind: 'blocked' });
  });

  it('dvoukrok čáry backtestu (`orderLineConfirmStep`): 2. klik ≥ 350 ms od PŘEDCHOZÍHO kliku, ≤ 4 s, stejný klíč', () => {
    const key = 'live-position:entry:bare:entry:x:cancel:close-position:25000';
    let state = orderLineConfirmStep(null, key, true, 0);
    expect(state.fire).toBe(false);
    state = orderLineConfirmStep(state.next, key, true, 200);
    expect(state.fire).toBe(false);
    // Trojklik: 400 ms od prvního, ale jen 200 ms od předchozího = nic.
    state = orderLineConfirmStep(state.next, key, true, 400);
    expect(state.fire).toBe(false);
    expect(orderLineConfirmStep(state.next, key, true, 750).fire).toBe(true);
    // Po 4 s = znovu první krok; jiný klíč nepotvrdí.
    const armed = orderLineConfirmStep(null, key, true, 0).next;
    expect(orderLineConfirmStep(armed, key, true, 4_001).fire).toBe(false);
    expect(orderLineConfirmStep(armed, `${key}x`, true, 500).fire).toBe(false);
    // Akce bez potvrzení projde hned; rozběhnutá jiná akce téže čáry nic nepotvrdí.
    expect(orderLineConfirmStep(null, 'a:cancel:close-position:1', false, 0)).toEqual({ next: null, fire: true });
    const pendingArmed = orderLineConfirmStep(null, 'l:cancel:cancel-order:1', true, 0).next;
    expect(orderLineConfirmStep(pendingArmed, 'l:cancel:close-position:1', false, 500).fire).toBe(false);
  });

  it('obrazovka: × holé čáry jde jen přes closeBare (nabídka s týmž id), panel tutéž funkci', () => {
    const screen = source('components/LiveTradingScreen.tsx');
    const cancel = between(screen, 'onOrderLineCancel: line => {', 'onOrderLineAction:');
    expect(cancel.indexOf('replayNotice()')).toBeLessThan(cancel.indexOf('liveBareLineEntryId(line.id)'));
    expect(cancel).toMatch(/if \(bareEntryId != null\) \{ void closeBare\(bareEntryId\); return; \}/);
    const closeBare = between(screen, 'const closeBare = useCallback(', '}, [bareCloseRun]);');
    expect(closeBare).toMatch(/offer\.trade\.entryOperationId !== entryOperationId/);
    expect(closeBare).toMatch(/if \(!offer\.enabled\)/);
    expect(screen).toMatch(/bareClose: bareOffer\?\.enabled \? \{ entryOperationId: bareOffer\.trade\.entryOperationId \} : null,/);
    expect(screen).toMatch(/\{\.\.\.\(bareOffer \? \{ onBareClose: closeBare \} : \{\}\)\}/);
    expect(screen).toMatch(/const manageState = manageLockRef \? \{ \.\.\.ownManageState, busyRef: manageLockRef \} : ownManageState;/);
  });

  it('panel: tlačítko × holé pozice — neaktivní s důvodem, text co se zavře', () => {
    const offer = liveBareCloseOffer(offerInput({ armed: false }))!;
    const html = renderToStaticMarkup(React.createElement(BareCloseButton, { offer, busy: false, notice: null, onClick: () => {} }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('Zavřít LONG 2 · bez SL/TP');
    expect(html).toMatch(/Flattenem/);
    expect(liveBareCloseLabel(TRADE)).toBe('Zavřít LONG 2 · bez SL/TP');
    // Napojení: klik pustí fokus a jde jen přes automat panelu (`createLiveBareClosePanelClick`).
    const ticket = source('components/LiveOrderTicket.tsx');
    const click = between(ticket, 'const clickBareClose = (event', 'const bareCloseView =');
    expect(click).toMatch(/event\.currentTarget\.blur\(\);/);
    expect(click).toMatch(/const sent = bareClosePanelClick\(bareCloseOffer\);\s*if \(!sent \|\| !target\) return;/);
    expect(click).not.toMatch(/onBareClose/);
    expect(ticket).toMatch(/const bareCloseGate = useLiveClickGate\(\[bareCloseOffer\]\);/);
    expect(ticket).toMatch(/busy: \(\) => lockRef\.current \|\| attachBusyRef\.current \|\| directBusyRef\.current,/);
  });
});

describe('C8 UI: desk — tatáž cesta správy leadera, jen obchod, který uživatel viděl', () => {
  const desk = source('components/TradovateLiveDesk.tsx');
  it('closeBareLeader a cancelPendingEntries jsou z čisté továrny desku (testy chování níže)', () => {
    // Obal desku jen přidá bránu neověřené projekce a čekající čáru; odeslání zůstává v továrně.
    expect(desk).toMatch(/const closeBareLeader = useCallback\([\s\S]*?trackLiveChartIntent\(chartIntentStore, closeBareIntentDraft\([^\n]*\), \(\) => deskCommands\.closeBareLeader\(seen\)\)/);
    expect(desk).toMatch(/const cancelPendingEntries = deskCommands\.cancelPendingEntries;/);
    expect(desk).toMatch(/const sendLeaderManage = deskCommands\.sendLeaderManage;/);
    const factory = source('lib/liveDeskCommands.ts');
    expect(factory).not.toMatch(/executeTradovate|fetch\(|services\/|retry|\bwhile\b/);
  });
  it('jediné relay odeslání správy je sendLeaderManage (manage, attach, × holé pozice, Zrušit čekající)', () => {
    // place-leader-entry (vstup) zvlášť; správa jen přes `relay` továrny — žádná třetí kopie.
    expect(desk.match(/executeTradovateCopierRelayCommand\(route\.relayConnectionId, \{ type: 'copy-command', command \}\)/g) ?? []).toHaveLength(1);
    expect(desk.match(/relay: \(relayId, command\) => executeTradovateCopierRelayCommand\(relayId, \{ type: 'copy-command', command \}\),/g) ?? []).toHaveLength(1);
    expect(between(desk, 'const sendManageLeaderEntry = useCallback(', '// Telefon (2. 11. 2026):')).toMatch(/return sendLeaderManage\(command,/);
    expect(between(desk, 'const sendAttachBrackets = useCallback(', '// C8 (4. 11. 2026):')).toMatch(/return sendLeaderManage\(command,/);
    expect(between(desk, 'const sendManageLeaderEntry = useCallback(', '// Telefon (2. 11. 2026):')).toMatch(/if \(groupTrade && action === 'close-position'\)[\s\S]*return manageGroupLimitPosition\(/);
    expect(between(desk, 'const sendAttachBrackets = useCallback(', '// C8 (4. 11. 2026):')).toMatch(/if \(groupTrade\) return manageGroupLimitPosition\(/);
    expect(desk).toContain('{...(supportsCopierManualOrderCloseBare(agentStatus) || groupLimitLegDisplay != null ? { onBareClose: closeBareLeader } : {})}');
    expect(desk).toContain('...(supportsCopierManualOrderCloseBare(agentStatus) || groupLimitLegDisplay != null ? { bareClose: bareCloseOffer, closeBare: closeBareLeader } : {}),');
  });
});

describe('C8 UI: telefon — „Zavřít“ holé pozice vedle Flattenu', () => {
  const offer = liveBareCloseOffer(offerInput())!;
  const bar = (patch: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(LivePhonePositionBar, {
    guard: createLivePhoneBarGuard(), onSwallowed: () => {},
    side: 'long', quantity: 2, symbol: 'MNQZ6', unprotected: true, busy: false, onAttach: () => {}, onClose: () => {}, ...patch,
  }));
  it('zdroj lišty: obě tlačítka pouští fokus, vibrace až po odeslání, pojistku vlastní rodič', () => {
    const actions = source('components/day/LivePhoneLiveActions.tsx');
    const click = between(actions, 'data-live-bare-close', '>Zavřít</button>');
    expect(click).toMatch(/event\.currentTarget\.blur\(\);\s*const step = guard\.bare\(bare\);\s*if \(step === 'changed'\) \{ onSwallowed\(\); return; \}\s*if \(step === 'send'\) playNativeHapticIfAvailable/);
    const flatten = between(actions, 'data-live-bar-flatten', '>{pending ?');
    expect(flatten).toMatch(/const step = guard\.flatten\(pending \? 'cancel' : 'flatten'\);\s*if \(step === 'changed'\) \{ onSwallowed\(\); return; \}\s*if \(step !== 'send'\) return;\s*playNativeHapticIfAvailable\('medium'\);\s*onClose\(\);/);
    const phone = source('components/day/LivePhoneChart.tsx');
    expect(phone).toMatch(/const barGuard = useLivePhoneBarGuard\(\s*position \? \(position\.pending \? 'cancel' : 'flatten'\) : null,/);
    expect(phone).toContain('onSwallowed={() => say(LIVE_ACTION_CHANGED_TEXT)}');
  });

  it('s nabídkou: Zavřít (C8) i Flatten; holá pozice bez nabídky / v přehrávání = vždy „Flatten“', () => {
    const html = bar({ bareClose: offer, onBareClose: () => {} });
    expect(html).toContain('data-live-bare-close');
    expect(html).toContain('>Zavřít</button>');
    expect(html).toContain('>Flatten</button>');
    // Holá pozice bez nabídky (starý worker, přehrávání): jen Flatten, žádné „Zavřít“.
    const legacy = bar();
    expect(legacy).not.toContain('data-live-bare-close');
    expect(legacy).toContain('>Flatten</button>');
    expect(legacy).not.toContain('>Zavřít</button>');
    expect(legacy).toContain('aria-label="Flatten — zavřít vše"');
    // Spravovaná pozice (SL/TP) beze změny: „Zavřít“ (Flatten).
    const managed = bar({ unprotected: false });
    expect(managed).toContain('>Zavřít</button>');
    expect(managed).toContain('aria-label="Zavřít pozici (Flatten)"');
    // Čekající vstup nikdy nenabízí × holé pozice.
    expect(bar({ bareClose: offer, onBareClose: () => {}, pending: { type: 'Limit', price: 1 } })).not.toContain('data-live-bare-close');
  });
  it('graf: Zavřít jen s nabídkou, mimo přehrávání, přes sdílený zámek čar a s kontrolou klíče', () => {
    const phone = source('components/day/LivePhoneChart.tsx');
    expect(phone).toMatch(/bareClose=\{!replay && trade\?\.closeBare \? trade\.bareClose \?\? null : null\}/);
    const run = between(phone, 'const barBareCloseRun = useMemo(() => createLiveBareCloseRun({', '}), [lineState.busyRef, lineState.setPendingMove]);');
    expect(run).toMatch(/busyRef: lineState\.busyRef,/);
    const click = between(phone, 'const barBareClose = (key: string) => {', 'void barBareCloseRun(offer.trade);');
    expect(click).toMatch(/!offer \|\| offer\.key !== key/);
    expect(click).toMatch(/if \(!offer\.enabled\)/);
    // Flatten zůstává mimo zámek (beze změny).
    expect(phone).toMatch(/onClose=\{\(\) => \{ void barClose\(position\); \}\}/);
  });
});

// ---------------------------------------------------------------------------
// C7 — Zrušit čekající

describe('C7 UI: pohled „Zrušit čekající“', () => {
  it('jen s capability a aspoň jedním vlastním čekajícím vstupem; text kolik a čeho', () => {
    expect(liveCancelPendingView(viewInput({ capability: false }))).toBeNull();
    expect(liveCancelPendingView(viewInput({ entries: [] }))).toBeNull();
    expect(liveCancelPendingView(viewInput({ entries: null }))).toBeNull();
    const view = liveCancelPendingView(viewInput())!;
    expect(view).toMatchObject({ enabled: true, reason: null, label: 'Zrušit čekající (2)' });
    expect(view.confirmText).toMatch(/^Zrušit 2 čekající vstupy\?/);
    expect(view.confirmText).toMatch(/Cizí příkazy: 1/);
    expect(view.key).toContain(view.entries[0].entryOperationId);
  });
  it('zastaralý / obnovený stav, bez relaye, blokace workeru, přehrávání = neaktivní s důvodem', () => {
    expect(liveCancelPendingView(viewInput({ statusFresh: false }))).toMatchObject({ enabled: false, reason: expect.stringMatching(/ověřuje/) });
    expect(liveCancelPendingView(viewInput({ restored: true }))).toMatchObject({ enabled: false });
    expect(liveCancelPendingView(viewInput({ relayConnected: false }))).toMatchObject({ enabled: false, reason: expect.stringMatching(/relay/) });
    expect(liveCancelPendingView(viewInput({ context: { ...CONTEXT, blockedReason: 'Nevyřešený vstup.' } }))).toMatchObject({ enabled: false, reason: 'Nevyřešený vstup.' });
    expect(liveCancelPendingView(viewInput({ replay: true }))).toMatchObject({ enabled: false, reason: expect.stringMatching(/Přehrávání/) });
  });
  it('desk před odesláním: potvrzená sada musí být pořád v čerstvém statusu (id, cena, počet)', () => {
    const shown = [entry('101'), entry('102', { price: 24_980 })];
    expect(cancelPendingSeenProblem([shown[0]], shown)).toBeNull();
    expect(cancelPendingSeenProblem(shown, shown)).toBeNull();
    expect(cancelPendingSeenProblem([entry('101', { price: 24_995 })], shown)).toMatch(/změnily — nic se neodeslalo/);
    expect(cancelPendingSeenProblem([entry('101', { quantity: 2 })], shown)).toMatch(/změnily/);
    expect(cancelPendingSeenProblem([entry('103')], shown)).toMatch(/změnily/);
    expect(cancelPendingSeenProblem([shown[0]], null)).toMatch(/změnily/);
    expect(cancelPendingSeenProblem([], shown)).toMatch(/Nebylo co zrušit/);
    // Status bez sanitizace: objekt místo pole / null prvek = nic neodpovídá (nic se neodešle), ne pád.
    expect(cancelPendingSeenProblem([shown[0]], { 0: shown[0] })).toMatch(/změnily/);
    expect(cancelPendingSeenProblem([shown[0]], [null, shown[0]])).toBeNull();
  });
});

describe('C7 UI: běh se sdíleným zámkem, výsledek po položkách, nic se neopakuje', () => {
  const item = (outcome: CancelPendingItemResult['outcome'], text: string, id = '101'): CancelPendingItemResult => ({ entry: entry(id), operationId: `manage:${id}0000000`, outcome, text });
  const setup = (busy = false) => {
    const busyRef = { current: busy };
    const cancel = vi.fn(async (_entries: readonly PendingOwnEntry[]) => [item('canceled', 'Zrušeno.')]);
    const report = vi.fn();
    const run = createLiveCancelPendingRun({ cancel: () => cancel, busyRef, report });
    return { busyRef, cancel, report, run };
  };
  it('zámek obsazený → nic; prázdná sada / chybějící cesta → nic', async () => {
    const busy = setup(true);
    expect(await busy.run([entry('101')])).toMatchObject({ called: false });
    expect(busy.cancel).not.toHaveBeenCalled();
    expect(busy.report.mock.calls[0][0].text).toMatch(/nic se neodeslalo/);
    const empty = setup(false);
    expect(await empty.run([])).toMatchObject({ called: false });
    expect(empty.cancel).not.toHaveBeenCalled();
    const missing = createLiveCancelPendingRun({ cancel: () => null, busyRef: { current: false }, report: () => {} });
    expect(await missing([entry('101')])).toMatchObject({ called: false });
  });
  it('volný zámek → jediné volání desku se sadou, kterou uživatel viděl; zámek drží po dobu letu', async () => {
    const { run, cancel, busyRef } = setup(false);
    let lockedDuring = false;
    cancel.mockImplementation(async () => { lockedDuring = busyRef.current; return [item('canceled', 'Zrušeno.')]; });
    const entries = [entry('101'), entry('102')];
    const outcome = await run(entries);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(entries);
    expect(lockedDuring).toBe(true);
    expect(busyRef.current).toBe(false);
    expect(outcome.notice).toMatchObject({ tone: 'ok', text: 'Zrušeno 1 z 1.' });
  });
  it('vyplnění během rušení = nikdy „zrušeno“ (tón bad); výjimka: neodesláno vs. neznámé', async () => {
    const filled = setup(false);
    filled.cancel.mockImplementation(async () => [item('canceled', 'Zrušeno.'), item('filled', 'Vstup se vyplnil (1) dřív, než ho broker zrušil.', '102')]);
    expect((await filled.run([entry('101'), entry('102')])).notice).toMatchObject({ tone: 'bad', text: expect.stringMatching(/^Zrušeno 1 z 2\. Vstup se vyplnil/) });
    const notSent = setup(false);
    notSent.cancel.mockImplementation(async () => { throw new Error('Čekající vstupy se mezitím změnily — nic se neodeslalo.'); });
    expect((await notSent.run([entry('101')])).notice.text).toMatch(/^Neodesláno/);
    const unknown = setup(false);
    unknown.cancel.mockImplementation(async () => { throw new Error('relay timeout'); });
    expect((await unknown.run([entry('101')])).notice).toMatchObject({ tone: 'warn', text: expect.stringMatching(/^Výsledek neznámý/) });
    expect(unknown.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('C7 UI: Dashboard „Zrušit“ jen přes dashboardCancelTarget', () => {
  const input = (patch: Partial<LiveDashboardPendingCancel> = {}): LiveDashboardPendingCancel => ({
    capability: true, leaderAccountId: 7, entries: [entry('101')], statusFresh: true, restored: false, relayConnected: true,
    lockRef: { current: false }, cancel: vi.fn(async () => []), ...patch,
  });
  const own = { accountId: 7, id: 101, working: true };
  it('vlastní čekající vstup leadera = zrušit (klíč s id cíle); jinak zamčeno s vysvětlením; nepracující = nic', () => {
    expect(dashboardOrderCancelView(own, input())).toMatchObject({ kind: 'cancel', entry: { entryBrokerOrderId: '101' }, key: expect.stringContaining('entry:101') });
    expect(dashboardOrderCancelView({ ...own, working: false }, input())).toEqual({ kind: 'hidden' });
    expect(dashboardOrderCancelView(own, null)).toEqual({ kind: 'locked', reason: DASHBOARD_CANCEL_OLD_WORKER });
    expect(dashboardOrderCancelView(own, input({ capability: false }))).toEqual({ kind: 'locked', reason: DASHBOARD_CANCEL_OLD_WORKER });
    // Follower, SL/TP noha (jiné id), cizí příkaz = nikdy zrušit.
    expect(dashboardOrderCancelView({ ...own, accountId: 8 }, input())).toEqual({ kind: 'locked', reason: DASHBOARD_CANCEL_NOT_OWN });
    expect(dashboardOrderCancelView({ ...own, id: 999 }, input())).toEqual({ kind: 'locked', reason: DASHBOARD_CANCEL_NOT_OWN });
    for (const patch of [{ statusFresh: false }, { restored: true }, { relayConnected: false }]) {
      expect(dashboardOrderCancelView(own, input(patch))).toEqual({ kind: 'locked', reason: DASHBOARD_CANCEL_VERIFYING });
    }
  });
  it('render: zamčené tlačítko disabled s důvodem, vlastní vstup aktivní; žádné cancel-order v přehledu', () => {
    const locked = renderToStaticMarkup(React.createElement(DashboardOrderCancelButton, { order: own, cancel: input({ capability: false }) }));
    expect(locked).toContain('disabled=""');
    expect(locked).toContain('Worker zatím neumí');
    const active = renderToStaticMarkup(React.createElement(DashboardOrderCancelButton, { order: own, cancel: input() }));
    expect(active).toContain('data-dashboard-cancel-entry');
    expect(active).not.toContain('disabled=""');
    expect(renderToStaticMarkup(React.createElement(DashboardOrderCancelButton, { order: { ...own, working: false }, cancel: input() }))).toBe('');
    const overview = source('components/LiveCopyTradeOverview.tsx');
    expect(overview).not.toMatch(/command: \{ type: 'cancel-order'/);
    expect(overview).not.toMatch(/onCancelOrder/);
    expect(overview.match(/<DashboardOrderCancelButton /g)).toHaveLength(2);
    expect(overview.match(/pendingEntryCancel=\{dashboardPendingCancelForGroup\(pendingEntryCancel, group\.id, executionGroupId\)\}/g)).toHaveLength(1);
    expect(overview).toContain('pendingEntryCancel: dashboardPendingCancelForGroup(pendingEntryCancel, group.id, executionGroupId),');
  });
});

describe('C7 UI: PC lišta pod grafem vedle Flatten a telefon', () => {
  const coordinator = createFlattenGroupCoordinator();
  const target = { id: 'g', name: 'Test', accountIds: [7], observedAt: 1_000, verified: true };
  it('lišta: tlačítko jen s pohledem; neaktivní s důvodem; Flatten All dál bez zámku', () => {
    const view = liveCancelPendingView(viewInput())!;
    const html = renderToStaticMarkup(React.createElement(LiveSafetyControls, {
      target, onAction: vi.fn(), flattenCoordinator: coordinator, copierArmed: true,
      cancelPending: { view, lockRef: { current: true }, cancel: vi.fn() },
    }));
    expect(html).toContain('Zrušit čekající (2)');
    expect(html).toContain('Flatten All');
    expect(html).not.toContain('disabled=""');
    const disabled = renderToStaticMarkup(React.createElement(LiveSafetyControls, {
      target, onAction: vi.fn(), flattenCoordinator: coordinator, copierArmed: true,
      cancelPending: { view: liveCancelPendingView(viewInput({ statusFresh: false }))!, lockRef: { current: false }, cancel: vi.fn() },
    }));
    expect((disabled.match(/disabled=""/g) ?? []).length).toBe(1);
    expect(disabled).toContain('Zrušit čekající: Stav kopírky se ověřuje');
    const none = renderToStaticMarkup(React.createElement(LiveSafetyControls, { target, onAction: vi.fn(), flattenCoordinator: coordinator, copierArmed: true }));
    expect(none).not.toContain('data-live-cancel-pending');
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk).toMatch(/cancelPending=\{chartAvailable && cancelPendingBarView \? \{ view: cancelPendingBarView, lockRef: liveCommandLockRef, cancel: cancelPendingEntries \} : null\}/);
    expect(desk).toMatch(/manageLockRef=\{liveCommandLockRef\}/);
    expect(desk).toMatch(/lockRef: liveCommandLockRef, cancel: cancelPendingEntries,/);
  });
  it('C7 (lišta, telefon, Dashboard): hook jen napojí pojistku (`createLiveCancelPendingClick`)', () => {
    const pending = source('components/LivePendingCancel.tsx');
    const hook = between(pending, 'export function useLiveCancelPendingAction(', '/** Odkaz na deskový zámek');
    expect(hook).toMatch(/const gate = useLiveClickGate\(\[view\]\);/);
    expect(hook).toMatch(/event\?\.currentTarget\.blur\(\);\s*void click\(view\);/);
    expect(hook).toMatch(/run: createLiveCancelPendingRun\(\{ cancel: \(\) => cancelRef\.current, busyRef: input\.lockRef, setBusy, report \}\),/);
    expect(hook).not.toMatch(/liveConfirmClick|cancel\(|cancelRef\.current\(/);
    const runs = source('hooks/liveCommandRuns.ts');
    expect(runs).not.toMatch(/fetch\(|executeTradovate|services\/|buildLeaderOrderManageCommand|crypto\.|\bwhile\b|\bfor\s*\(|retry|setTimeout/);
  });

  it('telefon: čip s textem, mimo přehrávání, sdílený zámek čar', () => {
    const view = liveCancelPendingView(viewInput())!;
    const html = renderToStaticMarkup(React.createElement(LivePhoneCancelPendingChip, { view, lockRef: { current: false }, cancel: vi.fn(), top: 8, onNotice: () => {} }));
    expect(html).toContain('Zrušit čekající (2)');
    const phone = source('components/day/LivePhoneChart.tsx');
    expect(phone).toMatch(/\{!replay && cancelPendingChip && trade\?\.cancelPending && trade\.cancelPendingEntries && <LivePhoneCancelPendingChip/);
    expect(between(phone, '<LivePhoneCancelPendingChip', '/>')).toMatch(/lockRef=\{lineState\.busyRef\}/);
  });

  it('telefon: čip se schová JEN když lišta pozice ruší cíleně tentýž jediný vstup (kolo 2)', () => {
    const one = liveCancelPendingView(viewInput({ entries: [entry('101')] }))!;
    const position = { side: 'long' as const, quantity: 1, symbol: 'MNQZ6', bareEntryOperationId: null, pending: { type: 'Limit', price: 24_990 } };
    const input = { cancelPending: one, canCancel: true, barManage: true, position };
    // Lišta s `manage` ruší přesně tento vstup (cancel-entry) → čip by byl dvakrát totéž.
    expect(livePhoneCancelPendingChipShown(input)).toBe(false);
    // Bez `manage` by „Zrušit“ lišty spustilo Flatten skupiny → cílené C7 musí zůstat na grafu.
    expect(livePhoneCancelPendingChipShown({ ...input, barManage: false })).toBe(true);
    // Čekající příkaz lišty není tentýž vstup (cena, strana, kontrakt, počet, neznámá cena).
    expect(livePhoneCancelPendingChipShown({ ...input, position: { ...position, pending: { type: 'Limit', price: 24_980 } } })).toBe(true);
    expect(livePhoneCancelPendingChipShown({ ...input, position: { ...position, pending: { type: 'Limit', price: null } } })).toBe(true);
    expect(livePhoneCancelPendingChipShown({ ...input, position: { ...position, side: 'short' } })).toBe(true);
    expect(livePhoneCancelPendingChipShown({ ...input, position: { ...position, symbol: 'MNQH7' } })).toBe(true);
    expect(livePhoneCancelPendingChipShown({ ...input, position: { ...position, quantity: 2 } })).toBe(true);
    // Otevřená pozice (lišta = Flatten), žádná lišta, dva čekající = čip.
    expect(livePhoneCancelPendingChipShown({ ...input, position: { ...position, pending: null } })).toBe(true);
    expect(livePhoneCancelPendingChipShown({ ...input, position: null })).toBe(true);
    expect(livePhoneCancelPendingChipShown({ ...input, cancelPending: liveCancelPendingView(viewInput())! })).toBe(true);
    // Bez pohledu nebo bez deskové cesty čip nikdy.
    expect(livePhoneCancelPendingChipShown({ ...input, cancelPending: null, barManage: false })).toBe(false);
    expect(livePhoneCancelPendingChipShown({ ...input, canCancel: false, barManage: false })).toBe(false);
    const phone = source('components/day/LivePhoneChart.tsx');
    expect(phone).toMatch(/const cancelPendingChip = livePhoneCancelPendingChipShown\(\{\s*cancelPending: trade\?\.cancelPending, canCancel: trade\?\.cancelPendingEntries != null, barManage: trade\?\.manage != null, position,/);
  });
});

// ---------------------------------------------------------------------------
// Oponentura UI C7/C8 kolo 1 — opravy (4. 11. 2026)

const clock = (start = 0) => {
  let at = start;
  return { now: () => at, set: (next: number) => { at = next; } };
};

describe('pojistka kliku (createLiveClickGate)', () => {
  const target = (patch = {}) => ({ key: 'k', enabled: true, reason: null, ...patch });
  it('první klik send; dvojklik repeat; bušení kotvu posouvá; po pauze send', () => {
    const time = clock();
    const gate = createLiveClickGate({ now: time.now });
    expect(gate.click(target()).kind).toBe('send');
    expect(gate.click(target()).kind).toBe('repeat');
    time.set(300); expect(gate.click(target()).kind).toBe('repeat');
    time.set(600); expect(gate.click(target()).kind).toBe('repeat');
    time.set(1_100); expect(gate.click(target()).kind).toBe('send');
  });
  it('jiný klíč není dvojklik; změna nabídky spolkne klik na 1 s', () => {
    const time = clock();
    const gate = createLiveClickGate({ now: time.now });
    gate.sync([target()]);
    expect(gate.click(target()).kind).toBe('send');
    expect(gate.click(target({ key: 'other' })).kind).toBe('send');
    time.set(2_000);
    gate.sync([target({ key: 'filled' })]);
    time.set(2_999); expect(gate.click(target({ key: 'filled' })).kind).toBe('changed');
    time.set(3_000); expect(gate.click(target({ key: 'filled' })).kind).toBe('send');
  });
  it('první sync nic nespolkne; zablokování se stejným klíčem není změna', () => {
    const time = clock(5_000);
    const gate = createLiveClickGate({ now: time.now });
    gate.sync([target()]);
    expect(gate.click(target()).kind).toBe('send');
    time.set(6_000);
    gate.sync([target({ enabled: false })]);
    gate.sync([target()]);
    expect(gate.click(target()).kind).toBe('send');
  });
  it('zablokováno, busy, zmizelo = nikdy send', () => {
    const gate = createLiveClickGate({ now: clock().now });
    expect(gate.click(target({ enabled: false, reason: 'Zastaralý stav.' }))).toEqual({ kind: 'blocked', reason: 'Zastaralý stav.' });
    expect(gate.click(target(), { busy: true }).kind).toBe('busy');
    expect(gate.click(undefined).kind).toBe('missing');
    expect(gate.click(target()).kind).toBe('send');
  });
});

describe('(a) „Zrušit čekající“ / Dashboard: klik → pojistka → běh se zámkem (bez Reactu)', () => {
  const setup = (lock = false) => {
    const time = clock();
    const gate = createLiveClickGate({ now: time.now });
    const lockRef = { current: lock };
    const cancel = vi.fn(async (entries: readonly PendingOwnEntry[]) => entries.map(item => ({ entry: item, operationId: 'manage:000000000001', outcome: 'canceled' as const, text: 'Zrušeno.' })));
    const report = vi.fn();
    const run = createLiveCancelPendingRun({ cancel: () => cancel, busyRef: lockRef, report, now: time.now });
    const click = createLiveCancelPendingClick({ gate, run, report, now: time.now });
    return { time, gate, lockRef, cancel, report, click };
  };
  const view = (patch: Partial<Parameters<typeof liveCancelPendingView>[0]> = {}) => liveCancelPendingView(viewInput(patch))!;

  it('první klik pošle PRÁVĚ jednou sadu, kterou uživatel viděl; dvojklik nic dalšího', async () => {
    const t = setup();
    const shown = view();
    await t.click(shown);
    expect(t.click(shown)).toBeNull();
    expect(t.cancel).toHaveBeenCalledTimes(1);
    expect(t.cancel).toHaveBeenCalledWith(shown.entries);
  });
  it('sada se změní do 1 s před klikem: nic neodejde, text to řekne; pak odejde nová', async () => {
    const t = setup();
    t.gate.sync([view()]);
    t.time.set(5_000);
    const next = view({ entries: [entry('101')] });
    t.gate.sync([next]);
    t.time.set(5_500);
    expect(t.click(next)).toBeNull();
    expect(t.report.mock.calls.at(-1)?.[0].text).toBe(LIVE_ACTION_CHANGED_TEXT);
    expect(t.cancel).not.toHaveBeenCalled();
    t.time.set(6_100);
    await t.click(next);
    expect(t.cancel).toHaveBeenCalledWith(next.entries);
  });
  it('klik na zablokovaný pohled = jen důvod, nic se neodeslalo', () => {
    const t = setup();
    expect(t.click(view({ context: { ...CONTEXT, blockedReason: 'Nevyřešený ruční vstup.' } }))).toBeNull();
    expect(t.report.mock.calls.at(-1)?.[0].text).toBe('Nevyřešený ruční vstup. Nic se neodeslalo.');
    expect(t.cancel).not.toHaveBeenCalled();
  });
  it('zámek drží jiný příkaz → klik Dashboardu nic nepošle', async () => {
    const t = setup(true);
    expect(await t.click(view())).toMatchObject({ called: false });
    expect(t.cancel).not.toHaveBeenCalled();
    expect(t.report.mock.calls.at(-1)?.[0].text).toBe(LIVE_COMMAND_BUSY_TEXT);
  });
  it('(e) výsledek přijde až po zmizení nabídky: ohlásí se, nic dalšího neodejde', async () => {
    const t = setup();
    let resolve!: (value: CancelPendingItemResult[]) => void;
    t.cancel.mockImplementation(() => new Promise<CancelPendingItemResult[]>(done => { resolve = done; }) as never);
    const shown = view();
    const flight = t.click(shown)!;
    expect(t.lockRef.current).toBe(true);
    t.gate.sync([null]);
    t.time.set(900);
    expect(t.click(null)).toBeNull();
    resolve(shown.entries.map(item => ({ entry: item, operationId: 'manage:000000000001', outcome: 'canceled', text: 'Zrušeno.' })));
    expect((await flight).notice.text).toBe('Zrušeno 2 z 2.');
    expect(t.cancel).toHaveBeenCalledTimes(1);
    expect(t.lockRef.current).toBe(false);
  });
});

describe('(b) × holé pozice v panelu PC (createLiveBareClosePanelClick)', () => {
  const setup = () => {
    const time = clock();
    const gate = createLiveClickGate({ now: time.now });
    const busy = { current: false };
    const close = vi.fn(async (_id: string) => ({ called: true, status: 'acknowledged' as const, notice: { tone: 'ok' as const, text: 'ok', at: 1 } }));
    const report = vi.fn();
    const click = createLiveBareClosePanelClick({ gate, busy: () => busy.current, close: () => close, report, now: time.now });
    return { time, gate, busy, close, report, click };
  };
  const offer = (patch: Partial<Parameters<typeof liveBareCloseOffer>[0]> = {}) => liveBareCloseOffer(offerInput(patch));

  it('první klik → právě jedno close s id cíle; dvojklik nic dalšího', async () => {
    const t = setup();
    await t.click(offer());
    expect(t.click(offer())).toBeNull();
    expect(t.close).toHaveBeenCalledTimes(1);
    expect(t.close).toHaveBeenCalledWith(TRADE.entryOperationId);
  });
  it('klik na zablokovanou nabídku = důvod „Nic se neodeslalo“; zmizelá nabídka = nic', () => {
    const t = setup();
    expect(t.click(offer({ armed: false }))).toBeNull();
    expect(t.report.mock.calls.at(-1)?.[1].text).toMatch(/Flattenem\. Nic se neodeslalo\.$/);
    expect(t.click(null)).toBeNull();
    expect(t.close).not.toHaveBeenCalled();
  });
  it('attach / vstup / jiný příkaz pod sdíleným zámkem v letu = nic, text „Čeká se…“', () => {
    const t = setup();
    t.busy.current = true;
    expect(t.click(offer())).toBeNull();
    expect(t.report.mock.calls.at(-1)?.[1]).toMatchObject({ tone: 'warn', text: LIVE_COMMAND_BUSY_TEXT });
    expect(t.close).not.toHaveBeenCalled();
  });
  it('jiný holý vstup do 1 s před klikem (jiné id cíle) nic nepošle', () => {
    const t = setup();
    t.gate.sync([offer()]);
    t.time.set(5_000);
    const other = offer({ trade: { ...TRADE, entryOperationId: 'entry:other0000001' }, position: LONG2 });
    t.gate.sync([other]);
    t.time.set(5_500);
    expect(t.click(other)).toBeNull();
    expect(t.report.mock.calls.at(-1)?.[1]).toMatchObject({ tone: 'warn', text: LIVE_ACTION_CHANGED_TEXT });
    expect(t.close).not.toHaveBeenCalled();
  });
});

describe('(c) telefonní lišta: Flatten i „Zavřít“ holé pozice', () => {
  const offer = liveBareCloseOffer(offerInput())!;
  const setup = (start = 0) => {
    const time = clock(start);
    return { time, guard: createLivePhoneBarGuard({ now: time.now }) };
  };
  it('první klepnutí odesílá; dvojklepnutí jeden příkaz; druhé tlačítko je jiný příkaz', () => {
    const { guard } = setup();
    guard.sync('flatten', offer);
    expect(guard.bare(offer)).toBe('send');
    expect(guard.bare(offer)).toBe('none');
    expect(guard.flatten('flatten')).toBe('send');
    expect(guard.flatten('flatten')).toBe('repeat');
  });
  it('zablokovaná nabídka = blocked (rodič jen řekne důvod)', () => {
    const { guard } = setup();
    expect(guard.bare(liveBareCloseOffer(offerInput({ killSwitch: true }))!)).toBe('blocked');
  });
  it('Zrušit → Flatten: spolkne se 1 s, i přes stav bez pozice (složení pending → null → pozice)', () => {
    const { time, guard } = setup();
    guard.sync('cancel', null);
    time.set(5_000);
    guard.sync(null, null);
    time.set(7_000);
    guard.sync('flatten', null);
    time.set(7_999);
    expect(guard.flatten('flatten')).toBe('changed');
    time.set(8_000);
    expect(guard.flatten('flatten')).toBe('send');
  });
  it('pozice → pozice nikdy nespolkne: změna počtu, nová pozice, Flatten → Zrušit', () => {
    const { time, guard } = setup();
    guard.sync(null, null);
    time.set(1_000);
    guard.sync('flatten', null); // nová pozice po vstupu
    expect(guard.flatten('flatten')).toBe('send');
    time.set(2_000);
    guard.sync('flatten', null); // změna počtu je týž význam
    expect(guard.flatten('flatten')).toBe('send');
    time.set(3_000);
    guard.sync('cancel', null);
    expect(guard.flatten('cancel')).toBe('send');
  });
  it('změna nabídky C8 Flatten nezdrží, ale „Zavřít“ spolkne', () => {
    const { time, guard } = setup();
    guard.sync('flatten', offer);
    time.set(5_000);
    const other = { ...offer, key: `${offer.key}:jina` };
    guard.sync('flatten', other);
    time.set(5_500);
    expect(guard.bare(other)).toBe('changed');
    expect(guard.flatten('flatten')).toBe('send');
  });
});

describe('(d) deskové brány (createLiveDeskCommands): nic se neodešle, co uživatel neviděl', () => {
  const ENTRY_A = entry('101');
  const ENTRY_B = entry('102', { price: 24_980 });
  const status = (patch: { capabilities?: string[]; bareLeaderTrade?: BareLeaderTrade | null; pendingOwnEntries?: unknown; retired?: boolean } = {}) => ({
    capabilities: patch.capabilities ?? ['manual-order-close-bare-v1', 'manual-order-cancel-pending-v1'],
    group: { id: 'group-main', leaderAccountId: 7 },
    controller: {
      bareLeaderTrade: patch.bareLeaderTrade === undefined ? TRADE : patch.bareLeaderTrade,
      pendingOwnEntries: patch.pendingOwnEntries === undefined ? [ENTRY_A, ENTRY_B] : patch.pendingOwnEntries,
      ...(patch.retired ? { retiredGroup: { groupId: 'group-main' } } : {}),
    },
  }) as unknown as LocalCopierAgentStatus;
  const setup = (initial = { status: status(), fresh: true }, route: string | null = 'relay-1') => {
    const state = { current: initial, route };
    const relay = vi.fn(async (_relayId: string, command: LeaderOrderManageCommand) => ({
      result: { type: 'leader-order-managed', operationId: command.operationId, action: command.action, status: 'acknowledged', checkedAt: 1, blockers: [] },
    }));
    let id = 0;
    const commands = createLiveDeskCommands({
      status: () => state.current, relayId: () => state.route, relay,
      newOperationId: () => `manage:${String(++id).padStart(12, '0')}`,
    });
    return { state, relay, commands };
  };
  it('capability manual-order-close-bare-v1 / cancel-pending-v1 odpovídají capability workeru', () => {
    // Test stojí na řetězcích capability; když se změní, test musí spadnout (ne tiše projít bez odeslání).
    const cap = source('lib/copierWorkerCapabilities.ts');
    expect(cap).toMatch(/'manual-order-close-bare-v1'/);
    expect(cap).toMatch(/'manual-order-cancel-pending-v1'/);
  });
  it('× holé pozice: šťastná cesta = právě jedno relay odeslání close-position na id cíle', async () => {
    const t = setup();
    await t.commands.closeBareLeader(TRADE);
    expect(t.relay).toHaveBeenCalledTimes(1);
    expect(t.relay.mock.calls[0][0]).toBe('relay-1');
    expect(t.relay.mock.calls[0][1]).toMatchObject({ groupId: 'group-main', leaderAccountId: 7, entryOperationId: TRADE.entryOperationId, action: 'close-position' });
  });
  it('× holé pozice: stav zastaral, capability zmizela, skupina retired, obchod se změnil, chybí relay → nic, nula volání relaye', async () => {
    const cases: Array<[Parameters<typeof setup>[0], string | null, RegExp]> = [
      [{ status: status(), fresh: false }, 'relay-1', /není čerstvě ověřený — nic se neodeslalo/],
      [{ status: status({ capabilities: ['manual-order-cancel-pending-v1'] }), fresh: true }, 'relay-1', /nic se neodeslalo/],
      [{ status: status({ retired: true }), fresh: true }, 'relay-1', /nic se neodeslalo/],
      [{ status: status({ bareLeaderTrade: { ...TRADE, quantity: 1 } }), fresh: true }, 'relay-1', /Holá pozice se mezitím změnila — nic se neodeslalo/],
      [{ status: status({ bareLeaderTrade: null }), fresh: true }, 'relay-1', /mezitím změnila/],
      [{ status: status(), fresh: true }, null, /jen přes relay — .*nic se neodeslalo/],
    ];
    for (const [initial, route, error] of cases) {
      const t = setup(initial, route);
      await expect(t.commands.closeBareLeader(TRADE)).rejects.toThrow(error);
      expect(t.relay).not.toHaveBeenCalled();
    }
  });
  it('Zrušit čekající: šťastná cesta = N× cancel-entry na stejné trase', async () => {
    const t = setup();
    const results = await t.commands.cancelPendingEntries([ENTRY_A, ENTRY_B]);
    expect(results.map(item => item.outcome)).toEqual(['canceled', 'canceled']);
    expect(t.relay).toHaveBeenCalledTimes(2);
    expect(t.relay.mock.calls.map(call => call[0])).toEqual(['relay-1', 'relay-1']);
    expect(t.relay.mock.calls.map(call => call[1].action)).toEqual(['cancel-entry', 'cancel-entry']);
  });
  it('Zrušit čekající: stav zastaral, capability zmizela, sada se změnila (cena, fill, objekt místo pole), chybí relay → nic', async () => {
    const cases: Array<[Parameters<typeof setup>[0], string | null, RegExp]> = [
      [{ status: status(), fresh: false }, 'relay-1', /není čerstvě ověřený/],
      [{ status: status({ capabilities: ['manual-order-close-bare-v1'] }), fresh: true }, 'relay-1', /nic se neodeslalo/],
      [{ status: status({ pendingOwnEntries: [ENTRY_A, { ...ENTRY_B, price: 24_985 }] }), fresh: true }, 'relay-1', /změnily — nic se neodeslalo/],
      [{ status: status({ pendingOwnEntries: [ENTRY_B] }), fresh: true }, 'relay-1', /změnily/],
      [{ status: status({ pendingOwnEntries: { 0: ENTRY_A, 1: ENTRY_B } }), fresh: true }, 'relay-1', /změnily/],
      [{ status: status(), fresh: true }, null, /jen přes relay/],
    ];
    for (const [initial, route, error] of cases) {
      const t = setup(initial, route);
      await expect(t.commands.cancelPendingEntries([ENTRY_A, ENTRY_B])).rejects.toThrow(error);
      expect(t.relay).not.toHaveBeenCalled();
    }
  });
  it('Zrušit čekající: trasa relaye zachycená jednou — změna uprostřed = zbytek „Neodesláno“, nic na jinou trasu', async () => {
    const t = setup();
    t.relay.mockImplementationOnce(async (_relayId, command) => {
      t.state.route = 'relay-2'; // druhé OAuth připojení / přepnutí připojení během sekvence
      return { result: { type: 'leader-order-managed', operationId: command.operationId, action: command.action, status: 'acknowledged', checkedAt: 1, blockers: [] } };
    });
    const results = await t.commands.cancelPendingEntries([ENTRY_A, ENTRY_B]);
    expect(t.relay).toHaveBeenCalledTimes(1);
    expect(t.relay.mock.calls[0][0]).toBe('relay-1');
    expect(results.map(item => item.outcome)).toEqual(['canceled', 'blocked']);
    expect(results[1].text).toContain(LIVE_DESK_ROUTE_CHANGED);
  });
  it('odpověď relaye bez výsledku = výjimka (neznámé), žádné druhé odeslání', async () => {
    const t = setup();
    t.relay.mockResolvedValueOnce({} as never);
    await expect(t.commands.closeBareLeader(TRADE)).rejects.toThrow(/Výsledek zavření chybí/);
    expect(t.relay).toHaveBeenCalledTimes(1);
    expect(LIVE_DESK_NOT_FRESH).toMatch(/nic se neodeslalo/);
  });
});

describe('(f) čáry grafu: první klik, dvojklik a změněná čára (liveLineClick)', () => {
  const summary = {
    kind: 'position', side: 'long', quantity: 2, entry: 25_000.25, stop: 24_990, target: 25_020, openPnl: 4, mark: 25_001.25, entryType: 'Market',
  } as unknown as LiveChartPositionSummary;
  const controls = { manageable: true, canClose: true, entryAvg: 25_000.25, pointValue: 2 };
  const filled = livePositionChartLines(summary, controls);
  const pending = livePositionChartLines({ ...summary, kind: 'pending', entryType: 'Limit' } as LiveChartPositionSummary, controls);
  const bare = livePositionChartLines({ ...summary, stop: null, target: null } as LiveChartPositionSummary, { manageable: false, entryAvg: null, pointValue: 2, bareClose: { entryOperationId: TRADE.entryOperationId } });
  const start = (lines: Parameters<typeof liveLineClickSync>[1], at = 0) => liveLineClickSync(LIVE_LINE_CLICK_INITIAL, lines, at);
  const key = (lines: typeof filled) => cancelConfirmKey(lines[0]);

  it('živé čáry nemají dvoukrok; první klik projde, dvojklik ne', () => {
    const withAdd = livePositionChartLines(summary, { ...controls, pendingAdd: { price: 24_995, quantity: 1, orderType: 'Limit' } });
    for (const lines of [filled, pending, bare, withAdd]) {
      for (const line of lines) {
        expect(line.confirmCancel).toBeUndefined();
        expect(line.actions?.some(action => action.confirm)).not.toBe(true);
      }
    }
    const state = start(filled);
    const first = liveLineClick(state, filled[0], key(filled), 5_000);
    expect(first.fire).toBe(true);
    expect(liveLineClick(first.next, filled[0], key(filled), 5_200).fire).toBe(false);
    expect(liveLineClick(first.next, filled[0], key(filled), 5_400).fire).toBe(true);
  });
  it('čekající → vyplněno: klik do 1 s po změně se spolkne, pak projde', () => {
    const state = liveLineClickSync(start(pending), filled, 3_000);
    expect(liveLineClick(state, filled[0], key(filled), 3_999).fire).toBe(false);
    expect(liveLineClick(state, filled[0], key(filled), 4_000).fire).toBe(true);
  });
  it('holá → spravovaná i změna přes stav bez čáry se spolknou', () => {
    const managed = liveLineClickSync(start(bare), filled, 3_000);
    expect(liveLineClick(managed, filled[0], key(filled), 3_500).fire).toBe(false);
    const gone = liveLineClickSync(liveLineClickSync(start(pending), [], 3_000), filled, 3_200);
    expect(liveLineClick(gone, filled[0], key(filled), 4_100).fire).toBe(false);
    expect(liveLineClick(gone, filled[0], key(filled), 4_200).fire).toBe(true);
  });
  it('přikoupení zmizí a pod kurzor dojede × pozice: spolkne se', () => {
    const withAdd = livePositionChartLines(summary, { ...controls, pendingAdd: { price: 24_995, quantity: 1, orderType: 'Limit' } });
    const state = liveLineClickSync(start(withAdd), filled, 3_000);
    expect(liveLineClick(state, filled[0], key(filled), 3_500).fire).toBe(false);
  });
  it('cena ani zablokování nejsou změna nabídky; první sync taky ne', () => {
    const state = start(filled, 3_000);
    expect(liveLineClick(state, filled[0], key(filled), 3_001).fire).toBe(true);
    const moved = filled.map(line => ({ ...line, price: line.price + 1 }));
    expect(liveLineClickSync(state, moved, 4_000)).toBe(state);
    const noBe = filled.map(line => ({ ...line, actions: line.actions?.map(action => ({ ...action, disabled: true })) }));
    expect(liveLineClickSync(state, noBe, 4_000)).toBe(state);
  });
  it('✎ a odesílaný posun (`pendingMove`) podpis nemění; změna nabídky je hlášená, dvojklik ne', () => {
    const state = start(filled, 3_000);
    const withPencil = filled.map(line => (line.kind === 'entry' ? line : { ...line, actions: [...(line.actions ?? []), { id: 'manage', label: '✎' }] }));
    expect(liveLineClickSync(state, withPencil, 4_000)).toBe(state);
    const sending = livePositionChartLines(summary, { ...controls, pending: { stopLoss: 24_995 } });
    expect(liveLineClickSync(state, sending, 4_000)).toBe(state);
    const changed = liveLineClickSync(start(pending), filled, 3_000);
    expect(liveLineClick(changed, filled[0], key(filled), 3_100).changed).toBe(true);
    const first = liveLineClick(state, filled[0], key(filled), 9_000);
    expect(liveLineClick(first.next, filled[0], key(filled), 9_100).changed).toBeUndefined();
    const overlay = source('components/BacktestOrderLinesOverlay.tsx');
    expect(overlay).toMatch(/if \(live\.changed\) onClickSwallowed\?\.\(\);/);
    expect(overlay).toMatch(/useLayoutEffect\(\(\) => \{ liveClickRef\.current = liveLineClickSync/);
    expect(source('hooks/useLiveClickGate.ts')).toMatch(/useLayoutEffect\(\(\) => \{ gate\.sync\(targets\); \}/);
    expect(source('components/LiveTradingScreen.tsx')).toContain("onOrderLineSwallowed: () => setLineNotice({ at: Date.now(), tone: 'warn', text: LIVE_ACTION_CHANGED_TEXT }),");
    expect(source('components/day/LivePhoneOrderLines.tsx')).toContain('onClickSwallowed={() => onNotice(LIVE_ACTION_CHANGED_TEXT)}');
    expect(source('components/AlphaTradeChartWorkspace.tsx')).toContain('onClickSwallowed={liveOrderEntry && orderLineSource === liveOrderEntry ? liveOrderEntry.onOrderLineSwallowed : undefined}');
  });
  it('overlay zůstává připojený i bez čar (složení pending → [] → position přežije)', () => {
    expect(source('components/AlphaTradeChartWorkspace.tsx')).not.toContain('panelOrderLines.length > 0 && orderLineSource');
    expect(source('components/day/LivePhoneOrderLines.tsx')).not.toContain('if (!lines.length) return null;');
    let state = start(pending);
    state = liveLineClickSync(state, [], 3_000);
    state = liveLineClickSync(state, filled, 5_000);
    expect(liveLineClick(state, filled[0], key(filled), 5_999).fire).toBe(false);
    expect(liveLineClick(state, filled[0], key(filled), 6_000).fire).toBe(true);
  });
  it('panel: velké tlačítko po neznámém výsledku zamčené; dvojklik i po rychlém ACK jeden vstup', () => {
    for (const status of ['acknowledged', 'rejected', 'blocked', 'abandoned'] as const) expect(liveDirectResultLocks({ status })).toBe(false);
    expect(liveDirectResultLocks({ status: 'unknown' } as never)).toBe(true);
    expect(liveDirectErrorLocks('relay timeout')).toBe(true);
    expect(liveDirectErrorLocks('entry-busy')).toBe(false);
    const ticket = source('components/LiveOrderTicket.tsx');
    expect(ticket).toContain('const directLockKey = `${String(group?.armed)}|${directKey}`;');
    expect(ticket).toContain('disabled={directBlocked != null || directBusy || directLocked}');
    expect(ticket).toContain('if (directBlocked != null || directLocked) return;');
    expect(ticket).toContain('if (liveDirectResultLocks(result)) setDirectLock(sentLockKey);');
    expect(ticket).toContain('if (liveDirectErrorLocks(message)) setDirectLock(sentLockKey);');
    const send = between(ticket, 'const sendDirect = async', 'directBusyRef.current = true;');
    expect(send).toMatch(/liveRepeatClick\(directClickRef\.current, liveBareConfirmKey\(previewDraft\), Date\.now\(\)\);\s*directClickRef\.current = step\.next;\s*if \(!step\.send\) return;/);
    const draft = { symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 25_000, stopLoss: 24_990, takeProfit: 25_020 } as const;
    expect(liveBareConfirmKey({ ...draft })).toBe(liveBareConfirmKey({ ...draft, stopLoss: 24_991 }));
    const first = liveRepeatClick(null, liveBareConfirmKey(draft), 1_000);
    expect(first.send).toBe(true);
    expect(liveRepeatClick(first.next, liveBareConfirmKey(draft), 1_150).send).toBe(false);
  });
  it('Posunout: odejde jen cena z tlačítka, změna průměru = hláška, nic', () => {
    const time = clock();
    const gate = createLiveClickGate({ now: time.now });
    gate.sync([{ key: liveMoveKey('takeProfit', 25_015), enabled: true }]);
    time.set(5_000);
    expect(liveMoveClick(gate, 'takeProfit', 25_015, 25_017.5).kind).toBe('changed');
    gate.sync([{ key: liveMoveKey('takeProfit', 25_017.5), enabled: true }]);
    time.set(5_500);
    expect(liveMoveClick(gate, 'takeProfit', 25_017.5, 25_017.5).kind).toBe('changed');
    time.set(6_000);
    expect(liveMoveClick(gate, 'takeProfit', 25_017.5, 25_017.5).kind).toBe('send');
    expect(liveMoveClick(gate, 'takeProfit', 25_017.5, 25_017.5).kind).toBe('repeat');
    const move = between(source('components/LiveOrderTicket.tsx'), 'const moveLeg = ', 'const runBreakEven = ');
    expect(move).toMatch(/liveMoveClick\(moveGates\[leg\], leg, moveShownPrices\[leg\], plan\.intent\.newPrice\)/);
    expect(move).toMatch(/if \(step\.kind === 'changed'\) \{ setManageNotice\(\{ tone: 'warn', text: LIVE_ACTION_CHANGED_TEXT, at \}\); return; \}\s*if \(step\.kind !== 'send'\) return;/);
  });
  it('Dashboard: klíč = id vstupu, cena klíč nemění; řádek musí být ten vstup', () => {
    const own = entry('101');
    const row = { accountId: 7, id: own.entryBrokerOrderId };
    const view = dashboardRowCancelView(row, own, { leaderAccountId: 7, blocked: false });
    expect(view).toMatchObject({ enabled: true, key: `dashboard-cancel:${own.entryOperationId}`, entries: [own] });
    expect(dashboardRowCancelView(row, { ...own, price: own.price + 5 }, { leaderAccountId: 7, blocked: false }).key).toBe(view.key);
    expect(dashboardRowCancelView({ ...row, id: 'jiny' }, own, { leaderAccountId: 7, blocked: false })).toMatchObject({ enabled: false, reason: expect.stringMatching(/neodpovídá/) });
    expect(dashboardRowCancelView({ ...row, accountId: 8 }, own, { leaderAccountId: 7, blocked: false }).enabled).toBe(false);
    expect(dashboardRowCancelView(row, own, { leaderAccountId: 7, blocked: true }).enabled).toBe(false);
    expect(source('components/LivePendingCancel.tsx')).toContain('dashboardRowCancelView(order, pending.entry, { leaderAccountId: cancel?.leaderAccountId, blocked })');
  });
  it('čára mimo živou pozici (návrh, backtest) pojistku nemá', () => {
    const state = liveLineClickSync(start(pending), filled, 3_000);
    expect(liveLineClick(state, { id: 'live-draft:entry' }, 'k', 3_001)).toEqual({ fire: true, next: state });
    expect(liveLineClick(state, { id: 'backtest:1' }, 'k', 3_001)).toEqual({ fire: true, next: state });
  });
  it('nabízené klíče čar a dvoukrok backtestu zůstávají', () => {
    expect(orderLineConfirmKeys(filled).has(cancelConfirmKey(filled[0]))).toBe(true);
    const armed = orderLineConfirmStep(null, 'b:cancel:cancel-order:1', true, 0);
    expect(armed.fire).toBe(false);
    expect(orderLineConfirmSync(armed.next, [])).toMatchObject({ stale: true });
    const overlay = source('components/BacktestOrderLinesOverlay.tsx');
    expect(overlay).toMatch(/const live = liveLineClick\(liveClickRef\.current, line, key, Date\.now\(\)\);\s*liveClickRef\.current = live\.next;\s*if \(!live\.fire\) \{/);
    expect(overlay).toMatch(/liveClickRef\.current = liveLineClickSync\(liveClickRef\.current, lines, Date\.now\(\)\);/);
    expect(overlay.match(/event\.currentTarget\.blur\(\);/g)).toHaveLength(2);
  });
});

describe('INV-UI-02: rozjetý status workeru nesundá desk ani nouzovou lištu', () => {
  it('sanitizace: null prvek, objekt místo pole, položka bez ceny / s cizím id vypadne; nové objekty', () => {
    const good = entry('101');
    expect(validPendingOwnEntries([null, good, 5, { ...good, price: null }, { ...good, entryOperationId: 'manage:x' }, { ...good, side: 'Long' }])).toEqual([good]);
    expect(validPendingOwnEntries({ 0: good })).toEqual([]);
    expect(validPendingOwnEntries('x')).toEqual([]);
    expect(validPendingOwnEntries([good])[0]).not.toBe(good);
    // Chybějící / nečitelný počet = null (unknown ≠ 0), ne 0.
    expect(validPendingCancelContext({ foreignOrders: 2, blockedReason: { text: 'x' } })).toMatchObject({ foreignOrders: 2, protectiveLegs: null, blockedReason: expect.stringMatching(/nejde přečíst/) });
    expect(validPendingCancelContext({ ...CONTEXT, protectiveLegs: 0 })).toEqual(CONTEXT);
    // Kontext je, ale není objekt = zablokováno (fail-closed); null / undefined = bez kontextu jako dřív.
    for (const bad of [[1], 'x', 7, true]) {
      expect(validPendingCancelContext(bad)).toEqual({ foreignOrders: null, protectiveLegs: null, partialEntries: null, otherOwnOrders: null, blockedReason: CANCEL_PENDING_CONTEXT_UNREADABLE });
    }
    expect(validPendingCancelContext(null)).toBeNull();
    expect(validPendingCancelContext(undefined)).toBeNull();
  });
  it('nečitelný kontext u neprázdné sady (kolo 2): tlačítko zamčené s důvodem, text nikdy „nic nezůstává“', () => {
    for (const bad of [[CONTEXT], 'foreign:1']) {
      expect(liveCancelPendingView(viewInput({ context: bad }))).toMatchObject({ enabled: false, reason: CANCEL_PENDING_CONTEXT_UNREADABLE });
      expect(liveCancelPendingView(viewInput({ context: bad }))!.confirmText).toContain(CANCEL_PENDING_REST_UNVERIFIED);
    }
    // Objekt s nečitelným počtem: neblokuje (worker hlídá sám), ale text řekne, že co zůstává, nejde ověřit.
    const partial = liveCancelPendingView(viewInput({ context: { ...CONTEXT, partialEntries: 'x', foreignOrders: -1 } }))!;
    expect(partial).toMatchObject({ enabled: true, reason: null });
    expect(partial.confirmText).toBe(`Zrušit 2 čekající vstupy? Jejich SL/TP se zruší s nimi. ${CANCEL_PENDING_REST_UNVERIFIED}`);
    // Čitelný kontext beze změny (jen věty jádra), bez kontextu taky.
    expect(liveCancelPendingView(viewInput())!.confirmText).toBe('Zrušit 2 čekající vstupy? Jejich SL/TP se zruší s nimi. Cizí příkazy: 1 — zruš v Tradovate nebo Flatten.');
    expect(liveCancelPendingView(viewInput({ context: null }))!.confirmText).toBe('Zrušit 2 čekající vstupy? Jejich SL/TP se zruší s nimi.');
    expect(liveCancelPendingConfirmText([entry('101')], { ...CONTEXT, protectiveLegs: null })).toContain(CANCEL_PENDING_REST_UNVERIFIED);
    // Dashboard: nečitelný kontext = zamčeno s týmž důvodem.
    const dash = { capability: true, leaderAccountId: 7, statusFresh: true, restored: false, relayConnected: true, entries: [entry('101')], context: [1] };
    expect(dashboardOrderCancelView({ accountId: 7, id: 101, working: true }, dash)).toEqual({ kind: 'locked', reason: CANCEL_PENDING_CONTEXT_UNREADABLE });
  });
  it('liveCancelPendingView: špatný tvar = nic / jen platné položky; výjimka uvnitř = null (nic se nenabídne)', () => {
    expect(liveCancelPendingView(viewInput({ entries: [null, entry('101')] }))).toMatchObject({ label: 'Zrušit čekající (1)', enabled: true });
    expect(liveCancelPendingView(viewInput({ entries: { 0: entry('101') } }))).toBeNull();
    expect(liveCancelPendingView(viewInput({ context: { blockedReason: 42 } }))).toMatchObject({ enabled: false, reason: expect.stringMatching(/nejde přečíst/) });
    const hostile = [entry('101')];
    Object.defineProperty(hostile, 0, { get: () => { throw new Error('bad status'); } });
    expect(() => liveCancelPendingView(viewInput({ entries: hostile }))).not.toThrow();
    expect(liveCancelPendingView(viewInput({ entries: hostile }))).toBeNull();
  });
  it('dashboardOrderCancelView: rozbitý vstup = zamčeno, nikdy výjimka; vlastní vstup jen z platných položek', () => {
    const base = { capability: true, leaderAccountId: 7, statusFresh: true, restored: false, relayConnected: true };
    const own = { accountId: 7, id: 101, working: true };
    expect(dashboardOrderCancelView(own, { ...base, entries: [null, entry('101')] })).toMatchObject({ kind: 'cancel' });
    expect(dashboardOrderCancelView(own, { ...base, entries: { 0: entry('101') } })).toEqual({ kind: 'locked', reason: DASHBOARD_CANCEL_NOT_OWN });
    const hostile = [entry('101')];
    Object.defineProperty(hostile, 0, { get: () => { throw new Error('bad status'); } });
    expect(dashboardOrderCancelView(own, { ...base, entries: hostile })).toEqual({ kind: 'locked', reason: DASHBOARD_CANCEL_UNREADABLE });
    expect(dashboardOrderCancelView({ ...own, accountId: null }, { ...base, entries: [entry('101')] })).toEqual({ kind: 'locked', reason: DASHBOARD_CANCEL_NOT_OWN });
  });
  it('lišta: část C7 jen ve vlastní hranici chyb (fallback nic), komponenta stále připojená; hranice se po chybě vykreslí jako nic', () => {
    const controls = source('components/LiveSafetyControls.tsx');
    expect(controls).not.toMatch(/useLiveCancelPendingBar|useLiveCancelPendingAction/);
    expect(controls).toMatch(/<LiveCancelPendingBoundary resetKey=\{[^}]+\}><LiveCancelPendingBar input=\{cancelPending\} \/><\/LiveCancelPendingBoundary>/);
    expect(controls).not.toMatch(/cancelPending && <LiveCancelPendingBar/);
    expect(LiveCancelPendingBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const boundary = new LiveCancelPendingBoundary({ children: 'C7', resetKey: 'a' });
    expect(boundary.render()).toBe('C7');
    boundary.state = { failed: true, failedKey: 'a' };
    expect(boundary.render()).toBeNull();
    // Bez pohledu: nic (ani tlačítko), ale komponenta zůstává kvůli pozdnímu výsledku.
    expect(renderToStaticMarkup(React.createElement(LiveCancelPendingBar, { input: null }))).toBe('');
  });
});

describe('Dashboard: blokace workeru a skupina mimo worker (pravdivý text)', () => {
  const input = (patch: Partial<LiveDashboardPendingCancel> = {}): LiveDashboardPendingCancel => ({
    capability: true, leaderAccountId: 7, entries: [entry('101')], statusFresh: true, restored: false, relayConnected: true,
    lockRef: { current: false }, cancel: vi.fn(async () => []), ...patch,
  });
  const own = { accountId: 7, id: 101, working: true };
  it('blockedReason workeru = zamčeno s tímto důvodem (jako lišta)', () => {
    expect(dashboardOrderCancelView(own, input({ context: { ...CONTEXT, blockedReason: 'Nevyřešený ruční vstup — počkej.' } })))
      .toEqual({ kind: 'locked', reason: 'Nevyřešený ruční vstup — počkej.' });
    const html = renderToStaticMarkup(React.createElement(DashboardOrderCancelButton, { order: own, cancel: input({ context: { ...CONTEXT, blockedReason: 'Nevyřešený ruční vstup.' } }) }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('Nevyřešený ruční vstup.');
    expect(html).not.toContain('data-dashboard-cancel-entry');
  });
  it('skupina, kterou worker neřídí = vlastní text (ne „worker neumí“); skupina workeru beze změny', () => {
    const cancel = input();
    expect(dashboardPendingCancelForGroup(cancel, 'group-main', 'group-main')).toBe(cancel);
    const other = dashboardPendingCancelForGroup(cancel, 'group-other', 'group-main')!;
    expect(dashboardOrderCancelView(own, other)).toEqual({ kind: 'locked', reason: DASHBOARD_CANCEL_NOT_WORKER_GROUP });
    expect(dashboardOrderCancelView(own, dashboardPendingCancelForGroup(cancel, 'group-main', null))).toEqual({ kind: 'locked', reason: DASHBOARD_CANCEL_NOT_WORKER_GROUP });
    expect(dashboardPendingCancelForGroup(null, 'group-main', 'group-main')).toBeNull();
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk).toMatch(/context: agentStatus\?\.controller\.pendingCancelContext \?\? null,/);
  });
});

describe('JEDEN zámek jednoho příkazu: panel PC, telefon a Dashboard', () => {
  it('runWithCommandLock: obsazený zámek = výjimka „nic se neodeslalo“ bez odeslání; jinak drží po dobu letu i po výjimce uvolní', async () => {
    const lock = { current: true };
    const send = vi.fn(async () => 'ok');
    await expect(runWithCommandLock(lock, send)).rejects.toThrow(LIVE_COMMAND_BUSY_TEXT);
    expect(send).not.toHaveBeenCalled();
    lock.current = false;
    let during = false;
    send.mockImplementation(async () => { during = lock.current; return 'ok'; });
    expect(await runWithCommandLock(lock, send)).toBe('ok');
    expect(during).toBe(true);
    expect(lock.current).toBe(false);
    await expect(runWithCommandLock(lock, async () => { throw new Error('relay timeout'); })).rejects.toThrow('relay timeout');
    expect(lock.current).toBe(false);
  });
  it('PC: × z čáry letí → „Odeslat SL a TP“ / vstup z panelu neodejde (stejný ref)', async () => {
    const lock = { current: false };
    let release!: () => void;
    const lineClose = createLiveBareCloseRun({ close: () => () => new Promise(done => { release = () => done(manageResult()); }), busyRef: lock, setPendingMove: () => {}, report: () => {} });
    const flight = lineClose(TRADE);
    const attach = vi.fn(async () => manageResult({ action: 'attach-brackets' }));
    await expect(runWithCommandLock(lock, attach)).rejects.toThrow(/nic se neodeslalo/);
    expect(attach).not.toHaveBeenCalled();
    release();
    await flight;
    expect(lock.current).toBe(false);
  });
  it('zapojení: panel vstup (tlačítko i Náhled), attach a × přes zámek obrazovky = zámek desku', () => {
    const ticket = source('components/LiveOrderTicket.tsx');
    expect(ticket).toMatch(/const lockRef = commandLockRef \?\? ownCommandLockRef;/);
    expect(ticket).toMatch(/runWithCommandLock\(lockRef, \(\) => onPlaceEntry\(entryDraft, operationId\)\)/);
    expect(ticket).toMatch(/runWithCommandLock\(lockRef, \(\) => onAttachBrackets\(intent\.attach\)\)/);
    expect(ticket).toMatch(/\{\.\.\.\(placeEntryLocked && !bareDraft \? \{ onPlace: placeEntryLocked \} : \{\}\)\}/);
    expect(ticket.match(/onPlaceEntry\(/g)).toHaveLength(1);
    expect(ticket.match(/onAttachBrackets\(/g)).toHaveLength(1);
    const screen = source('components/LiveTradingScreen.tsx');
    expect(screen).toMatch(/commandLockRef=\{liveBusyRef\}/);
  });
  it('zapojení: telefon používá zámek desku pro vstup, attach, čáry, lištu i čip; desk ho předá mostem', () => {
    const phone = source('components/day/LivePhoneChart.tsx');
    expect(phone).toMatch(/const lineState = trade\?\.commandLockRef \? \{ \.\.\.ownLineState, busyRef: trade\.commandLockRef \} : ownLineState;\s*const busyRef = lineState\.busyRef;/);
    expect(phone).not.toMatch(/const busyRef = useRef/);
    expect(phone.match(/if \(busyRef\.current\) \{ say\(LIVE_COMMAND_BUSY_TEXT\); return; \}/g)).toHaveLength(2);
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk).toMatch(/commandLockRef: liveCommandLockRef,/);
  });
});

describe('jádro: cancelPendingConfirmStep (chyba trojkliku) žádný runtime soubor nepoužívá', () => {
  it('UI ho nepoužívá', () => {
    for (const file of [
      'components/LivePendingCancel.tsx', 'components/LiveSafetyControls.tsx', 'components/LiveOrderTicket.tsx', 'components/LiveTradingScreen.tsx',
      'components/TradovateLiveDesk.tsx', 'components/LiveCopyTradeOverview.tsx', 'components/day/LivePhoneChart.tsx', 'components/day/LivePhoneLiveActions.tsx',
      'hooks/liveCommandRuns.ts', 'hooks/useLiveClickGate.ts', 'lib/liveClickGate.ts', 'lib/liveCancelPendingUi.ts', 'lib/liveDeskCommands.ts', 'lib/liveBareCloseUi.ts',
    ]) {
      expect(source(file), file).not.toMatch(/cancelPendingConfirmStep/);
    }
  });
});
