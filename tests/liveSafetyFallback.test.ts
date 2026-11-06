import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  createFlattenGroupCoordinator,
  dashboardCommandLock,
  dashboardDialogBusy,
  liveSafetyBarNeed,
  liveSafetyBarVisible,
  liveSafetyFlattenMessage,
  liveSafetyNoticeClearedByArm,
  liveTopMenuBrakes,
  routeDashboardCommand,
  armBlockExclusionOutcome,
  armErrorYieldsToDialog,
  copierOffVerifiedForMenu,
  flattenRearmAllowed,
  liveSafetyGraceAfterNeed,
  liveSafetyNoticeExpires,
  armOutcomeNeedsDeskNotice,
  armTransitionConfirmed,
  liveSafetyVisibleExternalNotices,
} from '../lib/liveSafetyAction';
import { CopierArmBlockedError, createCopierArmGuard, sendCopierArm } from '../lib/copierArmPreparation';
import type { LocalCopierAgentCommandResult } from '../lib/localCopierAgentProtocol';
import { liveChartDisarmDuringArm } from '../lib/liveTradeGroupSource';
import { selectCopierSafetyRoute, type CopierAgentRoute } from '../lib/copierSafetyControls';
import { liveTabNavigationAllowed, type TradovateLiveTab } from '../lib/tradovateLiveTab';

vi.mock('react-dom', async importOriginal => {
  const actual = await importOriginal<typeof import('react-dom')>();
  return { ...actual, createPortal: (children: React.ReactNode) => children };
});
(globalThis as { document?: unknown }).document ??= { body: {} };

const { default: LiveSafetyControls } = await import('../components/LiveSafetyControls');

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const need = (patch: Partial<Parameters<typeof liveSafetyBarNeed>[0]> = {}) => liveSafetyBarNeed({
  tab: 'overview', chartCrashed: false, checkingConnection: false, requiresConnection: false,
  coldHold: false, overviewSlot: 'ready', ...patch,
});

describe('INV-UI-02: kdy se nouzová lišta vrátí', () => {
  it('běžný Dashboard, graf a záložky s daty lištu nemají', () => {
    expect(need()).toBe('none');
    expect(need({ tab: 'chart' })).toBe('none');
    expect(need({ tab: 'risk' })).toBe('none');
    expect(need({ tab: 'connections', checkingConnection: true })).toBe('none');
  });
  it('bez připojení a po pádu nebo selhání chunku hned', () => {
    expect(need({ requiresConnection: true })).toBe('now');
    expect(need({ tab: 'risk', requiresConnection: true })).toBe('now');
    expect(need({ overviewSlot: 'failed' })).toBe('now');
    expect(need({ overviewSlot: 'crashed' })).toBe('now');
    expect(need({ tab: 'chart', chartCrashed: true })).toBe('now');
  });
  it('ověřování připojení, studený start a načítání chunku až po prodlevě', () => {
    expect(need({ checkingConnection: true })).toBe('after-grace');
    expect(need({ coldHold: true })).toBe('after-grace');
    expect(need({ tab: 'events', coldHold: true })).toBe('after-grace');
    expect(need({ overviewSlot: 'loading' })).toBe('after-grace');
    expect(liveSafetyBarVisible('after-grace', false)).toBe(false);
    expect(liveSafetyBarVisible('after-grace', true)).toBe(true);
    expect(liveSafetyBarVisible('now', false)).toBe(true);
    expect(liveSafetyBarVisible('none', true)).toBe(false);
  });
  it('desk má jedinou instanci a zjistí selhaný chunk i pád', () => {
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk.match(/<LiveSafetyControls /g)).toHaveLength(1);
    expect(desk).toContain('onSlotState={setOverviewSlot}');
    expect(desk).toContain("onError={() => setOverviewSlot('crashed')}");
    expect(desk).toContain('onCrash={noteChartCrash}');
    expect(desk).toMatch(/name="LivePhoneChart" onError=\{\(\) => \{ rememberLiveChartCrash\(\); noteChartCrash\(\); \}\}/);
    const slot = source('components/LiveCopyTradeOverviewSlot.tsx');
    expect(slot).toContain("Component ? 'ready' : failed ? 'failed' : 'loading'");
    expect(slot).toContain('onSlotState?.(slotState)');
    expect(source('components/LiveTradingScreenSlot.tsx')).toContain('rememberLiveChartCrash(); onCrash?.();');
  });
});

