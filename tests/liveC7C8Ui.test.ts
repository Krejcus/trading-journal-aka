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
import { createLiveConfirmGate } from '../lib/liveConfirmGate';
import { livePhoneCancelPendingChipShown } from '../lib/livePhoneOrders';
import { LIVE_DESK_NOT_FRESH, LIVE_DESK_ROUTE_CHANGED, createLiveDeskCommands } from '../lib/liveDeskCommands';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';
import type { LeaderOrderManageCommand } from '../lib/leaderOrderManage';
import { livePositionChartLines } from '../lib/liveChartOrderLines';
import type { LiveChartPositionSummary } from '../lib/liveChartPosition';
import { LIVE_HOTKEY_BUSY_TEXT, createTwoStepGuard, liveHotkeyGuardSync, resolveLiveHotkey } from '../lib/liveHotkeys';
import { cancelConfirmKey, orderLineConfirmKeys, orderLineConfirmStep, orderLineConfirmSync } from '../components/BacktestOrderLinesOverlay';
import { BareCloseButton } from '../components/LiveOrderTicket';
import { DashboardOrderCancelButton, LiveCancelPendingBar, LiveCancelPendingBoundary, type LiveDashboardPendingCancel } from '../components/LivePendingCancel';
import LiveSafetyControls from '../components/LiveSafetyControls';
import { createFlattenGroupCoordinator } from '../lib/liveSafetyAction';
import { LivePhoneCancelPendingChip, LivePhonePositionBar, livePhoneBarClick, livePhonePositionCloseKey } from '../components/day/LivePhoneLiveActions';

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

