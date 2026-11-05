import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  LIVE_HOTKEYS_STORAGE_KEY,
  LIVE_HOTKEY_FLATTEN_UNAVAILABLE,
  LIVE_HOTKEY_OVERLAY_SELECTOR,
  LIVE_HOTKEY_REPLAY_TEXT,
  dispatchLiveHotkeyOutcome,
  liveHotkeyOverlayOpen,
  liveHotkeyReplayBlocked,
  readLiveHotkeysEnabled,
  writeLiveHotkeysEnabled,
  type LiveHotkeyHandlers,
} from '../components/LiveHotkeysHelp';
import { liveSafetyShortcutListener } from '../components/LiveSafetyControls';
import { createLiveSafetyShortcutBus, type LiveSafetyShortcutView } from '../lib/liveSafetyShortcut';
import { liveHotkeyAction, resolveLiveHotkey, type LiveHotkeyIntent } from '../lib/liveHotkeys';
import { livePositionChartLines } from '../lib/liveChartOrderLines';
import type { LiveChartPositionSummary } from '../lib/liveChartPosition';
import type { BacktestChartOrderLine } from '../services/backtestOrderLines';

/**
 * Vlna B3 (PC graf): zapojení U1 (zkratky), U3-PC (pojistka přehrávání), U4 (šipky
 * plnění), U5 (pracující příkazy jen pro zobrazení) a U7 (zvuk při fillu). Nic z toho
 * neautorizuje příkaz (INV-UI-01..04): klávesa jen vyplní panel, nebo spustí TUTÉŽ
 * funkci jako čára; Shift+F jen otevře dialog Flatten All.
 */

const source = (path: string) => readFileSync(path, 'utf8');
const between = (text: string, start: string, end: string) => {
  const from = text.indexOf(start);
  expect(from, start).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return text.slice(from, to);
};

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
};

const handlers = (overrides: Partial<LiveHotkeyHandlers> = {}) => ({
  prefill: vi.fn(),
  discard: vi.fn(),
  breakEven: vi.fn(),
  cancelLine: vi.fn(),
  notice: vi.fn(),
  openFlatten: vi.fn(() => true),
  toggleHelp: vi.fn(),
  ...overrides,
});
const calledOnly = (spy: ReturnType<typeof handlers>, name: keyof ReturnType<typeof handlers>) => {
  for (const [key, fn] of Object.entries(spy)) {
    if (key === name) expect(fn, key).toHaveBeenCalled();
    else expect(fn, key).not.toHaveBeenCalled();
  }
};

const summary = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => ({
  kind: 'position', side: 'long', quantity: 1, entry: 21000, entryType: 'Market', stop: 20990, target: 21020,
  mark: 21005, openPnl: 10, accounts: 1, scopeLabel: null, leader: { accountId: 1, entry: 21000, quantity: 1 },
  ...patch,
} as unknown as LiveChartPositionSummary);
const positionLines = (canClose: boolean, patch: Partial<LiveChartPositionSummary> = {}) => livePositionChartLines(summary(patch), {
  manageable: true, canClose, entryAvg: 21000, pointValue: 2,
});
const key = (patch: Record<string, unknown>) => ({ key: '', target: null, ...patch });

