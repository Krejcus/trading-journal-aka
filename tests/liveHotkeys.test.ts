import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { LIVE_PENDING_ADD_LINE_ID, LIVE_POSITION_OWNER, liveBreakEven, livePositionChartLines } from '../lib/liveChartOrderLines';
import type { LiveChartPositionSummary } from '../lib/liveChartPosition';
import { liveDraftChartLines, newTicketDraft, type TicketInstrument } from '../lib/liveOrderTicket';
import {
  LIVE_HOTKEY_COMMANDS,
  LIVE_HOTKEY_CONFIRM_MIN_MS,
  LIVE_HOTKEY_CONFIRM_WINDOW_MS,
  LIVE_HOTKEY_HELP,
  chartDrawingIdle,
  createTwoStepGuard,
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
    expect(LIVE_HOTKEY_HELP.map(item => item.keys)).toEqual(['Shift+B', 'Shift+S', 'Esc', 'Shift+E ×2', 'Shift+X ×2', 'Shift+C ×2', 'Shift+F', '?']);
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

describe('U1 klávesy: dvoukrokové potvrzení', () => {
  it('349 ms nepotvrdí, 350 ms potvrdí', () => {
    expect(LIVE_HOTKEY_CONFIRM_MIN_MS).toBe(350);
    expect(LIVE_HOTKEY_CONFIRM_WINDOW_MS).toBe(4_000);
    const guard = createTwoStepGuard();
    expect(guard.press('k', T0)).toEqual({ status: 'armed', until: T0 + 4_000 });
    expect(guard.press('k', T0 + 349)).toEqual({ status: 'too-soon', until: T0 + 4_000 });
    expect(guard.press('k', T0 + 350)).toEqual({ status: 'confirmed' });
    // Po potvrzení je stav pryč — třetí stisk jen znovu ptá.
    expect(guard.press('k', T0 + 500).status).toBe('armed');
  });

  it('3 999 ms ještě potvrdí, po 4 001 ms výzva vyprší a stisk jen znovu ptá', () => {
    const late = createTwoStepGuard();
    late.press('k', T0);
    expect(late.press('k', T0 + 3_999)).toEqual({ status: 'confirmed' });
    const expired = createTwoStepGuard();
    expired.press('k', T0);
    expect(expired.pending(T0 + 4_001)).toBeNull();
    expect(expired.press('k', T0 + 4_001)).toEqual({ status: 'armed', until: T0 + 8_001 });
  });

  it('změna klíče stav přepíše a nikdy nepotvrdí', () => {
    const guard = createTwoStepGuard();
    guard.press('cancel:A', T0);
    expect(guard.press('close:A', T0 + 1_000).status).toBe('armed');
    // Původní klíč už neplatí: vrátit se k němu = nová výzva.
    expect(guard.press('cancel:A', T0 + 2_000).status).toBe('armed');
    expect(guard.press('cancel:A', T0 + 2_400).status).toBe('confirmed');
  });

  it('reset a neplatný čas/klíč nikdy nepotvrdí', () => {
    const guard = createTwoStepGuard();
    guard.press('k', T0);
    guard.reset();
    expect(guard.press('k', T0 + 1_000).status).toBe('armed');
    expect(guard.press('k', Number.NaN)).toEqual({ status: 'invalid' });
    expect(guard.press('k', T0 + 1_500).status).toBe('armed');
    expect(guard.press('', T0 + 2_000)).toEqual({ status: 'invalid' });
    // Hodiny couvly: rozdíl < 350 ms → nepotvrdí.
    const back = createTwoStepGuard();
    back.press('k', T0);
    expect(back.press('k', T0 - 10).status).toBe('too-soon');
  });

  it('výchozí hodiny z options.now', () => {
    let now = T0;
    const guard = createTwoStepGuard({ now: () => now });
    guard.press('k');
    now += 400;
    expect(guard.pending()).toMatchObject({ key: 'k', armedAt: T0 });
    expect(guard.press('k')).toEqual({ status: 'confirmed' });
  });
});

describe('U1 klávesy: Shift+E / Shift+X / Shift+C → jen to, co nabízí čára', () => {
  it('Shift+X: první stisk výzva, druhý po ≥ 350 ms vrátí TOUŽ čáru jako × myší', () => {
    const guard = createTwoStepGuard();
    const state = positionState();
    const first = resolveLiveHotkey(intent('close-position'), state, guard, T0);
    expect(first).toMatchObject({ kind: 'prompt', command: 'close-position', until: T0 + 4_000 });
    expect(first.kind === 'prompt' && first.text).toBe('Zavřít LONG 2 @ 21000.00? Shift+X znovu');
    expect(resolveLiveHotkey(intent('close-position'), state, guard, T0 + 200).kind).toBe('prompt');
    const second = resolveLiveHotkey(intent('close-position'), state, guard, T0 + 600);
    expect(second.kind).toBe('run');
    if (second.kind !== 'run') throw new Error('expected run');
    const entryLine = state.lines.find(line => line.id === `${LIVE_POSITION_OWNER}:entry`);
    expect(second.line).toBe(entryLine);
    expect(second.line).toMatchObject({ cancelAction: 'close-position', cancellable: true });
  });

  it('Shift+X jen když × na čáře zavírá (canClose); jinak hláška a nic', () => {
    const guard = createTwoStepGuard();
    const noClose = positionState({}, { canClose: false });
    expect(resolveLiveHotkey(intent('close-position'), noClose, guard, T0)).toMatchObject({ kind: 'blocked', command: 'close-position' });
    expect(resolveLiveHotkey(intent('close-position'), noClose, guard, T0 + 600).kind).toBe('blocked');
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

  it('Shift+C: čekající vstup se mezi stisky vyplní → druhý stisk nic nezruší ani nezavře', () => {
    const guard = createTwoStepGuard();
    const pending = pendingState();
    const first = resolveLiveHotkey(intent('cancel-pending'), pending, guard, T0);
    expect(first).toMatchObject({ kind: 'prompt', command: 'cancel-pending' });
    expect(first.kind === 'prompt' && first.text).toBe('Zrušit čekající vstup BUY 2 LIMIT @ 20990.00? Shift+C znovu');
    // Vyplnilo se: × na téže čáře teď zavírá pozici.
    const filled = positionState({ entry: 20990 });
    expect(resolveLiveHotkey(intent('cancel-pending'), filled, guard, T0 + 600)).toMatchObject({ kind: 'blocked', command: 'cancel-pending' });
    // Ani Shift+X hned potom: potvrzení zrušení nesmí potvrdit zavření.
    expect(resolveLiveHotkey(intent('close-position'), filled, guard, T0 + 1_000).kind).toBe('prompt');
  });

  it('Shift+C ×2 na čekajícím vstupu vrátí jeho čáru (zrušení OSO jako × myší)', () => {
    const guard = createTwoStepGuard();
    const pending = pendingState();
    resolveLiveHotkey(intent('cancel-pending'), pending, guard, T0);
    const run = resolveLiveHotkey(intent('cancel-pending'), pending, guard, T0 + 400);
    expect(run).toMatchObject({ kind: 'run', command: 'cancel-pending', price: 20990 });
    expect(run.kind === 'run' && run.line).toMatchObject({ id: `${LIVE_POSITION_OWNER}:entry`, cancelAction: 'cancel-order', ownerType: 'order' });
  });

  it('klíč nese cenu: posun čekajícího příkazu mezi stisky = nová výzva', () => {
    const guard = createTwoStepGuard();
    resolveLiveHotkey(intent('cancel-pending'), pendingState({ entry: 20990 }), guard, T0);
    expect(resolveLiveHotkey(intent('cancel-pending'), pendingState({ entry: 20985 }), guard, T0 + 600).kind).toBe('prompt');
    expect(resolveLiveHotkey(intent('cancel-pending'), pendingState({ entry: 20985 }), guard, T0 + 1_000).kind).toBe('run');
  });

  it('klíč nese tvar: změna qty pozice mezi stisky Shift+X = nová výzva', () => {
    const guard = createTwoStepGuard();
    resolveLiveHotkey(intent('close-position'), positionState({ quantity: 2 }), guard, T0);
    expect(resolveLiveHotkey(intent('close-position'), positionState({ quantity: 3 }), guard, T0 + 600).kind).toBe('prompt');
  });

  it('Shift+C na čekajícím přikoupení míří na jeho čáru, ne na pozici', () => {
    const guard = createTwoStepGuard();
    const state = positionState({}, { pendingAdd: { price: 20995, quantity: 1, orderType: 'Limit' } });
    const first = resolveLiveHotkey(intent('cancel-pending'), state, guard, T0);
    expect(first.kind === 'prompt' && first.text).toBe('Zrušit čekající přikoupení @ 20995.00? Shift+C znovu');
    const run = resolveLiveHotkey(intent('cancel-pending'), state, guard, T0 + 400);
    expect(run.kind === 'run' && run.line.id).toBe(LIVE_PENDING_ADD_LINE_ID);
  });

  it('víc kandidátních čar = nic (fail-closed)', () => {
    const guard = createTwoStepGuard();
    const state = pendingState();
    const twice: LiveHotkeyState = { ...state, lines: [...state.lines, { ...state.lines[0], id: `${LIVE_POSITION_OWNER}:entry-2` }] };
    expect(resolveLiveHotkey(intent('cancel-pending'), twice, guard, T0)).toMatchObject({ kind: 'blocked' });
  });

  it('Shift+E: BE s cenou v klíči; změna průměru mezi stisky = nová výzva', () => {
    const guard = createTwoStepGuard();
    const first = resolveLiveHotkey(intent('break-even'), positionState(), guard, T0);
    expect(first.kind === 'prompt' && first.text).toBe('BE 21000.00? Shift+E znovu');
    // Přikoupení změnilo průměr → BE na jiné ceně.
    const moved = positionState({ entry: 21002 }, { entryAvg: 21002 });
    expect(resolveLiveHotkey(intent('break-even'), moved, guard, T0 + 600).kind).toBe('prompt');
    const run = resolveLiveHotkey(intent('break-even'), moved, guard, T0 + 1_000);
    expect(run).toMatchObject({ kind: 'run', command: 'break-even', price: 21002 });
  });

  it('Shift+E blokované stejně jako tlačítko BE (rozjeté SL, SL už na BE, neznámý průměr)', () => {
    const guard = createTwoStepGuard();
    const split = positionState({ stop: null });
    expect(resolveLiveHotkey(intent('break-even'), split, guard, T0)).toMatchObject({ kind: 'blocked', text: expect.stringMatching(/SL pozice není na jedné ceně/) });
    const atBe = positionState({ stop: 21000 });
    expect(resolveLiveHotkey(intent('break-even'), atBe, guard, T0)).toMatchObject({ kind: 'blocked', text: 'SL už je na BE.' });
    const fresh = positionState();
    expect(resolveLiveHotkey(intent('break-even'), { ...fresh, breakEven: null }, guard, T0).kind).toBe('blocked');
    expect(resolveLiveHotkey(intent('break-even'), { ...fresh, breakEven: { price: null, blocked: null } }, guard, T0).kind).toBe('blocked');
    // Tlačítko BE na čáře je vypnuté → klávesa také, i když čerstvý výpočet zrovna projde.
    expect(resolveLiveHotkey(intent('break-even'), { ...split, breakEven: { price: 21000, blocked: null } }, guard, T0)).toMatchObject({ kind: 'blocked', text: expect.stringMatching(/SL pozice není na jedné ceně/) });
    // Čerstvé BE při stisku blokuje, i když čára (memo z renderu) ještě ne.
    expect(resolveLiveHotkey(intent('break-even'), { ...fresh, breakEven: { price: 21000, blocked: 'Cena trhu od brokera není známá — utažení SL teď nejde.' } }, guard, T0).kind).toBe('blocked');
  });

  it('zablokovaný druhý stisk rozběhnutou výzvu zahodí', () => {
    const guard = createTwoStepGuard();
    const state = positionState();
    resolveLiveHotkey(intent('close-position'), state, guard, T0);
    expect(resolveLiveHotkey(intent('close-position'), { ...state, busy: true }, guard, T0 + 500)).toMatchObject({ kind: 'blocked', text: expect.stringMatching(/ještě běží/) });
    expect(resolveLiveHotkey(intent('close-position'), state, guard, T0 + 1_000).kind).toBe('prompt');
  });

  it('jiná zkratka mezi stisky výzvu zahodí (Shift+X, Shift+B, Shift+X = jen výzva)', () => {
    const guard = createTwoStepGuard();
    const state = positionState();
    resolveLiveHotkey(intent('close-position'), state, guard, T0);
    expect(resolveLiveHotkey({ kind: 'new-draft', side: 'buy' }, state, guard, T0 + 400)).toEqual({ kind: 'prefill-draft', side: 'buy' });
    expect(resolveLiveHotkey(intent('close-position'), state, guard, T0 + 800).kind).toBe('prompt');
    resolveLiveHotkey(intent('break-even'), state, guard, T0 + 1_000);
    resolveLiveHotkey(intent('help'), state, guard, T0 + 1_100);
    expect(resolveLiveHotkey(intent('break-even'), state, guard, T0 + 1_500).kind).toBe('prompt');
  });

  it('držená klávesa nepotvrdí: auto-repeat po 500 ms se k resolve vůbec nedostane', () => {
    const guard = createTwoStepGuard();
    const state = positionState();
    const outcomes: string[] = [];
    const dispatch = (event: LiveHotkeyEvent, at: number) => {
      const action = liveHotkeyAction(event, gate());
      if (action) outcomes.push(resolveLiveHotkey(action, state, guard, at).kind);
    };
    dispatch(letter('x'), T0);
    for (let at = T0 + 500; at < T0 + 4_000; at += 33) dispatch(letter('x', { repeat: true }), at);
    expect(outcomes).toEqual(['prompt']);
    // Nový skutečný stisk potvrdí.
    dispatch(letter('x'), T0 + 3_900);
    expect(outcomes).toEqual(['prompt', 'run']);
  });
});

describe('U1 klávesy: návrh, Esc, Flatten, nápověda', () => {
  it('Shift+B/S → jen návrh do panelu; vstup nikdy není příkaz `run`', () => {
    const guard = createTwoStepGuard();
    const state = positionState();
    for (const side of ['buy', 'sell'] as const) {
      // Ani opakovaně v okně dvoukroku.
      for (const at of [T0, T0 + 400, T0 + 800]) expect(resolveLiveHotkey({ kind: 'new-draft', side }, state, guard, at)).toEqual({ kind: 'prefill-draft', side });
    }
    expect(LIVE_HOTKEY_COMMANDS).toEqual(['break-even', 'close-position', 'cancel-pending']);
  });

  it('Esc zahodí jen existující návrh', () => {
    const guard = createTwoStepGuard();
    expect(resolveLiveHotkey(intent('discard-draft'), { ...positionState(), hasDraft: true }, guard, T0)).toEqual({ kind: 'discard-draft' });
    expect(resolveLiveHotkey(intent('discard-draft'), positionState(), guard, T0)).toEqual({ kind: 'none' });
  });

  it('Shift+F jen otevře dialog — i když běží jiná akce (nouzová cesta se neblokuje)', () => {
    const guard = createTwoStepGuard();
    expect(resolveLiveHotkey(intent('flatten-dialog'), { ...positionState(), busy: true }, guard, T0)).toEqual({ kind: 'open-flatten' });
    expect(resolveLiveHotkey(intent('flatten-dialog'), { lines: [], breakEven: null, hasDraft: false, busy: false }, guard, T0)).toEqual({ kind: 'open-flatten' });
    // Dvojí Shift+F nikdy nevrátí `run`.
    expect(resolveLiveHotkey(intent('flatten-dialog'), positionState(), guard, T0 + 500)).toEqual({ kind: 'open-flatten' });
  });

  it('? přepne nápovědu', () => {
    expect(resolveLiveHotkey(intent('help'), positionState(), createTwoStepGuard(), T0)).toEqual({ kind: 'toggle-help' });
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
    expect(imports).toEqual(['../services/backtestOrderLines', './liveChartOrderLines', './liveOrderTicket']);
    expect(source).toMatch(/import type \{ BacktestChartOrderLine \} from '\.\.\/services\/backtestOrderLines'/);
  });

  it('nevolá žádný callback příkazu ani síť', () => {
    expect(source).not.toMatch(/\b(placeLeaderEntry|previewLeaderEntry|manageLeaderEntry|attachBrackets|runStaticSafetyAction|onPlaceEntry|onManageEntry|sendDirect|runLiveManage|executeTradovateCopierRelayCommand|fetch)\s*\(/);
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/);
  });
});