describe('C8 UI: × na čáře PC a Shift+X — id cíle v klíči, vždy dvoukrokově', () => {
  const summary: LiveChartPositionSummary = {
    kind: 'position', side: 'long', quantity: 2, entry: 25_000.25, stop: null, target: null, openPnl: 4, mark: 25_001.25, entryType: 'Market',
  } as unknown as LiveChartPositionSummary;

  it('holá pozice s nabídkou: × se dvoukrokem, bez BE; bez nabídky žádné ×', () => {
    const [line] = livePositionChartLines(summary, { manageable: false, entryAvg: null, pointValue: 2, bareClose: { entryOperationId: TRADE.entryOperationId } });
    expect(line).toMatchObject({ id: liveBareLineId(TRADE.entryOperationId), cancellable: true, cancelAction: 'close-position', confirmCancel: true });
    expect(line.actions).toBeUndefined();
    expect(liveBareLineEntryId(line.id)).toBe(TRADE.entryOperationId);
    expect(liveBareLineEntryId('live-position:entry')).toBeNull();
    const [plain] = livePositionChartLines(summary, { manageable: false, entryAvg: null, pointValue: 2 });
    expect(plain).toMatchObject({ id: 'live-position:entry', cancellable: false });
    // Klíč × nese id cíle: jiný holý vstup = jiný klíč.
    const [other] = livePositionChartLines(summary, { manageable: false, entryAvg: null, pointValue: 2, bareClose: { entryOperationId: 'entry:other0000001' } });
    expect(cancelConfirmKey(other)).not.toBe(cancelConfirmKey(line));
  });

  it('Shift+X míří na čáru holé pozice; klíč nese id cíle; potvrdí jen 2. stisk ≥ 350 ms od předchozího', () => {
    const lines = livePositionChartLines(summary, { manageable: false, entryAvg: null, pointValue: 2, bareClose: { entryOperationId: TRADE.entryOperationId } });
    const guard = createTwoStepGuard();
    const state = { lines, breakEven: null, hasDraft: false, busy: false };
    const first = resolveLiveHotkey({ kind: 'close-position' }, state, guard, 1_000);
    expect(first).toMatchObject({ kind: 'prompt' });
    expect((first as { key: string }).key).toContain(TRADE.entryOperationId);
    expect(resolveLiveHotkey({ kind: 'close-position' }, state, guard, 1_200)).toMatchObject({ kind: 'prompt' });
    expect(resolveLiveHotkey({ kind: 'close-position' }, state, guard, 1_450)).toMatchObject({ kind: 'prompt' });
    expect(resolveLiveHotkey({ kind: 'close-position' }, state, guard, 1_850)).toMatchObject({ kind: 'run', line: { id: liveBareLineId(TRADE.entryOperationId) } });
    expect(resolveLiveHotkey({ kind: 'close-position' }, { ...state, busy: true }, guard, 2_500)).toMatchObject({ kind: 'blocked' });
  });

  it('Shift+X: zablokovaná / zmizelá / změněná čára zahodí výzvu i bez stisku (liveHotkeyGuardSync, kolo 2)', () => {
    const bareControls = { manageable: false, entryAvg: null, pointValue: 2, bareClose: { entryOperationId: TRADE.entryOperationId } };
    const lines = livePositionChartLines(summary, bareControls);
    const blocked = livePositionChartLines(summary, { manageable: false, entryAvg: null, pointValue: 2 });
    const state = { lines, breakEven: null, hasDraft: false, busy: false };
    // Bez rozjeté výzvy nic.
    const idle = createTwoStepGuard();
    expect(liveHotkeyGuardSync(idle, { lines: blocked, breakEven: null }, 1_000)).toBe(false);
    // 1. Shift+X → status na chvíli zastaral (čára bez ×) → status zpět se STEJNÝM klíčem → 2. Shift+X jen znovu ptá.
    const guard = createTwoStepGuard();
    expect(resolveLiveHotkey({ kind: 'close-position' }, state, guard, 1_000)).toMatchObject({ kind: 'prompt' });
    expect(liveHotkeyGuardSync(guard, { lines, breakEven: null }, 1_100)).toBe(false);
    expect(guard.pending(1_100)).not.toBeNull();
    expect(liveHotkeyGuardSync(guard, { lines: blocked, breakEven: null }, 1_400)).toBe(true);
    expect(guard.pending(1_400)).toBeNull();
    expect(liveHotkeyGuardSync(guard, { lines, breakEven: null }, 1_600)).toBe(false);
    expect(resolveLiveHotkey({ kind: 'close-position' }, state, guard, 1_900)).toMatchObject({ kind: 'prompt' });
    // Čára zmizela úplně / změnila cíl (jiný holý vstup) = zahozeno.
    const gone = createTwoStepGuard();
    resolveLiveHotkey({ kind: 'close-position' }, state, gone, 1_000);
    expect(liveHotkeyGuardSync(gone, { lines: [], breakEven: null }, 1_200)).toBe(true);
    const moved = createTwoStepGuard();
    resolveLiveHotkey({ kind: 'close-position' }, state, moved, 1_000);
    const other = livePositionChartLines(summary, { ...bareControls, bareClose: { entryOperationId: 'entry:other0000001' } });
    expect(liveHotkeyGuardSync(moved, { lines: other, breakEven: null }, 1_200)).toBe(true);
    // BE: zablokované BE (stav ze stejné funkce jako stisk) zahodí výzvu; BE beze změny ne.
    const managedSummary = { ...summary, stop: 24_990, target: 25_020, mark: 25_010 } as LiveChartPositionSummary;
    const managed = livePositionChartLines(managedSummary, { manageable: true, canClose: true, entryAvg: 25_000.25, pointValue: 2 });
    const be = { price: 25_000.25, blocked: null };
    const beGuard = createTwoStepGuard();
    expect(resolveLiveHotkey({ kind: 'break-even' }, { lines: managed, breakEven: be, hasDraft: false, busy: false }, beGuard, 1_000)).toMatchObject({ kind: 'prompt' });
    expect(liveHotkeyGuardSync(beGuard, { lines: managed, breakEven: be }, 1_200)).toBe(false);
    expect(liveHotkeyGuardSync(beGuard, { lines: managed, breakEven: { price: 25_000.25, blocked: 'SL už je na BE.' } }, 1_300)).toBe(true);
    // Zapojení: efekt obrazovky na čárách volá sync a maže jen text téže výzvy.
    const screen = source('components/LiveTradingScreen.tsx');
    expect(screen).toMatch(/if \(!liveHotkeyGuardSync\(guard, \{ lines: orderLines, breakEven \}, at\)\) return;/);
    expect(screen).toMatch(/hotkeyPromptAtRef\.current = outcome\.kind === 'prompt' \? now : null;/);
    expect(screen).toMatch(/\}, \[orderLines, summary, guardSummaryAt, manageEntryAvgPrice\]\);/);
  });

  it('dvoukrok čáry (`orderLineConfirmStep`): 2. klik ≥ 350 ms od PŘEDCHOZÍHO kliku, ≤ 4 s, stejný klíč', () => {
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
    const html = renderToStaticMarkup(React.createElement(BareCloseButton, { offer, asking: false, busy: false, notice: null, onClick: () => {} }));
    expect(html).toContain('disabled=""');
    expect(html).toContain('Zavřít LONG 2 · bez SL/TP');
    expect(html).toMatch(/Flattenem/);
    expect(liveBareCloseLabel(TRADE, true)).toBe('Opravdu zavřít LONG 2?');
    // Napojení: klik pustí fokus a jde jen přes automat panelu (`createLiveBareClosePanelClick`).
    const ticket = source('components/LiveOrderTicket.tsx');
    const click = between(ticket, 'const clickBareClose = (event', 'const bareCloseView =');
    expect(click).toMatch(/event\.currentTarget\.blur\(\);/);
    expect(click).toMatch(/const sent = bareClosePanelClick\(bareCloseOffer\);\s*if \(!sent \|\| !target\) return;/);
    expect(click).not.toMatch(/onBareClose/);
    expect(ticket).toMatch(/const \{ gate: bareCloseGate \} = useLiveConfirmGate\(\[bareCloseOffer\]\);/);
    expect(ticket).toMatch(/busy: \(\) => lockRef\.current \|\| attachBusyRef\.current \|\| directBusyRef\.current,/);
  });
});

