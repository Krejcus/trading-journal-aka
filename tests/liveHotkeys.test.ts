import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LIVE_DOUBLE_CLICK_MS, type LiveClickState } from '../lib/liveClickGate';
import { LIVE_PENDING_ADD_LINE_ID, LIVE_POSITION_OWNER, liveBreakEven, livePositionChartLines } from '../lib/liveChartOrderLines';
import type { LiveChartPositionSummary } from '../lib/liveChartPosition';
import { liveDraftChartLines, newTicketDraft, type TicketInstrument } from '../lib/liveOrderTicket';
import {
  LIVE_HOTKEY_COMMANDS,
  LIVE_HOTKEY_HELP,
  chartDrawingIdle,
  liveHotkeyAction,
  liveHotkeyConfirmKey,
  liveHotkeyDraft,
  liveHotkeyIntent,
  liveHotkeyMarketAllowed,
  liveHotkeyTargetBlocked,
  resolveLiveHotkey,
  type LiveHotkeyEvent,
  type LiveHotkeyGate,
  type LiveHotkeyIntent,
  type LiveHotkeyState,
} from '../lib/liveHotkeys';

const lastPress = (): { current: LiveClickState | null } => ({ current: null });
const INSTRUMENT: TicketInstrument = { symbol: 'MNQ', tickSize: 0.25, pointValue: 2 };
const T0 = 1_762_000_000_000;

const gate = (patch: Partial<LiveHotkeyGate> = {}): LiveHotkeyGate => ({ dialogOpen: false, leaving: false, hidden: false, ...patch });
const press = (patch: Partial<LiveHotkeyEvent> = {}): LiveHotkeyEvent => ({
  key: 'X', code: 'KeyX', shiftKey: true, ctrlKey: false, metaKey: false, altKey: false,
  repeat: false, isComposing: false, defaultPrevented: false, target: null, ...patch,
});
const letter = (char: string, patch: Partial<LiveHotkeyEvent> = {}) => press({ key: char.toUpperCase(), code: `Key${char.toUpperCase()}`, ...patch });
/** Cíl, jehož `closest` trefí selektor obsahující `needle`. */
const inside = (needle: string) => ({ tagName: 'DIV', closest: (selector: string) => (selector.includes(needle) ? {} : null) });

const summary = (patch: Partial<LiveChartPositionSummary> = {}): LiveChartPositionSummary => ({
  kind: 'position', side: 'long', quantity: 2, entry: 21000, entryType: null, openPnl: 20, mark: 21010,
  stop: 20988, target: 21024, protection: 'SL 2/2 · TP 2/2', accounts: 2, scopeLabel: null,
  leader: { accountId: 1, quantity: 1, entry: 21000 }, rows: [], ...patch,
});
const controls = { manageable: true, canClose: true, entryAvg: 21000, pointValue: 2 };
const positionState = (patch: Partial<LiveChartPositionSummary> = {}, extra: Partial<typeof controls> & { pendingAdd?: { price: number | null; quantity: number; orderType: string } | null } = {}): LiveHotkeyState => {
  const current = summary(patch);
  const merged = { ...controls, ...extra };
  return {
    lines: livePositionChartLines(current, merged),
    breakEven: liveBreakEven(current, merged.entryAvg),
    hasDraft: false,
    busy: false,
  };
};
const pendingState = (patch: Partial<LiveChartPositionSummary> = {}): LiveHotkeyState => positionState({ kind: 'pending', entryType: 'Limit', openPnl: null, mark: null, entry: 20990, ...patch });
const intent = (kind: Exclude<LiveHotkeyIntent['kind'], 'new-draft'>): LiveHotkeyIntent => ({ kind } as LiveHotkeyIntent);