describe('INV-UI-02: Dashboard je dosažitelný z každé záložky', () => {
  it.each<TradovateLiveTab>(['risk', 'events', 'connections', 'accounts', 'orders', 'chart'])('z %s i při čekající změně konfigurace', tab => {
    expect(liveTabNavigationAllowed(tab, 'overview', { configMutationPending: true, armFlowActive: true })).toBe(true);
  });
  it('tlačítko přehledu není zamčené', () => {
    expect(source('components/TradovateLiveDesk.tsx')).toContain("copyGroupStatusPollFence.inFlight) && item.id !== tab && item.id !== 'overview';");
  });
});

describe('INV-UI-02: fixní prvky bez lišty nad nativní lištou a BottomNav', () => {
  it('toast a tlačítko Graf používají zbytkové odsazení místo nuly', () => {
    expect(source('components/LiveCopyTradeOverview.tsx')).toContain("bottom: 'calc(var(--live-safety-height, var(--live-bottom-clear)) + 1.25rem)'");
    expect(source('components/TradovateLiveDesk.tsx')).toContain("bottom: 'calc(var(--live-safety-height, var(--live-bottom-clear)) + 6px)'");
    const css = source('index.css');
    expect(css).toMatch(/:root \{\s*--live-bottom-clear: calc\(env\(safe-area-inset-bottom, 0px\) \+ 5\.75rem\);/);
    expect(css).toMatch(/html\.native-shell \{\s*--live-bottom-clear: calc\(var\(--native-shell-tab-bar-height\) \+ 1rem\);/);
    expect(css).toContain('[data-live-safety-notices]');
  });
});

describe('INV-UI-02: Flatten All na Dashboardu mimo busyCommand', () => {
  it('běžný příkaz zámek drží, Flatten jím projde a cizí zámek neuvolní', () => {
    const idle = { busy: null, flattenRunning: false };
    const held = { busy: 'set-multiplier-2', flattenRunning: false };
    expect(dashboardCommandLock('set-multiplier', idle)).toBe('acquire');
    expect(dashboardCommandLock('set-multiplier', held)).toBe('blocked');
    expect(dashboardCommandLock('flatten-account', held)).toBe('blocked');
    expect(dashboardCommandLock('flatten-group', idle)).toBe('acquire');
    expect(dashboardCommandLock('flatten-group', held)).toBe('bypass');
    expect(dashboardCommandLock('flatten-group', { busy: null, flattenRunning: true })).toBe('blocked');
  });
  it('dialog Flatten zamkne jen běžící Flatten', () => {
    const held = { busy: 'set-multiplier-2', flattenRunning: false };
    expect(dashboardDialogBusy({ commandType: 'flatten-group' }, held)).toBe(false);
    expect(dashboardDialogBusy({ commandType: 'flatten-group' }, { busy: null, flattenRunning: true })).toBe(true);
    expect(dashboardDialogBusy({ commandType: 'set-multiplier' }, held)).toBe(true);
    expect(dashboardDialogBusy({ busyExempt: true }, held)).toBe(false);
  });
  it('runCommand zámek skutečně používá a drží ho jen ten, kdo ho vzal', () => {
    const overview = source('components/LiveCopyTradeOverview.tsx');
    const run = overview.slice(overview.indexOf('const runCommand = async ('), overview.indexOf('const saveGroup = async ('));
    expect(run).not.toContain('if (busyCommandRef.current) return false;');
    expect(run).toContain("if (lock === 'blocked') return false;");
    expect(run).toContain("if (lock === 'acquire') setBusyCommand(key);");
    expect(run).toContain("if (lock === 'acquire') setBusyCommand(null);");
    expect(overview).toContain('busy={dashboardDialogBusy({ commandType: pendingAction.command?.type');
  });
  it('Dashboard Flatten jde přes sdílený zámek skupiny, souběh nevytvoří druhý příkaz', async () => {
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk).toMatch(/flattenGroupId \? flattenCoordinator\.run\(flattenGroupId, run\) : run\(\)/);
    expect(desk).toContain("brake: flatten => executeSafetyCommand({ type: 'copy-command', command: flatten as");
    expect(desk).toContain('ordinary: dispatch,');
    expect(source('components/LiveCopyTradeOverview.tsx')).toContain('undefined, { confirmedTarget: action.confirmedTarget })');
    expect(source('components/LiveCopyTradeOverview.tsx').match(/danger: true, (flattenGroupId: group\.id, )?confirmedTarget: safetyTarget, command: \{/g)).toHaveLength(2);
    const coordinator = createFlattenGroupCoordinator();
    let calls = 0;
    const task = async () => { calls += 1; return 'flat'; };
    await Promise.all([coordinator.run('g', task), coordinator.run('g', task)]);
    expect(calls).toBe(1);
  });
});

describe('Hlášky a menu brzd', () => {
  it('chyba brzdy zapnutím kopírky nezmizí, informace ano', () => {
    expect(liveSafetyNoticeClearedByArm({ tone: 'error' }, true)).toBe(false);
    expect(liveSafetyNoticeClearedByArm({ tone: 'info' }, true)).toBe(true);
    expect(liveSafetyNoticeClearedByArm({ tone: 'info' }, false)).toBe(false);
  });
  it('dialog Flatten řekne stáří neověřeného cíle', () => {
    const target = { id: 'g', name: 'Test', accountIds: [1, 2], observedAt: 1_000, verified: false };
    expect(liveSafetyFlattenMessage(target, 91_000)).toContain('poslední stav před 1 min');
    expect(liveSafetyFlattenMessage({ ...target, verified: true }, 91_000)).not.toContain('Pozor');
    expect(liveSafetyFlattenMessage({ ...target, verified: true }, 91_000)).toContain('(2 účtů)');
  });
  it('OFF v menu chybí jen při prokazatelně vypnuté kopírce, Kill nezamkne starý status', () => {
    const base = { hasDisarm: true, hasKill: true, provablyOff: false, killActive: false, stateVerifying: false };
    expect(liveTopMenuBrakes(base).offerDisarm).toBe(true);
    expect(liveTopMenuBrakes({ ...base, provablyOff: true }).offerDisarm).toBe(false);
    expect(liveTopMenuBrakes({ ...base, killActive: true }).killDisabled).toBe(true);
    expect(liveTopMenuBrakes({ ...base, killActive: true, stateVerifying: true })).toMatchObject({ killDisabled: false, killShownActive: false });
    expect(liveTopMenuBrakes({ ...base, hasKill: false }).killDisabled).toBe(true);
  });
});

describe('INV-BRAKE-03: Flatten All z Dashboardu jde trasou brzdy', () => {
  const target = { id: 'g', name: 'Test', accountIds: [1, 2], observedAt: 1, verified: true };
  const last: CopierAgentRoute = { transport: 'relay', relayConnectionId: 'c1' };
  const flatResult = { type: 'flatten', accountIds: [1, 2], operationId: 'op', canceledOrders: 0, submittedClosures: 2, flat: true, remainingPositionAccounts: [], workingOrderAccounts: [] };
  const payload = (result?: unknown) => ({ status: { controller: { armed: false, killSwitch: false } }, result }) as LocalCopierAgentCommandResult;
  // Bez aktuálního agentTransport: brzda vezme poslední route, běžná cesta ji nezná (executeAgent).
  const deps = (result: unknown = flatResult) => {
    const sent: Array<{ type: string; groupId?: string; route: CopierAgentRoute }> = [];
    const notices: Array<{ tone: string; text: string }> = [];
    return {
      sent,
      notices,
      currentTarget: () => target,
      onBrakeResult: (notice: { tone: string; text: string }) => { notices.push(notice); },
      brake: async (command: { type: string; groupId: string }) => {
        const route = selectCopierSafetyRoute(last, null, false);
        if (!route) throw new Error('bez route');
        sent.push({ type: command.type, groupId: command.groupId, route });
        return payload(result);
      },
      ordinary: async (): Promise<LocalCopierAgentCommandResult> => { throw new Error('Chybí aktivní Tradovate připojení pro Mac worker relay.'); },
    };
  };
  it('bez aktuální route Flatten All projde poslední route, flatten-account ne', async () => {
    const flatten = deps();
    await routeDashboardCommand({ type: 'flatten-group', groupId: 'g' }, target, flatten);
    expect(flatten.sent).toEqual([{ type: 'flatten-group', groupId: 'g', route: last }]);
    expect(flatten.notices).toEqual([{ tone: 'info', text: expect.stringContaining('2 účtů je flat') }]);
    for (const type of ['flatten-account', 'flatten-follower-trade', 'set-multiplier']) {
      const other = deps();
      await expect(routeDashboardCommand({ type }, target, other)).rejects.toThrow('Chybí aktivní');
      expect(other.sent).toEqual([]);
      expect(other.notices).toEqual([]);
    }
  });
  it('změněný nebo chybějící cíl Flatten neodešle a řekne to hláškou', async () => {
    for (const confirmed of [null, undefined, { ...target, id: 'jina' }, { ...target, accountIds: [1, 3] }]) {
      const run = deps();
      await expect(routeDashboardCommand({ type: 'flatten-group', groupId: 'g' }, confirmed, run)).rejects.toThrow('nebyl odeslán');
      expect(run.sent).toEqual([]);
      expect(run.notices[0].tone).toBe('error');
    }
    const gone = { ...deps(), currentTarget: () => null };
    await expect(routeDashboardCommand({ type: 'flatten-group', groupId: 'g' }, target, gone)).rejects.toThrow('nebyl odeslán');
  });
  it('(5) knihovna má jiné ID skupiny: příkaz i zámek jdou na skupinu workeru', async () => {
    const worker = { ...target, id: 'worker-id' };
    const coordinator = createFlattenGroupCoordinator();
    const sent: string[] = [];
    await routeDashboardCommand({ type: 'flatten-group', groupId: 'library-id' }, worker, {
      currentTarget: () => worker,
      ordinary: async () => payload(flatResult),
      brake: command => coordinator.run(command.groupId, async () => {
        sent.push(command.groupId);
        expect(coordinator.pending('worker-id')).toBe(true);
        expect(coordinator.pending('library-id')).toBe(false);
        return payload(flatResult);
      }),
    });
    expect(sent).toEqual(['worker-id']);
  });
  it('(2) flat:false i reject skončí hláškou v desku, nezávisle na přehledu', async () => {
    const notFlat = deps({ ...flatResult, flat: false, remainingPositionAccounts: [2] });
    await expect(routeDashboardCommand({ type: 'flatten-group', groupId: 'g' }, target, notFlat)).rejects.toThrow('není potvrzený');
    expect(notFlat.notices).toEqual([{ tone: 'error', text: expect.stringContaining('není potvrzený') }]);
    const rejected = { ...deps(), notices: [] as Array<{ tone: string; text: string }>, brake: async () => { throw new Error('Relay spadl.'); } };
    rejected.onBrakeResult = notice => { rejected.notices.push(notice); };
    await expect(routeDashboardCommand({ type: 'flatten-group', groupId: 'g' }, target, rejected)).rejects.toThrow('Relay spadl');
    expect(rejected.notices[0]).toEqual({ tone: 'error', text: expect.stringContaining('Výsledek neověřen') });
    const html = renderToStaticMarkup(React.createElement(LiveSafetyControls, {
      target: null, onAction: async () => '', flattenCoordinator: createFlattenGroupCoordinator(), copierArmed: true, hideBar: true,
      externalNotices: [{ tone: 'error', text: 'Flatten není potvrzený.', at: 1 }],
    }));
    expect(html).toContain('Flatten není potvrzený.');
    expect(html).toContain('aria-label="Zavřít hlášku"');
    expect(html).not.toContain('Nouzové ovládání');
  });
  it('(6) Flatten bez výsledku nebo s nekrytými účty je chyba, ne potvrzení', async () => {
    const missing = deps(null);
    await expect(routeDashboardCommand({ type: 'flatten-group', groupId: 'g' }, target, missing)).rejects.toThrow('Chybí potvrzený výsledek');
    expect(missing.notices[0].tone).toBe('error');
    const partial = deps({ ...flatResult, accountIds: [1] });
    await expect(routeDashboardCommand({ type: 'flatten-group', groupId: 'g' }, target, partial)).rejects.toThrow('nepokrývá');
    expect(partial.notices[0].tone).toBe('error');
    expect(flattenRearmAllowed(undefined)).toBe(false);
    expect(flattenRearmAllowed({ ...flatResult, pending: true })).toBe(false);
    expect(flattenRearmAllowed({ ...flatResult, flat: false })).toBe(false);
    expect(flattenRearmAllowed(flatResult)).toBe(true);
    const overview = source('components/LiveCopyTradeOverview.tsx');
    expect(overview).toContain("command.type === 'flatten-group' && flattenRearmAllowed(result)");
    expect(overview).toContain('void runCopierTransition(groupId, true, () => arm());');
  });
  it('(7) ACK po novějším OFF: chyba, žádné potvrzení', async () => {
    const stale = 'Příkaz doběhl po novější bezpečnostní akci. Výsledek není ověřen; UI zachovalo novější bezpečnější stav.';
    const run = { ...deps(), notices: [] as Array<{ tone: string; text: string }>, brake: async () => { throw new Error(stale); } };
    run.onBrakeResult = notice => { run.notices.push(notice); };
    await expect(routeDashboardCommand({ type: 'flatten-group', groupId: 'g' }, target, run)).rejects.toThrow('novější bezpečnostní akci');
    expect(run.notices).toHaveLength(1);
    expect(run.notices[0].tone).toBe('error');
    expect(source('components/TradovateLiveDesk.tsx')).toContain(stale);
  });
});

describe('Kolo 2: ARM po zavření, souběh, zapínání', () => {
  const open = { mounted: true, intentGroupId: 'g', openGroupId: 'g', dialogCovered: false, groupId: 'g' };
  it('(1) vyřazení + zavření průvodce = žádný arm-live', () => {
    expect(armBlockExclusionOutcome(open)).toBe('arm');
    expect(armBlockExclusionOutcome({ ...open, intentGroupId: null })).toBe('stay-off');
    expect(armBlockExclusionOutcome({ ...open, openGroupId: null })).toBe('stay-off');
    expect(armBlockExclusionOutcome({ ...open, mounted: false })).toBe('stay-off');
    expect(armBlockExclusionOutcome({ ...open, dialogCovered: true })).toBe('stay-off');
    expect(armBlockExclusionOutcome({ ...open, openGroupId: 'jina' })).toBe('stay-off');
    const overview = source('components/LiveCopyTradeOverview.tsx');
    const then = overview.slice(overview.indexOf('const outcome = armBlockExclusionOutcome('), overview.indexOf('onCloseAccount={accountId => {'));
    expect(then).toContain("if (outcome !== 'arm') {");
    expect(then.indexOf("if (outcome !== 'arm') {")).toBeLessThan(then.indexOf('requestGroupPower('));
    expect(then).toContain('Účet vyřazen, kopírka zůstává vypnutá.');
    expect(overview).toMatch(/onClose=\{\(\) => \{\s*armAfterExclusionRef\.current = null;\s*setPendingArmBlockGroupId\(null\);/);
  });
  it('(3) během Flattenu nezačne žádný jiný příkaz, ani bez drženého zámku', () => {
    const running = { busy: null, flattenRunning: true };
    expect(dashboardCommandLock('set-multiplier', running)).toBe('blocked');
    expect(dashboardCommandLock('set-follower-enabled', running)).toBe('blocked');
    expect(dashboardDialogBusy({ commandType: 'set-multiplier' }, running)).toBe(true);
    expect(dashboardDialogBusy({}, running)).toBe(true);
    const overview = source('components/LiveCopyTradeOverview.tsx');
    expect(overview).toContain('if (busyCommandRef.current || flattenRunningNow()) return;\n              setBusyCommand(\'confirmed-runtime-action\');');
    expect(overview).toContain('while ((busyCommandRef.current || flattenRunningNow()) && Date.now() < idleBy)');
    expect(overview.match(/connectBlocked=\{copierKillSwitch \|\| dayLockUntil > Date\.now\(\) \|\| pauseActive \|\| flattenRunning\}/g)).toHaveLength(2);
    expect(overview).toContain('Běží Flatten All, kopírka se teď nezapne.');
  });
  it('(4) zapínání na pozadí: OFF je vidět v menu i v grafu', () => {
    expect(copierOffVerifiedForMenu(true, false)).toBe(true);
    expect(copierOffVerifiedForMenu(true, true)).toBe(false);
    expect(liveChartDisarmDuringArm(null, false)).toBeNull();
    expect(liveChartDisarmDuringArm(null, true)).toEqual({ label: 'Vypnout kopírku', unverified: false });
    const verified = { label: 'Zrušit automatické pokračování', unverified: true };
    expect(liveChartDisarmDuringArm(verified, true)).toBe(verified);
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk).toContain('disarm={liveChartDisarmDuringArm(chartData.disarm, armFlowActive)}');
    expect(desk).toContain('copierOffVerified={copierOffVerifiedForMenu(');
  });
  it('drobnosti: chyba ARM ustoupí Flattenu, lišta neproblikne, chyba hlášky nevyprší', () => {
    expect(armErrorYieldsToDialog({ command: { type: 'flatten-group' } })).toBe(true);
    expect(armErrorYieldsToDialog({ command: { type: 'set-multiplier' } })).toBe(false);
    expect(armErrorYieldsToDialog(null)).toBe(false);
    expect(liveSafetyGraceAfterNeed('none', true)).toBe(false);
    expect(liveSafetyGraceAfterNeed('now', false)).toBe(true);
    expect(liveSafetyGraceAfterNeed('after-grace', true)).toBe(true);
    expect(liveSafetyGraceAfterNeed('after-grace', false)).toBe(false);
    expect(liveSafetyNoticeExpires({ tone: 'error' })).toBe(false);
    expect(liveSafetyNoticeExpires({ tone: 'info' })).toBe(true);
    const overview = source('components/LiveCopyTradeOverview.tsx');
    expect(overview).toMatch(/const yieldsToDialog = armErrorYieldsToDialog\(pendingActionRef\.current\);[\s\S]{0,240}if \(yieldsToDialog\) \{/);
    expect(overview).toContain('if (commandBusy != null) reopenArmBlockRef.current = null;');
    expect(overview).toContain('setEditorGroup(current => (current === editorAtSave ? null : current));');
    expect(source('components/LiveSafetyControls.tsx')).toContain('if (!liveSafetyNoticeExpires(notice)) return undefined;');
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk).toContain("if (liveTabRef.current !== 'risk') {");
    expect(desk).toContain("if (liveTabRef.current !== 'chart') return;");
  });
});

describe('INV-UI-02: busy dialog Dashboardu jde zavřít', () => {
  const noop = () => undefined;
  const closeButton = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0] ?? '';
  it('běžící příkaz: Zavřít je aktivní, potvrzení zamčené', async () => {
    const { ConfirmActionDialog } = await import('../components/LiveCopyTradeOverview');
    const action = { title: 'Násobek?', detail: 'x', confirmLabel: 'Uložit', command: { type: 'set-multiplier' as const, groupId: 'g', accountId: 2, multiplier: 2 } };
    const html = renderToStaticMarkup(React.createElement(ConfirmActionDialog, { action, busy: true, apiReady: true, onClose: noop, onConfirm: noop }));
    expect(closeButton(html, 'Zavřít, běží dál')).not.toBe('');
    expect(closeButton(html, 'Zavřít, běží dál')).not.toContain('disabled=""');
    expect(closeButton(html, 'Připravuji…')).toContain('disabled=""');
    const idle = renderToStaticMarkup(React.createElement(ConfirmActionDialog, { action, busy: false, apiReady: true, onClose: noop, onConfirm: noop }));
    expect(idle).toContain('>Zrušit</button>');
  });
  it('informační dialog nedrží obrazovku ani při běžícím příkazu', async () => {
    const { ConfirmActionDialog } = await import('../components/LiveCopyTradeOverview');
    const action = { title: 'Blokováno', detail: 'x', confirmLabel: 'Rozumím', blocked: true };
    const html = renderToStaticMarkup(React.createElement(ConfirmActionDialog, { action, busy: true, apiReady: true, onClose: noop, onConfirm: noop }));
    expect(closeButton(html, 'Rozumím')).not.toContain('disabled=""');
  });
  it('ostatní dialogy: zavírací tlačítka bez zámku, chyba zavřeného dialogu přijde toastem', () => {
    const overview = source('components/LiveCopyTradeOverview.tsx');
    expect(overview).not.toMatch(/onClick=\{onClose\} disabled=\{(busy|saving)\}/);
    expect(overview).toContain("if (editorGroupRef.current !== editorGroup) setToast({ tone: 'error', text });");
    expect(overview).toContain("if (!pendingUnavailableRemovalRef.current) setToast({ tone: 'error', text: message });");
  });
});

describe('Kolo 3: brzda ruší neodeslané zapnutí', () => {
  const flow = (patch: Partial<Parameters<typeof sendCopierArm<{ id: string }>>[0]> = {}) => {
    const sent: string[] = [];
    let epoch = 0;
    const coordinator = createFlattenGroupCoordinator();
    const guard = createCopierArmGuard({ cancelEpoch: () => epoch, flattenPending: coordinator.anyPending });
    return {
      sent, coordinator, guard,
      brake: () => { epoch += 1; },
      deps: {
        guard,
        arm: async () => { guard(); sent.push('arm-live'); },
        retirementFromError: () => null,
        confirmRetirement: async () => true,
        activate: async () => { guard(); sent.push('activate-group'); },
        ...patch,
      },
    };
  };
  it('bez brzdy arm-live odejde', async () => {
    const run = flow();
    await sendCopierArm(run.deps);
    expect(run.sent).toEqual(['arm-live']);
  });
  it('OFF nebo Kill během čekání na snímky: arm-live neodejde', async () => {
    const run = flow();
    const waitForSnapshotReady = Promise.resolve().then(run.brake);
    await waitForSnapshotReady;
    await expect(sendCopierArm(run.deps)).rejects.toThrow('Zapnutí zrušeno brzdou');
    await expect(sendCopierArm(run.deps)).rejects.toBeInstanceOf(CopierArmBlockedError);
    expect(run.sent).toEqual([]);
  });
  it('pojistka platí i pro arm bez vlastní kontroly', async () => {
    const run = flow({ arm: async () => { run.sent.push('arm-live'); } });
    run.brake();
    await expect(sendCopierArm(run.deps)).rejects.toThrow('Zapnutí zrušeno brzdou');
    expect(run.sent).toEqual([]);
  });
  it('brzda v dialogu vyřazení: activate-group ani arm-live neodejdou', async () => {
    const box: { brake?: () => void } = {};
    let first = true;
    const run = flow({
      arm: async () => { if (first) { first = false; throw new Error('retire'); } run.sent.push('arm-live'); },
      retirementFromError: () => ({ id: 'old' }),
      confirmRetirement: async () => { box.brake?.(); return true; },
      activate: async () => { run.sent.push('activate-group'); },
    });
    box.brake = run.brake;
    await expect(sendCopierArm(run.deps)).rejects.toThrow('Zapnutí zrušeno brzdou');
    expect(run.sent).toEqual([]);
  });
  it('brzda během activate-group: následný arm-live neodejde', async () => {
    let first = true;
    const run = flow({
      arm: async () => { if (first) { first = false; throw new Error('retire'); } run.sent.push('arm-live'); },
      retirementFromError: () => ({ id: 'old' }),
      activate: async () => { run.sent.push('activate-group'); run.brake(); },
    });
    await expect(sendCopierArm(run.deps)).rejects.toThrow('Zapnutí zrušeno brzdou');
    expect(run.sent).toEqual(['activate-group']);
  });
  it('Flatten mimo Dashboard nebo po remountu přehledu: ON odmítnuto, po doběhnutí projde', async () => {
    const run = flow();
    let finish!: () => void;
    const shiftF = run.coordinator.run('worker', () => new Promise<void>(resolve => { finish = resolve; }));
    await Promise.resolve();
    expect(run.coordinator.anyPending()).toBe(true);
    await expect(sendCopierArm(run.deps)).rejects.toThrow('Běží Flatten All');
    expect(run.sent).toEqual([]);
    finish();
    await shiftF;
    expect(run.coordinator.anyPending()).toBe(false);
    // Nové ON má novou pojistku (i rearm po Flattenu).
    const again = flow();
    await expect(sendCopierArm(again.deps)).resolves.toBe(true);
    expect(again.sent).toEqual(['arm-live']);
  });
  it('Flatten start i konec mezi vytvořením guardu a odesláním = arm-live neodejde', async () => {
    const run = flow();
    run.brake(); // executeSafetyCommand zvedá epochu i u flatten-group
    await run.coordinator.run('worker', async () => 'flat');
    expect(run.coordinator.anyPending()).toBe(false);
    await expect(sendCopierArm(run.deps)).rejects.toThrow('Flatten All');
    expect(run.sent).toEqual([]);
  });
  it('hlášky říkají jen to, co platí', async () => {
    const run = flow();
    run.brake();
    await expect(sendCopierArm(run.deps)).rejects.toThrow('Tímto požadavkem se kopírka nezapnula, skutečný stav ukazuje přehled.');
    let first = true;
    const switched = flow({
      arm: async () => { if (first) { first = false; throw new Error('retire'); } switched.sent.push('arm-live'); },
      retirementFromError: () => ({ id: 'old' }),
      activate: async () => { switched.sent.push('activate-group'); switched.brake(); },
    });
    await expect(sendCopierArm(switched.deps)).rejects.toThrow('Skupina se mohla přepnout a účty vyřadit, ARM se neodeslal');
    expect(switched.sent).toEqual(['activate-group']);
    const source_ = source('lib/copierArmPreparation.ts');
    expect(source_).not.toContain('Nic se neodeslalo');
  });
  it('toast „připojený“ jen po potvrzeném ARM, zrušený dialog nic nehlásí', async () => {
    const run = flow();
    await expect(sendCopierArm(run.deps)).resolves.toBe(true);
    let first = true;
    const declined = flow({
      arm: async () => { if (first) { first = false; throw new Error('retire'); } },
      retirementFromError: () => ({ id: 'old' }),
      confirmRetirement: async () => false,
    });
    await expect(sendCopierArm(declined.deps)).resolves.toBe(false);
    expect(armTransitionConfirmed(true)).toBe(true);
    expect(armTransitionConfirmed(false)).toBe(false);
    expect(armTransitionConfirmed(undefined)).toBe(false);
    expect(source('components/LiveCopyTradeOverview.tsx')).toMatch(/const outcome = await action\(\);\s*if \(request !== copierTransitionRequest\.current\) return;[\s\S]{0,120}if \(connecting && !armTransitionConfirmed\(outcome\)\) return;/);
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk).toContain('if (!armOffer.repairable && !repair) return false;');
    expect(desk).toContain('if (!acknowledged) return false;');
    expect(desk).toContain('return sendCopierArm({');
    expect(desk).toContain("armGuard();\n        acceptAgentStatus((await executeAgent({\n          type: 'snapshot-test',");
  });
  it('desk zvedá epochu synchronně a hlídá těsně před odesláním', () => {
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk).toMatch(/lock-until-session-end'; reason: string \}\) => \{\s*armCancelEpochRef\.current \+= 1;\s*const run = async/);
    expect(desk).toMatch(/const prepared = prepare\(\);\s*armGuard\(\);\s*const result = await executeAgent\(\{\s*type: 'arm-live'/);
    expect(desk).toMatch(/const group = prepare\(\)\.group;\s*armGuard\(\);\s*acceptConfigAck\(\(await executeAgent\(\{\s*type: 'activate-group'/);
    expect(desk).toContain('flattenPending: flattenCoordinator.anyPending');
    const overview = source('components/LiveCopyTradeOverview.tsx');
    expect(overview).toContain('useSyncExternalStore(flattenCoordinator.subscribe, flattenCoordinator.anyPending, () => false)');
    expect(overview).toContain('const flattenRunning = localFlattenRunning || flattenElsewhere;');
    expect(overview).toContain('flattenRunningRef.current || flattenCoordinator.anyPending()');
    expect(overview).not.toContain('výsledek zapnutí se pak zahodí');
    expect(desk).toContain('flattenCoordinator={flattenCoordinator}');
  });
});

describe('Kolo 3: hlášky ve vlastních slotech', () => {
  const flattenError = { tone: 'error' as const, text: 'Flatten selhal.', at: 1 };
  const risk = { tone: 'error' as const, text: 'Risk se neuložil.', at: 2 };
  const info = { tone: 'info' as const, text: 'Flatten potvrzen.', at: 3 };
  it('chyba Flatten vedle jiné hlášky zůstává, i se zapnutou kopírkou, do ×', () => {
    expect(liveSafetyVisibleExternalNotices([flattenError, risk], [], true)).toEqual([flattenError, risk]);
    expect(liveSafetyVisibleExternalNotices([flattenError, risk], [risk], false)).toEqual([flattenError]);
    expect(liveSafetyVisibleExternalNotices([info, null], [], true)).toEqual([]);
    expect(liveSafetyVisibleExternalNotices([info, undefined], [], false)).toEqual([info]);
  });
  it('desk má pro Flatten samostatný slot a lišta kvůli němu nesahá na epochu', () => {
    const desk = source('components/TradovateLiveDesk.tsx');
    expect(desk).toContain('onBrakeResult: result => setFlattenNotice(');
    expect(desk).toContain('externalNotices={[flattenNotice, deskSafetyNotice]}');
    const controls = source('components/LiveSafetyControls.tsx');
    expect(controls.match(/noticeEpoch\.current/g)).toHaveLength(3);
    const html = renderToStaticMarkup(React.createElement(LiveSafetyControls, {
      target: null, onAction: async () => '', flattenCoordinator: createFlattenGroupCoordinator(), copierArmed: false, hideBar: true,
      externalNotices: [flattenError, risk],
    }));
    expect(html).toContain('Flatten selhal.');
    expect(html).toContain('Risk se neuložil.');
  });
  it('„Přesto vypnout“ nezamkne cizí příkaz, neznámý výsledek jde i do desku', () => {
    const overview = source('components/LiveCopyTradeOverview.tsx');
    expect(overview.match(/confirmLabel: 'Přesto vypnout',\s*danger: true,\s*busyExempt: true,/g)).toHaveLength(2);
    expect(overview).toContain('mounted: overviewMountedRef.current })) onSafetyNotice?.(outcomeText);');
    expect(armOutcomeNeedsDeskNotice({ rejected: false, yieldsToDialog: false, mounted: true })).toBe(true);
    expect(armOutcomeNeedsDeskNotice({ rejected: true, yieldsToDialog: true, mounted: true })).toBe(true);
    expect(armOutcomeNeedsDeskNotice({ rejected: true, yieldsToDialog: false, mounted: false })).toBe(true);
    expect(armOutcomeNeedsDeskNotice({ rejected: true, yieldsToDialog: false, mounted: true })).toBe(false);
  });
});