describe('U1: přepínač zkratek je opt-in (výchozí vypnuto)', () => {
  it('bez volby, s jinou hodnotou i s rozbitým úložištěm = vypnuto', () => {
    expect(readLiveHotkeysEnabled(null)).toBe(false);
    expect(readLiveHotkeysEnabled(memoryStorage())).toBe(false);
    expect(readLiveHotkeysEnabled(memoryStorage({ [LIVE_HOTKEYS_STORAGE_KEY]: 'true' }))).toBe(false);
    expect(readLiveHotkeysEnabled({ getItem: () => { throw new Error('denied'); } })).toBe(false);
    expect(readLiveHotkeysEnabled(memoryStorage({ [LIVE_HOTKEYS_STORAGE_KEY]: '1' }))).toBe(true);
  });

  it('zápis zapne jen „1“, vypnutí klíč smaže; chyba úložiště nic nevyhodí', () => {
    const storage = memoryStorage();
    writeLiveHotkeysEnabled(storage, true);
    expect(storage.data.get(LIVE_HOTKEYS_STORAGE_KEY)).toBe('1');
    writeLiveHotkeysEnabled(storage, false);
    expect(storage.data.has(LIVE_HOTKEYS_STORAGE_KEY)).toBe(false);
    expect(() => writeLiveHotkeysEnabled({ getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} }, true)).not.toThrow();
  });

  it('obrazovka čte volbu při startu a posluchač kláves instaluje jen se zapnutými zkratkami', () => {
    const screen = source('components/LiveTradingScreen.tsx');
    expect(screen).toMatch(/useState\(\(\) => readLiveHotkeysEnabled\(liveHotkeysStorage\(\)\)\)/);
    expect(screen).toMatch(/if \(!hotkeysOn\) return undefined;/);
    expect(screen).toMatch(/hotkeyHandlerRef\.current = \(event, fromChartEscape\) => \{\n\s*if \(!hotkeysOn\) return;/);
  });
});

describe('U1: dialog nebo menu na obrazovce = klávesy patří jemu', () => {
  const element = (rects: number) => ({ getClientRects: () => ({ length: rects }) });
  it('viditelný dialog/menu blokuje, skrytý ne; neznámý stav blokuje', () => {
    expect(LIVE_HOTKEY_OVERLAY_SELECTOR).toMatch(/\[role="dialog"\]/);
    expect(LIVE_HOTKEY_OVERLAY_SELECTOR).toMatch(/\[role="menu"\]/);
    expect(liveHotkeyOverlayOpen({ querySelectorAll: () => [] })).toBe(false);
    expect(liveHotkeyOverlayOpen({ querySelectorAll: () => [element(0)] })).toBe(false);
    expect(liveHotkeyOverlayOpen({ querySelectorAll: () => [element(0), element(1)] })).toBe(true);
    expect(liveHotkeyOverlayOpen({ querySelectorAll: () => { throw new Error('bad selector'); } })).toBe(true);
    expect(liveHotkeyOverlayOpen(null)).toBe(true);
  });

  it('nápověda zkratek není dialog ani menu (zkratky v ní fungují a Esc ji zavře)', () => {
    const help = source('components/LiveHotkeysHelp.tsx');
    const panel = between(help, 'data-live-hotkeys-help', '</div>}');
    expect(help).toMatch(/role="group"\s+aria-label="Klávesové zkratky LIVE"/);
    expect(panel).not.toMatch(/role="(dialog|menu|alertdialog)"|aria-modal/);
  });
});

describe('U3-PC: zkratky během přehrávání v grafu', () => {
  const kinds: LiveHotkeyIntent[] = [
    { kind: 'new-draft', side: 'buy' }, { kind: 'new-draft', side: 'sell' }, { kind: 'break-even' },
    { kind: 'close-position' }, { kind: 'cancel-pending' },
  ];
  it('nic nenavrhnou ani nespustí; Flatten dialog, nápověda a zahození návrhu zůstávají', () => {
    for (const intent of kinds) {
      expect(liveHotkeyReplayBlocked(intent, true), intent.kind).toBe(LIVE_HOTKEY_REPLAY_TEXT);
      expect(liveHotkeyReplayBlocked(intent, false), intent.kind).toBeNull();
    }
    for (const intent of [{ kind: 'flatten-dialog' }, { kind: 'help' }, { kind: 'discard-draft' }] as LiveHotkeyIntent[]) {
      expect(liveHotkeyReplayBlocked(intent, true), intent.kind).toBeNull();
    }
    // Neznámý stav přehrávání = jako přehrávání.
    expect(liveHotkeyReplayBlocked({ kind: 'break-even' }, undefined as unknown as boolean)).toBe(LIVE_HOTKEY_REPLAY_TEXT);
  });
});