describe('U1 klávesy: mapa kláves', () => {
  it('Shift+B/S/E/X/C/F, Esc a ? — nic jiného', () => {
    expect(liveHotkeyIntent(letter('b'))).toEqual({ kind: 'new-draft', side: 'buy' });
    expect(liveHotkeyIntent(letter('s'))).toEqual({ kind: 'new-draft', side: 'sell' });
    expect(liveHotkeyIntent(letter('e'))).toEqual({ kind: 'break-even' });
    expect(liveHotkeyIntent(letter('x'))).toEqual({ kind: 'close-position' });
    expect(liveHotkeyIntent(letter('c'))).toEqual({ kind: 'cancel-pending' });
    expect(liveHotkeyIntent(letter('f'))).toEqual({ kind: 'flatten-dialog' });
    expect(liveHotkeyIntent(press({ key: '?', code: 'Comma', shiftKey: true }))).toEqual({ kind: 'help' });
    expect(liveHotkeyIntent(press({ key: 'Escape', code: 'Escape', shiftKey: false }))).toEqual({ kind: 'discard-draft' });
    for (const other of ['a', 'd', 'k', 'q', 'z']) expect(liveHotkeyIntent(letter(other))).toBeNull();
    expect(liveHotkeyIntent(press({ key: 'Enter', code: 'Enter' }))).toBeNull();
    expect(liveHotkeyIntent(press({ key: 'Enter', code: 'Enter', shiftKey: false }))).toBeNull();
  });

  it('písmena jen se Shiftem; Caps Lock bez Shiftu nic neudělá', () => {
    expect(liveHotkeyIntent(letter('b', { shiftKey: false }))).toBeNull();
    expect(liveHotkeyIntent(press({ key: 'B', code: 'KeyB', shiftKey: false }))).toBeNull();
    expect(liveHotkeyIntent(press({ key: 'x', code: 'KeyX', shiftKey: false }))).toBeNull();
  });

  it('rozhoduje viditelný znak; fyzická klávesa jen u nelatinkového rozložení', () => {
    // Dvorak: fyzická KeyB píše X → zavřít, ne nový nákup.
    expect(liveHotkeyIntent(press({ key: 'X', code: 'KeyB' }))).toEqual({ kind: 'close-position' });
    // Azbuka: Shift+„И“ na fyzické B → nový nákup.
    expect(liveHotkeyIntent(press({ key: 'И', code: 'KeyB' }))).toEqual({ kind: 'new-draft', side: 'buy' });
  });

  it('vrací vždy nový objekt (mapu nejde zvenku přepsat)', () => {
    const first = liveHotkeyIntent(letter('b')) as { kind: 'new-draft'; side: string };
    first.side = 'sell';
    expect(liveHotkeyIntent(letter('b'))).toEqual({ kind: 'new-draft', side: 'buy' });
  });

  it('nápověda pokrývá všechny klávesy a Shift+B/S nikdy neslibují odeslání', () => {
    expect(LIVE_HOTKEY_HELP.map(item => item.keys)).toEqual(['Shift+B', 'Shift+S', 'Esc', 'Shift+E', 'Shift+X', 'Shift+C', 'Shift+F', '?']);
    expect(LIVE_HOTKEY_HELP.slice(0, 2).every(item => /nic neodešle/.test(item.text))).toBe(true);
  });
});