describe('C8 UI: desk — tatáž cesta správy leadera, jen obchod, který uživatel viděl', () => {
  const desk = source('components/TradovateLiveDesk.tsx');
  it('closeBareLeader a cancelPendingEntries jsou z čisté továrny desku (testy chování níže)', () => {
    expect(desk).toMatch(/const closeBareLeader = deskCommands\.closeBareLeader;/);
    expect(desk).toMatch(/const cancelPendingEntries = deskCommands\.cancelPendingEntries;/);
    expect(desk).toMatch(/const sendLeaderManage = deskCommands\.sendLeaderManage;/);
    const factory = source('lib/liveDeskCommands.ts');
    expect(factory).not.toMatch(/executeTradovate|fetch\(|services\/|retry|\bwhile\b/);
  });
  it('jediné relay odeslání správy je sendLeaderManage (manage, attach, × holé pozice, Zrušit čekající)', () => {
    // place-leader-entry (vstup) zvlášť; správa jen přes `relay` továrny — žádná třetí kopie.
    expect(desk.match(/executeTradovateCopierRelayCommand\(route\.relayConnectionId, \{ type: 'copy-command', command \}\)/g) ?? []).toHaveLength(1);
    expect(desk.match(/relay: \(relayId, command\) => executeTradovateCopierRelayCommand\(relayId, \{ type: 'copy-command', command \}\),/g) ?? []).toHaveLength(1);
    expect(between(desk, 'const manageLeaderEntry = useCallback(', '}, [chartData.position?.summary, sendLeaderManage]);')).toMatch(/return sendLeaderManage\(command,/);
    expect(between(desk, 'const attachBrackets = useCallback(', '}, [sendLeaderManage]);')).toMatch(/return sendLeaderManage\(command,/);
    expect(desk).toContain('{...(supportsCopierManualOrderCloseBare(agentStatus) ? { onBareClose: closeBareLeader } : {})}');
    expect(desk).toContain('...(supportsCopierManualOrderCloseBare(agentStatus) ? { bareClose: bareCloseOffer, closeBare: closeBareLeader } : {}),');
  });
});

describe('C8 UI: telefon — „Zavřít“ holé pozice vedle Flattenu', () => {
  const offer = liveBareCloseOffer(offerInput())!;
  const bar = (patch: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(LivePhonePositionBar, {
    side: 'long', quantity: 2, symbol: 'MNQZ6', unprotected: true, busy: false, onAttach: () => {}, onClose: () => {}, ...patch,
  }));
  it('zdroj lišty: obě tlačítka pouští fokus a jdou přes JEDEN automat (livePhoneBarClick)', () => {
    const actions = source('components/day/LivePhoneLiveActions.tsx');
    const click = between(actions, 'data-live-bare-close', '>{bareConfirming');
    expect(click).toMatch(/event\.currentTarget\.blur\(\);/);
    expect(click).toMatch(/const action = livePhoneBarClick\(gate, 'bare', \{ flattenKey: actionKey, bare \}\);\s*if \(action === 'bare-close' \|\| action === 'bare-blocked'\) onBareClose!\(bare\.key\);/);
    const flatten = between(actions, 'data-live-bar-flatten', '>{pending ?');
    expect(flatten).toMatch(/event\.currentTarget\.blur\(\);/);
    expect(flatten).toMatch(/if \(livePhoneBarClick\(gate, 'flatten', \{ flattenKey: actionKey, bare \}\) === 'flatten'\) onClose\(\);/);
    expect(actions).toMatch(/const \{ gate \} = useLiveConfirmGate\(\[\{ key: actionKey, enabled: true \}, bare\]\);/);
    expect(actions.match(/useLiveConfirmGate\(/g)).toHaveLength(1);
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
  it('dvoukrok C7 (lišta, telefon, Dashboard): hook jen napojí automat (`createLiveCancelPendingClick`)', () => {
    const pending = source('components/LivePendingCancel.tsx');
    const hook = between(pending, 'export function useLiveCancelPendingAction(', '/** Odkaz na deskový zámek');
    expect(hook).toMatch(/const \{ gate \} = useLiveConfirmGate\(\[view\]\);/);
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

describe('automat dvoukroku (createLiveConfirmGate): 350 ms od PŘEDCHOZÍHO kliku, blokace a zmizení zahodí', () => {
  const target = (patch: Partial<{ key: string; enabled: boolean; reason: string | null }> = {}) => ({ key: 'k', enabled: true, reason: null, ...patch });
  it('dva kliky v jednom snímku (stejný ms) ani trojklik nic nepotvrdí; 2. klik 350 ms – 4 s ano', () => {
    const time = clock();
    const gate = createLiveConfirmGate({ now: time.now });
    expect(gate.click(target()).kind).toBe('asking');
    expect(gate.click(target()).kind).toBe('asking'); // týž snímek
    time.set(200); expect(gate.click(target()).kind).toBe('asking');
    time.set(400); expect(gate.click(target()).kind).toBe('asking'); // 400 od prvního, 200 od předchozího
    time.set(750); expect(gate.click(target()).kind).toBe('send');
    expect(gate.current()).toBeNull();
    time.set(1_000); expect(gate.click(target()).kind).toBe('asking');
    time.set(5_000); expect(gate.click(target()).kind).toBe('asking'); // po 4 s znovu první krok
  });
  it('sync: zablokovaný, změněný nebo zmizelý cíl zahodí „Opravdu?“ i bez kliku; jiný aktivní cíl ne', () => {
    for (const next of [target({ enabled: false }), target({ key: 'k2' }), null]) {
      const time = clock();
      const gate = createLiveConfirmGate({ now: time.now });
      gate.click(target());
      gate.sync([next]);
      expect(gate.current()).toBeNull();
      time.set(500);
      expect(gate.click(target()).kind).toBe('asking'); // odblokováno = znovu od prvního kliku
    }
    const gate = createLiveConfirmGate({ now: clock().now });
    gate.click(target());
    gate.sync([target({ key: 'other' }), target()]);
    expect(gate.current()).not.toBeNull();
  });
  it('klik na zablokovaný cíl = blocked + zahozené potvrzení; busy = nic a potvrzení beze změny; expire po 4 s', () => {
    const time = clock();
    const changes: unknown[] = [];
    const gate = createLiveConfirmGate({ now: time.now, onChange: state => changes.push(state) });
    gate.click(target());
    expect(gate.click(target({ enabled: false, reason: 'Zastaralý stav.' }))).toEqual({ kind: 'blocked', reason: 'Zastaralý stav.' });
    expect(gate.current()).toBeNull();
    gate.click(target());
    time.set(500);
    expect(gate.click(target(), { busy: true }).kind).toBe('busy');
    expect(gate.current()).toMatchObject({ key: 'k', at: 0 });
    expect(gate.click(undefined).kind).toBe('missing');
    expect(gate.current()).toBeNull();
    gate.click(target());
    time.set(3_999); gate.expire(); expect(gate.current()).not.toBeNull();
    time.set(4_500); gate.expire(); expect(gate.current()).toBeNull();
    expect(changes.length).toBeGreaterThan(3);
  });
});

describe('(a) „Zrušit čekající“ / Dashboard: klik → automat → běh se zámkem (bez Reactu)', () => {
  const setup = (lock = false) => {
    const time = clock();
    const gate = createLiveConfirmGate({ now: time.now });
    const lockRef = { current: lock };
    const cancel = vi.fn(async (entries: readonly PendingOwnEntry[]) => entries.map(item => ({ entry: item, operationId: 'manage:000000000001', outcome: 'canceled' as const, text: 'Zrušeno.' })));
    const report = vi.fn();
    const run = createLiveCancelPendingRun({ cancel: () => cancel, busyRef: lockRef, report, now: time.now });
    const click = createLiveCancelPendingClick({ gate, run, report, now: time.now });
    return { time, gate, lockRef, cancel, report, click };
  };
  const view = (patch: Partial<Parameters<typeof liveCancelPendingView>[0]> = {}) => liveCancelPendingView(viewInput(patch))!;

  it('druhý klik 350 ms – 4 s pošle PRÁVĚ jednou sadu, kterou uživatel viděl', async () => {
    const t = setup();
    const shown = view();
    expect(t.click(shown)).toBeNull();
    t.time.set(500);
    await t.click(shown);
    expect(t.cancel).toHaveBeenCalledTimes(1);
    expect(t.cancel).toHaveBeenCalledWith(shown.entries);
  });
  it('dva kliky v jednom snímku nic nepošlou', () => {
    const t = setup();
    const shown = view();
    expect(t.click(shown)).toBeNull();
    expect(t.click(shown)).toBeNull();
    expect(t.cancel).not.toHaveBeenCalled();
  });
  it('změna sady mezi kliky (vyplnění, nový vstup, jiná cena) nic nepošle', () => {
    const t = setup();
    t.click(view());
    t.time.set(500);
    expect(t.click(view({ entries: [entry('101')] }))).toBeNull();
    t.time.set(1_000);
    expect(t.click(view({ entries: [entry('101', { price: 24_995 }), entry('102', { price: 24_980 })] }))).toBeNull();
    expect(t.cancel).not.toHaveBeenCalled();
  });
  it('blokace mezi kliky zahodí potvrzení i bez kliku (sync) — po odblokování nic, až nový dvoukrok', async () => {
    const t = setup();
    const shown = view();
    t.click(shown);
    t.gate.sync([view({ statusFresh: false })]);
    t.time.set(500);
    expect(t.click(shown)).toBeNull();
    expect(t.cancel).not.toHaveBeenCalled();
    t.time.set(1_000);
    await t.click(shown);
    expect(t.cancel).toHaveBeenCalledTimes(1);
  });
  it('klik na zablokovaný pohled = jen důvod, nic se neodeslalo', () => {
    const t = setup();
    t.click(view());
    t.time.set(500);
    expect(t.click(view({ context: { ...CONTEXT, blockedReason: 'Nevyřešený ruční vstup.' } }))).toBeNull();
    expect(t.report.mock.calls.at(-1)?.[0].text).toBe('Nevyřešený ruční vstup. Nic se neodeslalo.');
    expect(t.cancel).not.toHaveBeenCalled();
  });
  it('zámek drží jiný příkaz (× z čáry telefonu, posun SL) → druhý klik Dashboardu nic nepošle', async () => {
    const t = setup(true);
    const shown = view();
    t.click(shown);
    t.time.set(500);
    expect(await t.click(shown)).toMatchObject({ called: false });
    expect(t.cancel).not.toHaveBeenCalled();
    expect(t.report.mock.calls.at(-1)?.[0].text).toBe(LIVE_COMMAND_BUSY_TEXT);
  });
  it('(e) výsledek přijde až po zmizení nabídky (status dřív než ACK): ohlásí se, nic dalšího neodejde', async () => {
    const t = setup();
    let resolve!: (value: CancelPendingItemResult[]) => void;
    t.cancel.mockImplementation(() => new Promise<CancelPendingItemResult[]>(done => { resolve = done; }) as never);
    const shown = view();
    t.click(shown);
    t.time.set(500);
    const flight = t.click(shown)!;
    expect(t.lockRef.current).toBe(true);
    t.gate.sync([null]); // status: nic čekajícího, tlačítko zmizelo
    t.time.set(900);
    expect(t.click(null)).toBeNull();
    resolve(shown.entries.map(item => ({ entry: item, operationId: 'manage:000000000001', outcome: 'canceled', text: 'Zrušeno.' })));
    expect((await flight).notice.text).toBe('Zrušeno 2 z 2.');
    expect(t.report.mock.calls.at(-1)?.[0].text).toBe('Zrušeno 2 z 2.');
    expect(t.cancel).toHaveBeenCalledTimes(1);
    expect(t.lockRef.current).toBe(false);
  });
});

describe('(b) × holé pozice v panelu PC (createLiveBareClosePanelClick)', () => {
  const setup = () => {
    const time = clock();
    const gate = createLiveConfirmGate({ now: time.now });
    const busy = { current: false };
    const close = vi.fn(async (_id: string) => ({ called: true, status: 'acknowledged' as const, notice: { tone: 'ok' as const, text: 'ok', at: 1 } }));
    const report = vi.fn();
    const click = createLiveBareClosePanelClick({ gate, busy: () => busy.current, close: () => close, report, now: time.now });
    return { time, gate, busy, close, report, click };
  };
  const offer = (patch: Partial<Parameters<typeof liveBareCloseOffer>[0]> = {}) => liveBareCloseOffer(offerInput(patch));

  it('dvoukrok s klíčem nabídky → právě jedno close s id cíle', async () => {
    const t = setup();
    expect(t.click(offer())).toBeNull();
    t.time.set(500);
    await t.click(offer());
    expect(t.close).toHaveBeenCalledTimes(1);
    expect(t.close).toHaveBeenCalledWith(TRADE.entryOperationId);
  });
  it('blokace mezi kliky (stav zastaral) zahodí potvrzení — po návratu nabídky jeden klik nic nepošle', () => {
    const t = setup();
    t.click(offer());
    t.gate.sync([offer({ statusFresh: false })]);
    t.time.set(600);
    expect(t.click(offer())).toBeNull();
    expect(t.close).not.toHaveBeenCalled();
  });
  it('klik na zablokovanou nabídku = důvod „Nic se neodeslalo“; zmizelá nabídka = nic', () => {
    const t = setup();
    t.click(offer());
    t.time.set(500);
    expect(t.click(offer({ armed: false }))).toBeNull();
    expect(t.report.mock.calls.at(-1)?.[1].text).toMatch(/Flattenem\. Nic se neodeslalo\.$/);
    expect(t.click(null)).toBeNull();
    expect(t.close).not.toHaveBeenCalled();
  });
  it('attach / vstup / jiný příkaz pod sdíleným zámkem v letu = nic, text „Čeká se…“', () => {
    const t = setup();
    t.click(offer());
    t.busy.current = true;
    t.time.set(500);
    expect(t.click(offer())).toBeNull();
    expect(t.report.mock.calls.at(-1)?.[1]).toMatchObject({ tone: 'warn', text: LIVE_COMMAND_BUSY_TEXT });
    expect(t.close).not.toHaveBeenCalled();
  });
  it('jiný holý vstup mezi kliky (jiné id cíle) nic nepošle', () => {
    const t = setup();
    t.click(offer());
    t.time.set(500);
    expect(t.click(offer({ trade: { ...TRADE, entryOperationId: 'entry:other0000001' }, position: LONG2 }))).toBeNull();
    expect(t.close).not.toHaveBeenCalled();
  });
});

describe('(c) telefonní lišta: JEDEN automat pro Flatten i „Zavřít“ holé pozice', () => {
  const offer = liveBareCloseOffer(offerInput())!;
  const flattenKey = livePhonePositionCloseKey({ side: 'long', quantity: 2, symbol: 'MNQZ6', pending: null });
  it('Zavřít (C8) a pak Flatten nic nepošle — a naopak', () => {
    const time = clock();
    const gate = createLiveConfirmGate({ now: time.now });
    expect(livePhoneBarClick(gate, 'bare', { flattenKey, bare: offer })).toBeNull();
    time.set(500);
    expect(livePhoneBarClick(gate, 'flatten', { flattenKey, bare: offer })).toBeNull();
    time.set(1_000);
    expect(livePhoneBarClick(gate, 'bare', { flattenKey, bare: offer })).toBeNull();
    time.set(1_500);
    expect(livePhoneBarClick(gate, 'bare', { flattenKey, bare: offer })).toBe('bare-close');
    time.set(2_000);
    expect(livePhoneBarClick(gate, 'flatten', { flattenKey, bare: offer })).toBeNull();
    time.set(2_500);
    expect(livePhoneBarClick(gate, 'flatten', { flattenKey, bare: offer })).toBe('flatten');
  });
  it('zablokovaná nabídka = bare-blocked (rodič jen řekne důvod) a rozběhnuté potvrzení pryč', () => {
    const time = clock();
    const gate = createLiveConfirmGate({ now: time.now });
    livePhoneBarClick(gate, 'bare', { flattenKey, bare: offer });
    time.set(500);
    const blocked = liveBareCloseOffer(offerInput({ killSwitch: true }))!;
    expect(livePhoneBarClick(gate, 'bare', { flattenKey, bare: blocked })).toBe('bare-blocked');
    expect(gate.current()).toBeNull();
    // Sync s nabídkou, která zmizela: rozběhnuté „Zavřít“ pryč, Flatten se stejným klíčem zůstává.
    livePhoneBarClick(gate, 'bare', { flattenKey, bare: offer });
    gate.sync([{ key: flattenKey, enabled: true }, null]);
    expect(gate.current()).toBeNull();
    livePhoneBarClick(gate, 'flatten', { flattenKey, bare: offer });
    gate.sync([{ key: flattenKey, enabled: true }, null]);
    expect(gate.current()).toMatchObject({ key: flattenKey });
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

describe('(f) čáry grafu: přechod holá → spravovaná pozice mezi kliky nic nepotvrdí', () => {
  const summary = {
    kind: 'position', side: 'long', quantity: 2, entry: 25_000.25, stop: null, target: null, openPnl: 4, mark: 25_001.25, entryType: 'Market',
  } as unknown as LiveChartPositionSummary;
  const [bareLine] = livePositionChartLines(summary, { manageable: false, entryAvg: null, pointValue: 2, bareClose: { entryOperationId: TRADE.entryOperationId } });
  const managedLine = { ...bareLine, id: 'live-position:entry', confirmCancel: false };
  it('1. klik × holé pozice, mezitím attach → spravovaný obchod (× jednoklik): potvrzovací klik NIC nepošle', () => {
    const armed = orderLineConfirmStep(null, cancelConfirmKey(bareLine), true, 0);
    expect(armed.fire).toBe(false);
    const after = orderLineConfirmStep(armed.next, cancelConfirmKey(managedLine), false, 500);
    // Spolknutý klik rozběhne aktivní 1. krok nového × („Opravdu?“), dvojklik nic.
    expect(after).toEqual({ next: { key: cancelConfirmKey(managedLine), since: 500, until: 500 + 4_000 }, fire: false });
    expect(orderLineConfirmStep(after.next, cancelConfirmKey(managedLine), false, 600).fire).toBe(false);
    expect(orderLineConfirmStep(after.next, cancelConfirmKey(managedLine), false, 850).fire).toBe(true);
    // Bez rozběhnutého potvrzení holé čáry je × spravovaného obchodu dál jednoklikové (Filip 30. 10.).
    expect(orderLineConfirmStep(null, cancelConfirmKey(managedLine), false, 500).fire).toBe(true);
    // Po 4 s už rozběhnuté potvrzení neplatí.
    expect(orderLineConfirmStep(armed.next, cancelConfirmKey(managedLine), false, 4_001).fire).toBe(true);
  });
  it('nabízené klíče čar (orderLineConfirmKeys): zmizelá / zablokovaná / změněná čára klíč nenabízí', () => {
    const keys = orderLineConfirmKeys([bareLine]);
    expect(keys.has(cancelConfirmKey(bareLine))).toBe(true);
    // Nabídka se zablokovala → livePositionChartLines čáru holé pozice bez × nekreslí.
    const [plain] = livePositionChartLines(summary, { manageable: false, entryAvg: null, pointValue: 2 });
    expect(orderLineConfirmKeys([plain]).has(cancelConfirmKey(bareLine))).toBe(false);
    expect(orderLineConfirmKeys([managedLine]).has(cancelConfirmKey(bareLine))).toBe(false);
    const withAction = { ...managedLine, actions: [{ id: 'break-even', label: 'BE', confirm: true, disabled: false }] };
    expect(orderLineConfirmKeys([withAction]).has('live-position:entry:break-even')).toBe(true);
    expect(orderLineConfirmKeys([{ ...withAction, actions: [{ ...withAction.actions[0], disabled: true }] }]).has('live-position:entry:break-even')).toBe(false);
    const overlay = source('components/BacktestOrderLinesOverlay.tsx');
    // Efekt na `lines` = čistá `orderLineConfirmSync` (neaktivní značka, nikdy jen null); „Opravdu?“ jen u aktivního.
    expect(overlay).toMatch(/const next = orderLineConfirmSync\(current, lines\);\s*if \(next !== current\) \{ confirmingRef\.current = next; setConfirming\(next\); \}/);
    expect(overlay).toMatch(/const asking = \(key: string\) => confirming\?\.key === key && !confirming\.stale;/);
    expect(overlay).not.toMatch(/confirmingRef\.current = null; setConfirming\(null\); \}\s*\}, \[lines\]\)/);
    expect(overlay.match(/event\.currentTarget\.blur\(\);/g)).toHaveLength(2);
  });
});

/**
 * Složení tak, jak běží v overlayi (oponentura UI C7/C8 kolo 2, P2): klik → změna čar → EFEKT
 * (`orderLineConfirmSync`, React ho spustí před dalším klikem) → klik. Test jen poloviček
 * (krok bez efektu) dřív dával falešnou jistotu: s efektem, který potvrzení vynuloval, 2. klik odešel.
 */
describe('(f2) čáry grafu: složení klik → efekt (sync čar) → klik', () => {
  type Line = ReturnType<typeof livePositionChartLines>[number];
  const click = (state: ReturnType<typeof orderLineConfirmStep>['next'], line: Line, at: number) => (
    orderLineConfirmStep(state, cancelConfirmKey(line), line.confirmCancel, at)
  );
  const pendingSummary = {
    kind: 'pending', side: 'long', quantity: 1, entry: 25_000, stop: 24_990, target: 25_020, openPnl: null, mark: null, entryType: 'Limit',
  } as unknown as LiveChartPositionSummary;
  const filledSummary = { ...pendingSummary, kind: 'position', openPnl: 2, mark: 25_001 } as unknown as LiveChartPositionSummary;
  const pc = { manageable: true, canClose: true, entryAvg: 25_000, pointValue: 2 };
  const [pendingLine] = livePositionChartLines(pendingSummary, pc);
  const [filledLine] = livePositionChartLines(filledSummary, pc);
  const bareSummary = {
    kind: 'position', side: 'long', quantity: 2, entry: 25_000.25, stop: null, target: null, openPnl: 4, mark: 25_001.25, entryType: 'Market',
  } as unknown as LiveChartPositionSummary;
  const [bareLine] = livePositionChartLines(bareSummary, { manageable: false, entryAvg: null, pointValue: 2, bareClose: { entryOperationId: TRADE.entryOperationId } });
  const [blockedLine] = livePositionChartLines(bareSummary, { manageable: false, entryAvg: null, pointValue: 2 });
  const [managedLine] = livePositionChartLines({ ...bareSummary, stop: 24_990, target: 25_020 } as LiveChartPositionSummary, pc);

  it('předpoklady: PC čekající × dvoukrok, vyplněná pozice × JEDNOKLIK (stejná čára), holá → spravovaná jednoklik', () => {
    expect(pendingLine).toMatchObject({ id: 'live-position:entry', cancelAction: 'cancel-order', confirmCancel: true });
    expect(filledLine).toMatchObject({ id: 'live-position:entry', cancelAction: 'close-position', confirmCancel: false });
    expect(bareLine).toMatchObject({ id: liveBareLineId(TRADE.entryOperationId), confirmCancel: true });
    expect(blockedLine).toMatchObject({ id: 'live-position:entry', cancellable: false });
    expect(managedLine).toMatchObject({ id: 'live-position:entry', cancellable: true, cancelAction: 'close-position', confirmCancel: false });
  });

  it('PC čekající → vyplněno (starší ochrana 339c0fc5): klik po efektu NEZAVŘE právě otevřenou pozici', () => {
    const armed = click(null, pendingLine, 0);
    expect(armed.fire).toBe(false);
    const synced = orderLineConfirmSync(armed.next, [filledLine]);
    expect(synced).toMatchObject({ key: cancelConfirmKey(pendingLine), stale: true });
    const second = click(synced, filledLine, 1_500);
    expect(second).toEqual({ next: { key: cancelConfirmKey(filledLine), since: 1_500, until: 1_500 + 4_000 }, fire: false });
    // Dvojklik (+100 ms) po spolknutém kliku nic; teprve klik ≥ 350 ms od předchozího zavře.
    const dbl = click(second.next, filledLine, 1_600);
    expect(dbl.fire).toBe(false);
    expect(click(dbl.next, filledLine, 1_900).fire).toBe(false);
    expect(click(second.next, filledLine, 1_850).fire).toBe(true);
    // A bez efektu (klik dřív, než React efekt spustí) taky nic.
    expect(click(armed.next, filledLine, 1_500).fire).toBe(false);
  });

  it('holá → spravovaná (C8): potvrzovací klik po efektu NEZAVŘE spravovaný obchod', () => {
    const armed = click(null, bareLine, 0);
    const synced = orderLineConfirmSync(armed.next, [managedLine]);
    expect(synced?.stale).toBe(true);
    const swallowed = click(synced, managedLine, 1_000);
    expect(swallowed.fire).toBe(false);
    expect(click(swallowed.next, managedLine, 1_100).fire).toBe(false);
    expect(click(swallowed.next, managedLine, 1_350).fire).toBe(true);
  });

  it('holá → zablokováno → spravovaná, i čára na chvíli zmizí (vyplnění přes prázdný stav): nic', () => {
    const armed = click(null, bareLine, 0);
    let state = orderLineConfirmSync(armed.next, [blockedLine]);
    state = orderLineConfirmSync(state, [managedLine]);
    expect(click(state, managedLine, 1_200).fire).toBe(false);
    const armedPending = click(null, pendingLine, 0);
    let gone = orderLineConfirmSync(armedPending.next, []);
    expect(gone?.stale).toBe(true);
    gone = orderLineConfirmSync(gone, [filledLine]);
    expect(click(gone, filledLine, 900).fire).toBe(false);
  });

  it('zablokováno → vráceno se STEJNÝM klíčem (kolo 1 #3): klik je jen 1. krok nového dvoukroku', () => {
    const armed = click(null, bareLine, 0);
    let state = orderLineConfirmSync(armed.next, [blockedLine]);
    expect(state?.stale).toBe(true);
    state = orderLineConfirmSync(state, [bareLine]);
    // Vrácená nabídka značku neoživí.
    expect(state?.stale).toBe(true);
    const first = click(state, bareLine, 1_000);
    expect(first.fire).toBe(false);
    expect(first.next).toEqual({ key: cancelConfirmKey(bareLine), since: 1_000, until: 5_000 });
    // Nový dvoukrok nad vrácenou nabídkou: 2. klik ≥ 350 ms od předchozího odešle.
    expect(click(first.next, bareLine, 1_200).fire).toBe(false);
    expect(click(click(first.next, bareLine, 1_200).next, bareLine, 1_600).fire).toBe(true);
  });

  it('nabízený klíč se nezmění = potvrzení dál aktivní (2. klik odešle); po 4 s značka nic nebrání', () => {
    const armed = click(null, bareLine, 0);
    const kept = orderLineConfirmSync(armed.next, [bareLine, managedLine]);
    expect(kept).toBe(armed.next);
    expect(click(kept, bareLine, 500).fire).toBe(true);
    const stale = orderLineConfirmSync(click(null, pendingLine, 0).next, [filledLine]);
    expect(click(stale, filledLine, 4_001).fire).toBe(true);
    expect(orderLineConfirmSync(null, [filledLine])).toBeNull();
  });

  it('neaktivní značka NIKDY nespustí akci téhož klíče, ani kdyby byla bez potvrzení (× i tlačítko čáry)', () => {
    const stale = { key: cancelConfirmKey(filledLine), since: 0, until: 4_000, stale: true as const };
    expect(orderLineConfirmStep(stale, cancelConfirmKey(filledLine), false, 1_000)).toEqual({ next: { key: cancelConfirmKey(filledLine), since: 1_000, until: 5_000 }, fire: false });
    const staleBe = { key: 'live-position:entry:break-even', since: 0, until: 4_000, stale: true as const };
    expect(orderLineConfirmStep(staleBe, 'live-position:entry:break-even', false, 1_000)).toEqual({ next: { key: 'live-position:entry:break-even', since: 1_000, until: 5_000 }, fire: false });
    expect(orderLineConfirmStep(staleBe, 'live-position:entry:break-even', true, 1_000)).toEqual({ next: { key: 'live-position:entry:break-even', since: 1_000, until: 5_000 }, fire: false });
    // Jiná čára / jiné tlačítko bez potvrzení projde a značku nemění.
    expect(orderLineConfirmStep(staleBe, 'other:cancel:close-position:1', false, 1_000)).toEqual({ next: staleBe, fire: true });
  });

  it('neaktivní značka jiné čáry nebrání: přikoupení a BE mají vlastní dvoukrok; zablokované BE po návratu nic nepotvrdí', () => {
    const [, , , addLine] = livePositionChartLines(filledSummary, { ...pc, pendingAdd: { price: 24_980, quantity: 1, orderType: 'Limit' } });
    expect(addLine).toMatchObject({ id: 'live-position:pending-add', confirmCancel: true });
    const stale = orderLineConfirmSync(click(null, pendingLine, 0).next, [filledLine, addLine]);
    const addFirst = click(stale, addLine, 600);
    expect(addFirst.fire).toBe(false);
    expect(click(addFirst.next, addLine, 1_000).fire).toBe(true);
    // BE: zablokované tlačítko (disabled) zahodí potvrzení; po návratu je klik jen 1. krok.
    const beKey = 'live-position:entry:break-even';
    const beArmed = orderLineConfirmStep(null, beKey, true, 0);
    const withBe = { ...filledLine, actions: [{ id: 'break-even', label: 'BE', confirm: true, disabled: false }] };
    let beState = orderLineConfirmSync(beArmed.next, [{ ...withBe, actions: [{ ...withBe.actions[0], disabled: true }] }]);
    beState = orderLineConfirmSync(beState, [withBe]);
    expect(orderLineConfirmStep(beState, beKey, true, 800).fire).toBe(false);
  });
  // (f3) oponentura 4. 11.: přikoupení vyplněno → × pozice pod kurzorem; hranice času
  it('× přikoupení „Opravdu?“, přikoupení se vyplní a čára zmizí: klik na × pozice (jednoklik) se spolkne, dvojklik nic', () => {
    const [, , , addLine] = livePositionChartLines(filledSummary, { ...pc, pendingAdd: { price: 24_980, quantity: 1, orderType: 'Limit' } });
    const armed = click(null, addLine, 0);
    expect(armed.fire).toBe(false);
    const synced = orderLineConfirmSync(armed.next, [filledLine]);
    expect(synced).toMatchObject({ key: cancelConfirmKey(addLine), stale: true });
    const swallowed = click(synced, filledLine, 500);
    expect(swallowed).toEqual({ next: { key: cancelConfirmKey(filledLine), since: 500, until: 4_500 }, fire: false });
    expect(click(swallowed.next, filledLine, 600).fire).toBe(false);
    expect(click(swallowed.next, filledLine, 849).fire).toBe(false);
    expect(click(swallowed.next, filledLine, 850).fire).toBe(true);
    // Bez neaktivní značky (nic nebylo rozběhnuté) zůstává × pozice jednoklikové (Filip 30. 10.).
    expect(click(null, filledLine, 500).fire).toBe(true);
    // Aktivní (ne neaktivní) potvrzení přikoupení jednoklikové × pozice nespolkne — vědomý klik na jinou čáru.
    expect(click(armed.next, filledLine, 500).fire).toBe(true);
  });
  it('po spolknutí změna průměru (nový klíč) = znovu neaktivní; vypršení až po 4 s (until ostře)', () => {
    const armed = click(null, pendingLine, 0);
    const swallowed = click(orderLineConfirmSync(armed.next, [filledLine]), filledLine, 500);
    const moved = { ...filledLine, price: filledLine.price + 0.25 };
    const resynced = orderLineConfirmSync(swallowed.next, [moved]);
    expect(resynced?.stale).toBe(true);
    expect(click(resynced, moved, 900).fire).toBe(false);
    // Stejné čáry aktivní krok podrží.
    expect(orderLineConfirmSync(swallowed.next, [filledLine])).toBe(swallowed.next);
    // now === until: krok vypršel, jednoklik × projde.
    expect(click(swallowed.next, filledLine, 4_500).fire).toBe(true);
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
  it('UI používá jen liveConfirmClick / createLiveConfirmGate', () => {
    for (const file of [
      'components/LivePendingCancel.tsx', 'components/LiveSafetyControls.tsx', 'components/LiveOrderTicket.tsx', 'components/LiveTradingScreen.tsx',
      'components/TradovateLiveDesk.tsx', 'components/LiveCopyTradeOverview.tsx', 'components/day/LivePhoneChart.tsx', 'components/day/LivePhoneLiveActions.tsx',
      'hooks/liveCommandRuns.ts', 'hooks/useLiveConfirmGate.ts', 'lib/liveConfirmGate.ts', 'lib/liveCancelPendingUi.ts', 'lib/liveDeskCommands.ts', 'lib/liveBareCloseUi.ts',
    ]) {
      expect(source(file), file).not.toMatch(/cancelPendingConfirmStep/);
    }
  });
});