describe('U1: výsledek zkratky → funkce obrazovky', () => {
  const closeLine = () => positionLines(true)[0];

  it('Shift+B/S jen předvyplní panel', () => {
    const spy = handlers();
    dispatchLiveHotkeyOutcome({ kind: 'prefill-draft', side: 'buy' }, spy);
    calledOnly(spy, 'prefill');
    expect(spy.prefill).toHaveBeenCalledWith('buy');
  });

  it('BE jen přes tlačítko BE čáry; čára bez BE = nic', () => {
    const line = positionLines(false)[0];
    expect(line.actions?.[0]?.id).toBe('break-even');
    const spy = handlers();
    dispatchLiveHotkeyOutcome({ kind: 'run', command: 'break-even', line, price: 21000.25 }, spy);
    calledOnly(spy, 'breakEven');
    expect(spy.breakEven).toHaveBeenCalledWith(line);
    const without = handlers();
    dispatchLiveHotkeyOutcome({ kind: 'run', command: 'break-even', line: { ...line, actions: undefined }, price: 21000.25 }, without);
    calledOnly(without, 'notice');
  });

  it('zavřít / zrušit čekající jen přes × téže čáry a jen se shodným významem ×', () => {
    const close = closeLine();
    expect(close).toMatchObject({ cancellable: true, cancelAction: 'close-position' });
    const spy = handlers();
    dispatchLiveHotkeyOutcome({ kind: 'run', command: 'close-position', line: close, price: close.price }, spy);
    calledOnly(spy, 'cancelLine');
    expect(spy.cancelLine).toHaveBeenCalledWith(close);
    // Potvrzení „zrušit čekající“ nikdy nezavře pozici (× mezitím zavírá).
    const mismatch = handlers();
    dispatchLiveHotkeyOutcome({ kind: 'run', command: 'cancel-pending', line: close, price: close.price }, mismatch);
    calledOnly(mismatch, 'notice');
    const pending = positionLines(false, { kind: 'pending' })[0];
    expect(pending).toMatchObject({ cancellable: true, cancelAction: 'cancel-order' });
    const cancel = handlers();
    dispatchLiveHotkeyOutcome({ kind: 'run', command: 'cancel-pending', line: pending, price: pending.price }, cancel);
    calledOnly(cancel, 'cancelLine');
    const notCancellable = handlers();
    dispatchLiveHotkeyOutcome({ kind: 'run', command: 'close-position', line: { ...close, cancellable: false }, price: close.price }, notCancellable);
    calledOnly(notCancellable, 'notice');
  });

  it('Shift+F jen požádá lištu o dialog; nepřevzatý požadavek = hláška, nic dalšího', () => {
    const taken = handlers();
    dispatchLiveHotkeyOutcome({ kind: 'open-flatten' }, taken);
    calledOnly(taken, 'openFlatten');
    const lost = handlers({ openFlatten: vi.fn(() => false) });
    dispatchLiveHotkeyOutcome({ kind: 'open-flatten' }, lost);
    expect(lost.notice).toHaveBeenCalledWith({ tone: 'bad', text: LIVE_HOTKEY_FLATTEN_UNAVAILABLE });
    for (const name of ['prefill', 'discard', 'breakEven', 'cancelLine', 'toggleHelp'] as const) expect(lost[name]).not.toHaveBeenCalled();
  });

  it('blokace je jen hláška', () => {
    const blocked = handlers();
    dispatchLiveHotkeyOutcome({ kind: 'blocked', command: 'break-even', text: 'BE teď nejde.' }, blocked);
    calledOnly(blocked, 'notice');
    const none = handlers();
    dispatchLiveHotkeyOutcome({ kind: 'none' }, none);
    for (const fn of Object.values(none)) expect(fn).not.toHaveBeenCalled();
  });

  it('celá cesta Shift+X: první stisk × čáry, dvojstisk nic, držená klávesa nic', () => {
    const lines: BacktestChartOrderLine[] = positionLines(true);
    const guard: { current: { key: string; at: number } | null } = { current: null };
    const gate = { dialogOpen: false, leaving: false, hidden: false };
    const state = { lines, breakEven: null, hasDraft: false, busy: false };
    const press = (at: number, repeat = false) => {
      const intent = liveHotkeyAction(key({ key: 'X', code: 'KeyX', shiftKey: true, repeat }), gate);
      if (!intent) return null;
      const spy = handlers();
      dispatchLiveHotkeyOutcome(resolveLiveHotkey(intent, state, guard, at), spy);
      return spy;
    };
    const first = press(1_000)!;
    calledOnly(first, 'cancelLine');
    expect(first.cancelLine).toHaveBeenCalledWith(lines[0]);
    expect(press(1_100, true)).toBeNull();
    for (const fn of Object.values(press(1_200)!)) expect(fn).not.toHaveBeenCalled();
    // Bez × na čáře (kopírka ne čerstvě zapnutá) se nic nespustí.
    const intent = liveHotkeyAction(key({ key: 'X', shiftKey: true }), gate)!;
    const blocked = handlers();
    dispatchLiveHotkeyOutcome(resolveLiveHotkey(intent, { ...state, lines: positionLines(false) }, { current: null }, 1_000), blocked);
    calledOnly(blocked, 'notice');
  });
});