describe('U1 klávesy: kdy zkratka mlčí (null)', () => {
  it('běžný stisk projde', () => {
    expect(liveHotkeyAction(letter('x'), gate())).toEqual({ kind: 'close-position' });
  });

  it('držená klávesa (repeat) se ignoruje u všech zkratek včetně Flatten', () => {
    for (const char of ['b', 's', 'e', 'x', 'c', 'f']) expect(liveHotkeyAction(letter(char, { repeat: true }), gate())).toBeNull();
    expect(liveHotkeyAction(press({ key: '?', repeat: true }), gate())).toBeNull();
  });

  it('skládání znaku (IME), Meta/Ctrl/Alt a už zpracovaná událost', () => {
    expect(liveHotkeyAction(letter('x', { isComposing: true }), gate())).toBeNull();
    expect(liveHotkeyAction(letter('x', { keyCode: 229 }), gate())).toBeNull();
    expect(liveHotkeyAction(press({ key: 'Process' }), gate())).toBeNull();
    expect(liveHotkeyAction(letter('x', { metaKey: true }), gate())).toBeNull();
    expect(liveHotkeyAction(letter('x', { ctrlKey: true }), gate())).toBeNull();
    expect(liveHotkeyAction(letter('x', { altKey: true }), gate())).toBeNull();
    // AltGr na Windows = Ctrl+Alt.
    expect(liveHotkeyAction(letter('x', { ctrlKey: true, altKey: true }), gate())).toBeNull();
    expect(liveHotkeyAction(letter('x', { defaultPrevented: true }), gate())).toBeNull();
  });

  it('fokus v poli panelu, editoru, textboxu nebo dialogu', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'input']) {
      expect(liveHotkeyAction(letter('x', { target: { tagName } }), gate())).toBeNull();
    }
    expect(liveHotkeyAction(letter('x', { target: { tagName: 'DIV', isContentEditable: true } }), gate())).toBeNull();
    expect(liveHotkeyAction(letter('x', { target: { tagName: 'DIV', getAttribute: (name: string) => (name === 'role' ? 'textbox' : null) } }), gate())).toBeNull();
    expect(liveHotkeyAction(letter('x', { target: inside('textarea') }), gate())).toBeNull();
    expect(liveHotkeyAction(letter('x', { target: inside('contenteditable') }), gate())).toBeNull();
    expect(liveHotkeyAction(letter('x', { target: inside('role="dialog"') }), gate())).toBeNull();
    expect(liveHotkeyAction(letter('x', { target: inside('aria-modal') }), gate())).toBeNull();
    // Výjimka v selektoru = raději nic.
    expect(liveHotkeyTargetBlocked({ tagName: 'DIV', closest: () => { throw new Error('bad selector'); } })).toBe(true);
    // Obyčejný prvek grafu (canvas, tlačítko) zkratku pustí.
    expect(liveHotkeyAction(letter('x', { target: { tagName: 'CANVAS', closest: () => null } }), gate())).toEqual({ kind: 'close-position' });
  });

  it('otevřený dialog, odchod z grafu, skrytá stránka; neznámý stav = blokováno', () => {
    expect(liveHotkeyAction(letter('f'), gate({ dialogOpen: true }))).toBeNull();
    expect(liveHotkeyAction(letter('x'), gate({ leaving: true }))).toBeNull();
    expect(liveHotkeyAction(letter('x'), gate({ hidden: true }))).toBeNull();
    expect(liveHotkeyAction(letter('x'), { leaving: false, hidden: false } as unknown as LiveHotkeyGate)).toBeNull();
  });

  it('Esc jen při potvrzeně nečinném kreslení (první Esc patří kresbě)', () => {
    const esc = press({ key: 'Escape', code: 'Escape', shiftKey: false });
    expect(liveHotkeyAction(esc, gate())).toBeNull();
    expect(liveHotkeyAction(esc, gate({ drawingIdle: false }))).toBeNull();
    expect(liveHotkeyAction(esc, gate({ drawingIdle: true }))).toEqual({ kind: 'discard-draft' });
    expect(chartDrawingIdle({ activeTool: null, draft: null, selectedId: null })).toBe(true);
    expect(chartDrawingIdle({ activeTool: 'trend-line', draft: null, selectedId: null })).toBe(false);
    expect(chartDrawingIdle({ activeTool: null, draft: { id: 'd' }, selectedId: null })).toBe(false);
    expect(chartDrawingIdle({ activeTool: null, draft: null, selectedId: 'drawing-1' })).toBe(false);
  });
});

describe('U1 klávesy: Shift+E / Shift+X / Shift+C → první stisk, jen to, co nabízí čára', () => {
  it('Shift+X: první stisk rovnou vrátí TOUŽ čáru jako × myší', () => {
    const state = positionState();
    const run = resolveLiveHotkey(intent('close-position'), state, lastPress(), T0);
    if (run.kind !== 'run') throw new Error('expected run');
    expect(run.line).toBe(state.lines.find(line => line.id === `${LIVE_POSITION_OWNER}:entry`));
    expect(run.line).toMatchObject({ cancelAction: 'close-position', cancellable: true });
  });

  it('rychlý dvojstisk téhož = jeden příkaz; po pauze další; bušení kotvu posouvá', () => {
    const state = positionState();
    const guard = lastPress();
    expect(resolveLiveHotkey(intent('close-position'), state, guard, T0).kind).toBe('run');
    expect(resolveLiveHotkey(intent('close-position'), state, guard, T0 + LIVE_DOUBLE_CLICK_MS - 1).kind).toBe('none');
    expect(resolveLiveHotkey(intent('close-position'), state, guard, T0 + LIVE_DOUBLE_CLICK_MS + 100).kind).toBe('none');
    expect(resolveLiveHotkey(intent('close-position'), state, guard, T0 + 2 * LIVE_DOUBLE_CLICK_MS + 100).kind).toBe('run');
  });

  it('běžící příkaz: nic neodejde, text nabízí Flatten', () => {
    const state = { ...positionState(), busy: true };
    expect(resolveLiveHotkey(intent('close-position'), state, lastPress(), T0)).toMatchObject({ kind: 'blocked', text: expect.stringMatching(/Flattenem/) });
  });

  it('Shift+X jen když × na čáře zavírá (canClose); jinak hláška a nic', () => {
    const guard = lastPress();
    const noClose = positionState({}, { canClose: false });
    expect(resolveLiveHotkey(intent('close-position'), noClose, guard, T0)).toMatchObject({ kind: 'blocked', command: 'close-position' });
    const readOnly = positionState({}, { manageable: false });
    expect(resolveLiveHotkey(intent('close-position'), readOnly, guard, T0).kind).toBe('blocked');
    expect(resolveLiveHotkey(intent('break-even'), readOnly, guard, T0).kind).toBe('blocked');
    // Čáry návrhu (× = zahodit návrh) klávesa nikdy nebere.
    const draft = newTicketDraft('buy', 'limit', 20990, INSTRUMENT, { bid: 21000, ask: 21000.25 });
    const draftOnly: LiveHotkeyState = { lines: liveDraftChartLines(draft, INSTRUMENT, { bid: 21000, ask: 21000.25 }), breakEven: null, hasDraft: true, busy: false };
    for (const command of LIVE_HOTKEY_COMMANDS) {
      expect(resolveLiveHotkey(intent(command), draftOnly, guard, T0).kind).toBe('blocked');
    }
  });

  it('Shift+C: čekající vstup = jeho čára; vyplněný = nic nezruší ani nezavře', () => {
    const run = resolveLiveHotkey(intent('cancel-pending'), pendingState(), lastPress(), T0);
    expect(run).toMatchObject({ kind: 'run', command: 'cancel-pending' });
    if (run.kind === 'run') expect(run.line).toMatchObject({ cancelAction: 'cancel-order', kind: 'entry' });
    const filled = positionState({ entry: 20990 });
    expect(resolveLiveHotkey(intent('cancel-pending'), filled, lastPress(), T0)).toMatchObject({ kind: 'blocked', command: 'cancel-pending' });
  });

  it('Shift+C na čekajícím přikoupení míří na jeho čáru, ne na pozici', () => {
    const state = positionState({}, { pendingAdd: { price: 20995, quantity: 1, orderType: 'Limit' } });
    const run = resolveLiveHotkey(intent('cancel-pending'), state, lastPress(), T0);
    expect(run.kind === 'run' && run.line.id).toBe(LIVE_PENDING_ADD_LINE_ID);
  });

  it('víc kandidátních čar = nic (fail-closed)', () => {
    const state = pendingState();
    const twice = { ...state, lines: [...state.lines, { ...state.lines[0], id: 'live-position:jina' }] };
    expect(resolveLiveHotkey(intent('cancel-pending'), twice, lastPress(), T0)).toMatchObject({ kind: 'blocked' });
  });

  it('Shift+E: BE s cenou; změněná cena v okně dvojstisku je jiný příkaz', () => {
    const guard = lastPress();
    expect(resolveLiveHotkey(intent('break-even'), positionState(), guard, T0)).toMatchObject({ kind: 'run', command: 'break-even', price: 21000 });
    const moved = positionState({ entry: 21002 }, { entryAvg: 21002 });
    expect(resolveLiveHotkey(intent('break-even'), moved, guard, T0 + 100)).toMatchObject({ kind: 'run', command: 'break-even', price: 21002 });
  });

  it('Shift+E blokované stejně jako tlačítko BE (rozjeté SL, SL už na BE, neznámý průměr)', () => {
    const guard = lastPress();
    const split = positionState({ stop: null });
    expect(resolveLiveHotkey(intent('break-even'), split, guard, T0)).toMatchObject({ kind: 'blocked' });
    const atBe = positionState({ stop: 21000 });
    expect(resolveLiveHotkey(intent('break-even'), atBe, guard, T0)).toMatchObject({ kind: 'blocked', text: 'SL už je na BE.' });
    const fresh = positionState();
    expect(resolveLiveHotkey(intent('break-even'), { ...fresh, breakEven: null }, guard, T0).kind).toBe('blocked');
    expect(resolveLiveHotkey(intent('break-even'), { ...fresh, breakEven: { price: null, blocked: null } }, guard, T0).kind).toBe('blocked');
  });

  it('držená klávesa nic dalšího nepošle: auto-repeat se k resolve vůbec nedostane', () => {
    const guard = lastPress();
    const state = positionState();
    const outcomes: string[] = [];
    const dispatch = (event: LiveHotkeyEvent, at: number) => {
      const action = liveHotkeyAction(event, gate());
      if (action) outcomes.push(resolveLiveHotkey(action, state, guard, at).kind);
    };
    dispatch(letter('x'), T0);
    for (let at = T0 + 500; at < T0 + 4_000; at += 33) dispatch(letter('x', { repeat: true }), at);
    expect(outcomes).toEqual(['run']);
  });
});