describe('U1: obrazovka — zkratka nikdy neodešle vstup ani nic mimo funkce čar', () => {
  const screen = source('components/LiveTradingScreen.tsx');
  const hotkeys = between(screen, 'const prefillFromHotkey = ', '  useEffect(() => {\n    if (!hotkeysOn) return undefined;');

  it('obsluha kláves nevolá odeslání, náhled, attach ani správu napřímo', () => {
    expect(hotkeys).not.toMatch(/onPlaceEntry|onPreviewEntry|sendDirect|placeLeaderEntry|onAttachBrackets|onManageEntry|runLiveManage|manageRunner|executeAgent|runStaticSafetyAction/);
    // BE / zavřít / zrušit jen přes most čar (stejná cesta jako myš).
    expect(hotkeys).toMatch(/breakEven: line => liveOrderEntry\.onOrderLineAction\?\.\(line, 'break-even'\),/);
    expect(hotkeys).toMatch(/cancelLine: line => liveOrderEntry\.onOrderLineCancel\(line\),/);
    // Shift+F jen požádá lištu o dialog.
    expect(hotkeys.match(/requestLiveSafetyConfirmation\(/g)).toHaveLength(1);
    expect(hotkeys).toMatch(/openFlatten: \(\) => requestLiveSafetyConfirmation\('flatten-group', 'hotkey'\),/);
    // Shift+B/S: jen stav panelu.
    const prefill = between(screen, 'const prefillFromHotkey = ', 'hotkeyHandlerRef.current = ');
    expect(prefill).toMatch(/setDraft\(result\.draft\);\s*setFromBox\(false\);\s*setTicketOpen\(true\);/);
  });

  it('Esc zahodí návrh jen z mostu grafu (nečinné kreslení), stav kláves čte v okamžiku stisku', () => {
    expect(hotkeys).toMatch(/if \(!intent \|\| \(intent\.kind === 'discard-draft' && !fromChartEscape\)\) return;/);
    expect(hotkeys).toMatch(/\.\.\.\(fromChartEscape \? \{ drawingIdle: true \} : \{\}\),/);
    expect(hotkeys).toMatch(/dialogOpen: disarmConfirm \|\| liveHotkeyOverlayOpen\(/);
    expect(hotkeys).toMatch(/busy: liveBusyRef\.current/);
    expect(screen).toMatch(/onEscape: event => hotkeyHandlerRef\.current\(event, true\),/);
    const workspace = source('components/AlphaTradeChartWorkspace.tsx');
    const escape = between(workspace, 'const handleEscape = ', "window.addEventListener('keydown', handleEscape, true);");
    expect(escape).toMatch(/if \(!onEscape \|\| !liveDrawingIdle\(drawingEnginesRef\.current\)\) return;/);
    const idle = between(workspace, 'export function liveDrawingIdle', '\n}\n');
    expect(idle).toMatch(/engines\.every\(/);
    expect(idle).toMatch(/catch \{\s*return false;/);
  });

  it('BE, zavření i zrušení z čar a kláves sdílí jeden runner (jeden zámek s panelem)', () => {
    expect(screen.match(/useLiveManageRunner\(\{/g)).toHaveLength(1);
    expect(screen).toMatch(/const liveBusyRef = manageState\.busyRef;/);
    expect(screen).toMatch(/manageRunner=\{onManageEntry \? manageRunner : null\}/);
    expect(screen).toMatch(/manageGuardAt=\{guardSummaryAt\}/);
  });
});

describe('U1: Shift+F na nouzové liště jen otevře dialog', () => {
  const target = { id: 'g', name: 'Test', accountIds: [1, 2], observedAt: 1_000, verified: true };
  const view = (patch: Partial<LiveSafetyShortcutView> = {}): LiveSafetyShortcutView => ({
    target, confirmationOpen: false, pending: [], flattenPending: false, ...patch,
  });
  const setup = (current: LiveSafetyShortcutView) => {
    const bus = createLiveSafetyShortcutBus();
    const open = vi.fn();
    const ignored = vi.fn();
    const onAction = vi.fn();
    bus.subscribe(liveSafetyShortcutListener({ view: () => current, open, ignored, now: () => 2_000 }));
    return { bus, open, ignored, onAction };
  };

  it('požadavek otevře dialog Flatten se stejným cílem; akce se nevolá', () => {
    const { bus, open, ignored, onAction } = setup(view());
    expect(bus.request('flatten-group', 'hotkey', 2_000)).toBe(true);
    expect(open).toHaveBeenCalledWith({ action: 'flatten-group', target, source: 'hotkey' });
    expect(ignored).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  });

  it('otevřený dialog, běžící Flatten nebo neznámá skupina = jen důvod', () => {
    for (const current of [view({ confirmationOpen: true }), view({ flattenPending: true }), view({ target: null }), view({ pending: ['flatten-group'] })]) {
      const { bus, open, ignored } = setup(current);
      bus.request('flatten-group', 'hotkey', 2_000);
      expect(open).not.toHaveBeenCalled();
      expect(ignored).toHaveBeenCalledTimes(1);
    }
  });

  it('lišta: odběr jen nastaví potvrzení; příkaz dál jen z onResolve dialogu', () => {
    const controls = source('components/LiveSafetyControls.tsx');
    const subscription = between(controls, 'useEffect(() => subscribeLiveSafetyShortcut(', '})), []);');
    expect(subscription).not.toMatch(/onAction|run\(|flattenCoordinator\.run/);
    expect(subscription).toMatch(/setConfirmation\(next\);/);
    expect(controls).toMatch(/if \(confirmed\) void run\(request\.action, request\.target \?\? undefined\);/);
  });
});

describe('U3-PC: pojistka přehrávání v PC grafu', () => {
  const workspace = source('components/AlphaTradeChartWorkspace.tsx');
  const screen = source('components/LiveTradingScreen.tsx');

  it('živé čáry během přehrávání jen pro čtení, návrh a „· přidat“ zmizí', () => {
    const replay = between(workspace, 'export function liveOrderLinesDuringReplay', '\n}\n');
    expect(replay).toMatch(/if \(!livePositionOwnerId\) return \[\];/);
    expect(replay).toMatch(/lines\.filter\(line => line\.ownerId === livePositionOwnerId\)/);
    for (const field of ['draggable: false', 'cancellable: false', 'cancelAction: undefined', 'actions: undefined', 'addableBrackets: undefined', 'labelAt: undefined']) {
      expect(replay, field).toContain(field);
    }
    const panel = between(workspace, 'const liveReplayLocked = ', 'const liveDisplayOrders = ');
    expect(panel).toMatch(/Boolean\(liveOrderEntry\) && context\.replay\.phase !== 'off'/);
    // Pojistka platí dřív než přepínač „čáry příkazů“.
    expect(panel.indexOf('liveOrderLinesDuringReplay(all, liveOwner)')).toBeLessThan(panel.indexOf('if (context.tradingSettings.orderLines) return all;'));
    expect(panel).toMatch(/const liveOnChartOrder = liveReplayLocked \? undefined : liveOrderEntry\?\.onChartOrder;/);
    expect(workspace).toMatch(/\? replay\.phase !== 'off'\s*\/\/[^\n]*\n\s*\? 'Přehrávání v grafu — obchoduj v živém grafu\.'/);
  });

  it('obrazovka přehrávání ví: panel zavřený a vypnutý, akce čar jen hláška', () => {
    expect(workspace).toMatch(/const liveReplayActive = liveTradingChart && replay\.phase !== 'off';/);
    expect(screen).toMatch(/onReplayActiveChange: setChartReplay,/);
    expect(screen).toMatch(/useEffect\(\(\) => \{ if \(chartReplay\) setTicketOpen\(false\); \}, \[chartReplay\]\);/);
    expect(screen).toMatch(/disabled=\{chartReplay\}/);
    expect(screen).toMatch(/inert=\{!ticketOpen \|\| chartReplay\}/);
    expect(screen).toMatch(/if \(line\.ownerId === LIVE_POSITION_OWNER\) \{\n\s*if \(chartReplay\) \{ replayNotice\(\); return; \}/);
    expect(screen).toMatch(/if \(line\.ownerId === LIVE_POSITION_OWNER && chartReplay\) \{ replayNotice\(\); return; \}/);
    expect(screen).toMatch(/if \(chartReplay\) return \{ ok: false, message: LIVE_HOTKEY_REPLAY_TEXT \};/);
    expect(screen).toMatch(/if \(!quote \|\| chartReplay\) return;/);
  });
});

describe('U5: pracující příkazy jen pro zobrazení', () => {
  const workspace = source('components/AlphaTradeChartWorkspace.tsx');
  const screen = source('components/LiveTradingScreen.tsx');

  it('vrstva nemá žádné ovládání a do overlaye s handlery se čáry nedostanou', () => {
    const layer = between(workspace, 'const LiveDisplayOrderLinesLayer', '\ninterface AlphaTradeChartWorkspaceProps');
    expect(layer).not.toMatch(/onChange|onCancel|onAction|onAddBracket|onClick|onPointerDown|onMouseDown|draggable|cancellable/);
    expect(layer).toMatch(/border-dotted/);
    expect(layer).toMatch(/title=\{line\.title\}/);
    // Sklo s vlastní výplní (Chrome bez backdrop blur) a pod overlayem pozice (z 114 < 115).
    expect(layer).toMatch(/backgroundColor: glass/);
    expect(layer).toMatch(/z-\[114\]/);
    const panel = between(workspace, 'const panelOrderLines = useMemo', 'const liveOnChartOrder');
    expect(panel).not.toMatch(/liveDisplayOrders|workingOrders/);
    expect(workspace).toMatch(/lines=\{panelOrderLines\}/);
    const orderLinesMemo = between(screen, 'const orderLines = useMemo(', ');');
    expect(orderLinesMemo).not.toMatch(/workingOrders|shownWorking|live-working/);
  });

  it('handlery čar mají pojistku pro čáry jen pro zobrazení a návrh mění jen čára návrhu', () => {
    for (const handler of ['onOrderLineChange: (line, kind, price, startLine) => {', 'onOrderLineCancel: line => {', 'onOrderLineAction: (line, actionId) => {']) {
      const body = screen.slice(screen.indexOf(handler), screen.indexOf(handler) + 260);
      expect(body, handler).toMatch(/if \(isLiveDisplayOnlyLine\(line\)\) return;/);
    }
    expect(screen.match(/if \(line\.ownerId !== LIVE_DRAFT_ID\) return;/g)).toHaveLength(2);
    expect(screen).toMatch(/if \(!quote \|\| line\.ownerId !== LIVE_DRAFT_ID\) return;/);
  });

  it('čáry ani šipky se nekreslí nad jiným kontraktem grafu', () => {
    expect(screen).toMatch(/const chartContract = previewSymbolFromChartSource\(quoteInfo\.source\) \?\? position\?\.symbol \?\? entryFrontContract \?\? null;/);
    expect(screen).toMatch(/workingOrders\.contract != null && workingOrders\.contract === chartContract/);
    expect(screen).toMatch(/liveFills\.symbol != null && liveFills\.symbol === chartContract/);
    expect(screen).toMatch(/liveDisplayOrders: shownWorking,/);
    expect(screen).toMatch(/liveFills: shownFills,/);
  });
});

describe('U4: šipky plnění a „· přidat“ na PC', () => {
  const workspace = source('components/AlphaTradeChartWorkspace.tsx');
  const screen = source('components/LiveTradingScreen.tsx');

  it('šipky jen v panelu exekuce, mimo přehrávání, stejnou primitivou jako telefon', () => {
    const arrows = between(workspace, 'const liveFills = liveOrderEntry?.liveFills ?? null;', '\n  });');
    expect(arrows).toMatch(/useLiveFillArrows\(\{/);
    expect(arrows).toMatch(/context\.replay\.phase === 'off'/);
    expect(arrows).toMatch(/liveFills\.open !== undefined/);
  });

  it('šipky ani pracující příkazy nevedou do příkazů obrazovky', () => {
    const bodies = {
      newDraft: between(screen, 'const newDraft = useCallback(', '}, [customTemplate'),
      prefillFromHotkey: between(screen, 'const prefillFromHotkey = ', 'hotkeyHandlerRef.current = '),
      onChartOrder: between(screen, 'onChartOrder: input => {', 'livePositionOwnerId: LIVE_POSITION_OWNER,'),
    };
    for (const [name, body] of Object.entries(bodies)) {
      expect(body, name).not.toMatch(/liveFills|shownFills|workingOrders|shownWorking/);
    }
  });

  it('tah čáry „· přidat“ jen mění nohy v panelu (nic neodesílá)', () => {
    const attach = between(screen, 'if (line.ownerId === LIVE_ATTACH_OWNER) {', 'if (line.ownerId !== LIVE_DRAFT_ID) return;');
    expect(attach).toMatch(/setAttachLegs\(/);
    expect(attach).not.toMatch(/onAttachBrackets|runLiveManage|onManageEntry|onPlaceEntry/);
    expect(screen).toMatch(/attachLegs=\{attachLegs\}\s*onAttachLegs=\{setAttachLegs\}/);
  });
});

describe('U7: zvuk/hlas při fillu', () => {
  const screen = source('components/LiveTradingScreen.tsx');
  it('stejná brána jako karty obchodů, jen okno s fokusem; přepínač vypnuto → tón → hlas', () => {
    const announcer = between(screen, 'useLiveFillAnnouncer({', '});');
    expect(announcer).toMatch(/events: copier\.available \? copyEvents \?\? copier\.status\?\.recentCopyEvents : undefined,/);
    expect(announcer).toMatch(/available: copier\.available,/);
    expect(announcer).toMatch(/enabled: !leaving,/);
    expect(announcer).toMatch(/requireFocus: true,/);
    const toggle = between(screen, 'const LiveFillAnnounceToggle', '\n};');
    expect(toggle).toMatch(/useLiveFillAnnounceMode\(\)/);
    expect(toggle).not.toMatch(/onPlaceEntry|onManageEntry|relay|executeAgent/);
  });
});