describe('U1 klávesy: návrh, Esc, Flatten, nápověda', () => {
  it('Shift+B/S → jen návrh do panelu; vstup nikdy není příkaz `run`', () => {
    const guard = lastPress();
    const state = positionState();
    for (const side of ['buy', 'sell'] as const) {
      // Ani opakovaně.
      for (const at of [T0, T0 + 400, T0 + 800]) expect(resolveLiveHotkey({ kind: 'new-draft', side }, state, guard, at)).toEqual({ kind: 'prefill-draft', side });
    }
    expect(LIVE_HOTKEY_COMMANDS).toEqual(['break-even', 'close-position', 'cancel-pending']);
  });

  it('Esc zahodí jen existující návrh', () => {
    const guard = lastPress();
    expect(resolveLiveHotkey(intent('discard-draft'), { ...positionState(), hasDraft: true }, guard, T0)).toEqual({ kind: 'discard-draft' });
    expect(resolveLiveHotkey(intent('discard-draft'), positionState(), guard, T0)).toEqual({ kind: 'none' });
  });

  it('Shift+F jen otevře dialog — i když běží jiná akce (nouzová cesta se neblokuje)', () => {
    const guard = lastPress();
    expect(resolveLiveHotkey(intent('flatten-dialog'), { ...positionState(), busy: true }, guard, T0)).toEqual({ kind: 'open-flatten' });
    expect(resolveLiveHotkey(intent('flatten-dialog'), { lines: [], breakEven: null, hasDraft: false, busy: false }, guard, T0)).toEqual({ kind: 'open-flatten' });
    // Dvojí Shift+F nikdy nevrátí `run`.
    expect(resolveLiveHotkey(intent('flatten-dialog'), positionState(), guard, T0 + 500)).toEqual({ kind: 'open-flatten' });
  });

  it('? přepne nápovědu', () => {
    expect(resolveLiveHotkey(intent('help'), positionState(), lastPress(), T0)).toEqual({ kind: 'toggle-help' });
  });

  it('liveHotkeyConfirmKey: akce, čára, × akce, tvar i cena', () => {
    const [entry] = positionState().lines;
    expect(liveHotkeyConfirmKey('close-position', entry, 21000)).toBe('close-position:live-position:entry:close-position:LONG 2:21000');
    expect(liveHotkeyConfirmKey('break-even', entry, 21000)).not.toBe(liveHotkeyConfirmKey('close-position', entry, 21000));
  });
});

describe('U1 klávesy: návrh Shift+B/S (Market jen s čerstvou cenou a schopností workeru)', () => {
  const quote = { bid: 21000, ask: 21000.25 };
  const input = (patch: Partial<Parameters<typeof liveHotkeyDraft>[1]> = {}): Parameters<typeof liveHotkeyDraft>[1] => ({
    quote, quoteAt: T0 - 1_000, quoteStale: false, marketSupported: true, instrument: INSTRUMENT, now: T0, ...patch,
  });

  it('Market: worker ho umí a cena je stará ≤ 3 s; závorky 12 b / 2R', () => {
    const result = liveHotkeyDraft('buy', input());
    expect(result).toEqual({ draft: expect.objectContaining({ side: 'buy', type: 'market', price: 21000.25, quantity: 1, stopLoss: 20988.25, takeProfit: 21024.25 }) });
    expect(liveHotkeyMarketAllowed(input({ quoteAt: T0 - 3_000 }))).toBe(true);
  });

  it('jinak Limit ±10 b jako tlačítko strany panelu', () => {
    for (const patch of [{ marketSupported: false }, { quoteStale: true }, { quoteAt: T0 - 3_001 }, { quoteAt: null }, { quoteAt: T0 + 5_000 }]) {
      expect(liveHotkeyMarketAllowed(input(patch))).toBe(false);
      const buy = liveHotkeyDraft('buy', input(patch));
      expect(buy).toEqual({ draft: expect.objectContaining({ type: 'limit', price: 20990.25 }) });
    }
    expect(liveHotkeyDraft('sell', input({ marketSupported: false }))).toEqual({ draft: expect.objectContaining({ side: 'sell', type: 'limit', price: 21010, stopLoss: 21022, takeProfit: 20986 }) });
  });

  it('bez ceny žádný návrh', () => {
    expect(liveHotkeyDraft('buy', input({ quote: null }))).toEqual({ error: expect.stringMatching(/Čekám na cenu/) });
    expect(liveHotkeyDraft('buy', input({ quote: { bid: Number.NaN, ask: 1 } }))).toHaveProperty('error');
  });

  it('velikost z předchozího návrhu', () => {
    const result = liveHotkeyDraft('buy', input({ base: { sizing: 'risk', quantity: 3, riskUsd: 150 } }));
    expect(result).toEqual({ draft: expect.objectContaining({ sizing: 'risk', quantity: 3, riskUsd: 150 }) });
  });

  it('šablona SL/TP (U8) smí změnit jen závorky; výjimka = výchozí závorky', () => {
    const templated = liveHotkeyDraft('buy', input({
      applyBrackets: draft => ({ ...draft, side: 'sell', type: 'limit', price: 1, quantity: 99, stopLoss: 20990, takeProfit: null }),
    }));
    expect(templated).toEqual({ draft: expect.objectContaining({ side: 'buy', type: 'market', price: 21000.25, quantity: 1, stopLoss: 20990, takeProfit: null }) });
    const broken = liveHotkeyDraft('buy', input({ applyBrackets: () => { throw new Error('šablona'); } }));
    expect(broken).toEqual({ draft: expect.objectContaining({ stopLoss: 20988.25, takeProfit: 21024.25 }) });
    const nan = liveHotkeyDraft('buy', input({ applyBrackets: draft => ({ ...draft, stopLoss: Number.NaN }) }));
    expect(nan).toEqual({ draft: expect.objectContaining({ stopLoss: 20988.25 }) });
  });
});

describe('U1 klávesy: statická pojistka (žádná cesta k brokerovi)', () => {
  const source = readFileSync(new URL('../lib/liveHotkeys.ts', import.meta.url), 'utf8');

  it('importuje jen čisté moduly návrhu a čar', () => {
    const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]).sort();
    expect(imports).toEqual(['../services/backtestOrderLines', './liveChartOrderLines', './liveClickGate', './liveOrderTicket']);
    expect(source).toMatch(/import type \{ BacktestChartOrderLine \} from '\.\.\/services\/backtestOrderLines'/);
  });

  it('nevolá žádný callback příkazu ani síť', () => {
    expect(source).not.toMatch(/\b(placeLeaderEntry|previewLeaderEntry|manageLeaderEntry|attachBrackets|runStaticSafetyAction|onPlaceEntry|onManageEntry|sendDirect|runLiveManage|executeTradovateCopierRelayCommand|fetch)\s*\(/);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });
});
