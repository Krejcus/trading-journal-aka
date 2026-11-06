import { liveRepeatClick, type LiveClickState } from './liveClickGate';
import type { BacktestChartOrderLine } from '../services/backtestOrderLines';
import { LIVE_PENDING_ADD_LINE_ID, LIVE_POSITION_OWNER } from './liveChartOrderLines';
import { newTicketDraft, type TicketDraft, type TicketInstrument, type TicketQuote, type TicketSide } from './liveOrderTicket';

/**
 * Klávesové zkratky LIVE → Graf na PC (U1, 11/2026) — čistý výklad klávesy na
 * ZÁMĚR uživatele. Nic odsud neodesílá příkaz a nic tu neautorizuje
 * (INV-UI-01..04):
 *
 * - Shift+B / Shift+S jen předvyplní panel objednávky (jako ⚡, pravidlo Filipa
 *   z 29. 10. „⚡ v live jen vyplní panel“). Odeslání zůstává jen na tlačítku
 *   panelu; globální Enter se nezavádí.
 * - Shift+E / Shift+X / Shift+C (BE, zavřít, zrušit čekající) odešlou prvním stiskem
 *   (Filip 5. 11. 2026, bez výzvy) a smí jen to, co právě nabízí čára v grafu. Výsledkem je
 *   záměr `run` s TOUŽ čárou, kterou integrace předá stejné funkci jako klik
 *   myší (`onOrderLineAction` / `onOrderLineCancel` v `LiveTradingScreen`).
 *   Držená klávesa a rychlý dvojstisk nic dalšího nepošlou.
 *   „Co jsem viděl“ dál bere desk z read modelu brokera a worker vše ověří znovu.
 * - Shift+F jen otevře existující dialog Flatten All z `LiveSafetyControls`
 *   (`lib/liveSafetyShortcut.ts`), potvrzuje se v dialogu (INV-UI-02).
 * - Držená klávesa (`event.repeat`) se ignoruje vždy — nikdy z ní nevznikne
 *   druhý krok potvrzení ani druhý návrh (INV-RELAY-01, INV-MANUAL-01).
 */

export type LiveHotkeyIntent =
  | { kind: 'new-draft'; side: TicketSide }
  | { kind: 'discard-draft' }
  | { kind: 'break-even' }
  | { kind: 'close-position' }
  | { kind: 'cancel-pending' }
  | { kind: 'flatten-dialog' }
  | { kind: 'help' };

/** Klávesy, které spustí správu živé pozice (vstup mezi nimi NENÍ). */
export type LiveHotkeyCommand = 'break-even' | 'close-position' | 'cancel-pending';
export const LIVE_HOTKEY_COMMANDS: readonly LiveHotkeyCommand[] = ['break-even', 'close-position', 'cancel-pending'];

/** Shift+B/S předvyplní Market jen s cenou panelu starou nejvýš 3 s; jinak Limit ±10 b. */
export const LIVE_HOTKEY_MARKET_QUOTE_MAX_AGE_MS = 3_000;
export const LIVE_HOTKEY_LIMIT_OFFSET_POINTS = 10;
/** Malý posun hodin mezi zdrojem ceny a `Date.now()`; cena „z budoucnosti“ víc = neznámé stáří. */
const QUOTE_CLOCK_SKEW_MS = 1_000;

/** Nápověda pod „?“ (`components/LiveHotkeysHelp.tsx`). */
export const LIVE_HOTKEY_HELP: ReadonlyArray<{ keys: string; text: string }> = [
  { keys: 'Shift+B', text: 'Nový návrh Koupit v panelu — nic neodešle' },
  { keys: 'Shift+S', text: 'Nový návrh Prodat v panelu — nic neodešle' },
  { keys: 'Esc', text: 'Zahodit návrh (jen když kreslení v grafu nic nedělá)' },
  { keys: 'Shift+E', text: 'SL na BE — odešle hned' },
  { keys: 'Shift+X', text: 'Zavřít pozici (jen když ji nabízí × na čáře) — odešle hned' },
  { keys: 'Shift+C', text: 'Zrušit čekající vstup nebo přikoupení — odešle hned' },
  { keys: 'Shift+F', text: 'Otevřít dialog Flatten All (potvrzuje se v dialogu)' },
  { keys: '?', text: 'Tato nápověda' },
];
/**
 * Zámek jednoho příkazu drží jiný příkaz (i rozběhnutý vstup z panelu nebo „Zrušit čekající“ —
 * až ~35 s relaye): Flatten All jím neprochází (INV-UI-02), proto ho text nabízí.
 */
export const LIVE_HOTKEY_BUSY_TEXT = 'Předchozí živá akce ještě běží — nic se neodeslalo. Zavřít jde hned Flattenem (Shift+F).';
export const LIVE_HOTKEY_HELP_NOTE = 'Vstup odešle jen tlačítko v panelu objednávky. Držená klávesa se nepočítá.';

// ---------------------------------------------------------------------------
// Klávesa → záměr
// ---------------------------------------------------------------------------

/** Cíl události strukturálně (testy bez DOM; v prohlížeči `KeyboardEvent.target`). */
export interface LiveHotkeyEventTarget {
  tagName?: string;
  isContentEditable?: boolean;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
}

/** Podmnožina `KeyboardEvent` — skutečnou událost jde předat přímo. */
export interface LiveHotkeyEvent {
  key: string;
  code?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  defaultPrevented?: boolean;
  target?: unknown;
}

/** Stav obrazovky, ve kterém klávesy nesmí nic dělat. Neznámá hodnota = blokováno. */
export interface LiveHotkeyGate {
  /** Otevřený modální dialog (potvrzení, nouzová lišta, menu) — klávesy patří jemu. */
  dialogOpen: boolean;
  /** Graf odchází (animace odchodu z LIVE → Graf). */
  leaving: boolean;
  /** Stránka není vidět (`document.visibilityState !== 'visible'`). */
  hidden: boolean;
  /**
   * Jen pro Esc: kreslení v grafu je nečinné (žádný nástroj, rozkreslená kresba
   * ani výběr — `chartDrawingIdle`). Bez potvrzené nečinnosti Esc návrh nezahodí,
   * první Esc patří kreslení.
   */
  drawingIdle?: boolean;
}

/** Textová pole a prvky, kde klávesa patří psaní. */
export const LIVE_HOTKEY_EDITABLE_SELECTOR = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"], [role="combobox"], [role="spinbutton"]';
/** Fokus uvnitř dialogu: klávesa patří dialogu (Enter/Esc potvrzovacího okna). */
export const LIVE_HOTKEY_DIALOG_SELECTOR = '[role="dialog"], [role="alertdialog"], [aria-modal="true"]';
const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

const LETTER_INTENTS = new Map<string, LiveHotkeyIntent>([
  ['b', { kind: 'new-draft', side: 'buy' }],
  ['s', { kind: 'new-draft', side: 'sell' }],
  ['e', { kind: 'break-even' }],
  ['x', { kind: 'close-position' }],
  ['c', { kind: 'cancel-pending' }],
  ['f', { kind: 'flatten-dialog' }],
]);

const closestMatches = (target: LiveHotkeyEventTarget, selector: string): boolean => {
  if (typeof target.closest !== 'function') return false;
  // Neznámý výsledek (výjimka selektoru) = raději nic neudělat.
  try { return target.closest(selector) != null; } catch { return true; }
};

/** Klávesa míří do pole, editoru nebo dialogu → zkratky mlčí. */
export function liveHotkeyTargetBlocked(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const target = value as LiveHotkeyEventTarget;
  try {
    const tag = typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
    if (EDITABLE_TAGS.has(tag)) return true;
    if (target.isContentEditable === true) return true;
    const role = typeof target.getAttribute === 'function' ? target.getAttribute('role') : null;
    if (role && TEXT_ROLES.has(role)) return true;
  } catch { return true; }
  return closestMatches(target, LIVE_HOTKEY_EDITABLE_SELECTOR) || closestMatches(target, LIVE_HOTKEY_DIALOG_SELECTOR);
}

/**
 * Písmeno klávesy: znak, který uživatel vidí (Shift+X na Dvoraku = X), a jen
 * u nelatinkového rozložení (azbuka…) fyzická klávesa z `code`.
 */
const keyLetter = (event: LiveHotkeyEvent): string | null => {
  if (typeof event.key === 'string' && /^[a-z]$/i.test(event.key)) return event.key.toLowerCase();
  const code = typeof event.code === 'string' ? /^Key([A-Z])$/.exec(event.code) : null;
  return code ? code[1].toLowerCase() : null;
};

/** Mapa kláves bez kontextu. Písmena jen se Shiftem (samotné „b“ nic nedělá). */
export function liveHotkeyIntent(event: LiveHotkeyEvent): LiveHotkeyIntent | null {
  if (event.key === '?') return { kind: 'help' };
  if (event.key === 'Escape' || event.key === 'Esc') return event.shiftKey ? null : { kind: 'discard-draft' };
  if (event.shiftKey !== true) return null;
  const letter = keyLetter(event);
  const intent = letter ? LETTER_INTENTS.get(letter) : undefined;
  return intent ? { ...intent } : null;
}

/**
 * Záměr klávesy, nebo `null`, když zkratka nesmí nic udělat: držená klávesa
 * (`repeat`), skládání znaku (IME), Meta/Ctrl/Alt, už zpracovaná událost, cíl
 * v poli/editoru/dialogu, otevřený dialog, odchod z grafu nebo skrytá stránka.
 * Integrace volá `preventDefault()` jen u nenulového výsledku.
 */
export function liveHotkeyAction(event: LiveHotkeyEvent, gate: LiveHotkeyGate): LiveHotkeyIntent | null {
  // Držená klávesa nikdy: ani další příkaz, ani další návrh.
  if (event.repeat === true) return null;
  if (event.isComposing === true || event.key === 'Process' || event.key === 'Dead' || event.keyCode === 229) return null;
  if (event.metaKey === true || event.ctrlKey === true || event.altKey === true) return null;
  if (event.defaultPrevented === true) return null;
  if (gate.dialogOpen !== false || gate.leaving !== false || gate.hidden !== false) return null;
  if (liveHotkeyTargetBlocked(event.target)) return null;
  const intent = liveHotkeyIntent(event);
  if (intent?.kind === 'discard-draft' && gate.drawingIdle !== true) return null;
  return intent;
}

/**
 * Kreslení v grafu nic nedělá: žádný aktivní nástroj, rozkreslená kresba ani
 * výběr. Stav se čte v capture fázi DŘÍV, než ho candlekit na Esc změní —
 * první Esc tak zruší kresbu, teprve druhý zahodí návrh.
 */
export function chartDrawingIdle(state: { activeTool: unknown; draft: unknown; selectedId: unknown }): boolean {
  const empty = (value: unknown) => value == null || value === '' || value === false;
  return empty(state.activeTool) && empty(state.draft) && empty(state.selectedId);
}

// ---------------------------------------------------------------------------
// Shift+B / Shift+S → návrh do panelu (nikdy příkaz)
// ---------------------------------------------------------------------------

export interface LiveHotkeyDraftInput {
  /** Orientační bid/ask panelu (`quote` v `LiveTradingScreen`); null = bez ceny. */
  quote: TicketQuote | null;
  /** Čas poslední ceny panelu (`quoteInfo.capturedAt` / `tick.at`); null = neznámý. */
  quoteAt: number | null;
  /** Kanál ceny není živý (`quoteInfo.stale`). */
  quoteStale: boolean;
  /** Worker inzeruje Market vstup (`entryMarketSupported`, `lib/copierWorkerCapabilities.ts`). */
  marketSupported: boolean;
  instrument: TicketInstrument;
  /** Velikost z předchozího návrhu (jako pravý klik do grafu). */
  base?: Pick<TicketDraft, 'sizing' | 'quantity' | 'riskUsd'>;
  /**
   * Výchozí šablona SL/TP (U8). Dostane návrh s výchozími 12 b / 2R; převezmou
   * se z ní JEN `stopLoss` a `takeProfit` (strana, typ, cena ani velikost se
   * šablonou nemění). Výjimka šablony = výchozí závorky.
   */
  applyBrackets?: (draft: TicketDraft) => TicketDraft;
  now: number;
}

/** Market smí jen s čerstvou cenou panelu a s Marketem inzerovaným workerem. */
export function liveHotkeyMarketAllowed(input: Pick<LiveHotkeyDraftInput, 'quote' | 'quoteAt' | 'quoteStale' | 'marketSupported' | 'now'>): boolean {
  if (input.marketSupported !== true || input.quoteStale !== false || !input.quote) return false;
  if (input.quoteAt == null || !Number.isFinite(input.quoteAt) || !Number.isFinite(input.now)) return false;
  const age = input.now - input.quoteAt;
  return age >= -QUOTE_CLOCK_SKEW_MS && age <= LIVE_HOTKEY_MARKET_QUOTE_MAX_AGE_MS;
}

/**
 * Návrh pro Shift+B / Shift+S: Market (worker ho umí a cena ≤ 3 s), jinak Limit
 * ±10 b od trhu jako tlačítko strany panelu (`onNewDraft`). Jen data pro panel —
 * odeslat ho jde jen tlačítkem panelu. V pozici na její stranu si panel sám
 * převezme SL/TP pozice (přikoupení).
 */
export function liveHotkeyDraft(side: TicketSide, input: LiveHotkeyDraftInput): { draft: TicketDraft } | { error: string } {
  const quote = input.quote;
  if (!quote || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)) return { error: 'Čekám na cenu z grafu — návrh nevznikl.' };
  const market = liveHotkeyMarketAllowed(input);
  const price = side === 'buy' ? quote.ask - LIVE_HOTKEY_LIMIT_OFFSET_POINTS : quote.bid + LIVE_HOTKEY_LIMIT_OFFSET_POINTS;
  const draft = newTicketDraft(side, market ? 'market' : 'limit', price, input.instrument, quote, input.base);
  if (!input.applyBrackets) return { draft };
  try {
    const templated = input.applyBrackets({ ...draft });
    // Neplatná hodnota šablony (NaN, chybějící pole) = výchozí závorka; null = šablona závorku nechce.
    const level = (value: number | null | undefined, fallback: number | null): number | null => (
      value === null ? null : typeof value === 'number' && Number.isFinite(value) ? value : fallback
    );
    return { draft: { ...draft, stopLoss: level(templated?.stopLoss, draft.stopLoss), takeProfit: level(templated?.takeProfit, draft.takeProfit) } };
  } catch {
    return { draft };
  }
}

// ---------------------------------------------------------------------------
// Záměr + stav grafu → výsledek pro integraci
// ---------------------------------------------------------------------------

export interface LiveHotkeyState {
  /** Čáry grafu (`orderLines` v `LiveTradingScreen`): klávesa smí jen to, co nabízí čára. */
  lines: readonly BacktestChartOrderLine[];
  /**
   * BE spočítané v okamžiku stisku stejnou funkcí jako tlačítko na čáře
   * (`liveBreakEven(guardSummaryAt(Date.now()) ?? summary, manageEntryAvgPrice)`).
   */
  breakEven: { price: number | null; blocked: string | null } | null;
  hasDraft: boolean;
  /** Běží jiná živá akce (`liveBusyRef`). Nouzový Flatten tím blokovaný není. */
  busy: boolean;
}

export type LiveHotkeyOutcome =
  | { kind: 'prefill-draft'; side: TicketSide }
  | { kind: 'discard-draft' }
  | { kind: 'run'; command: LiveHotkeyCommand; line: BacktestChartOrderLine; price: number }
  | { kind: 'blocked'; command: LiveHotkeyCommand; text: string }
  | { kind: 'open-flatten' }
  | { kind: 'toggle-help' }
  | { kind: 'none' };

const price2 = (value: number) => value.toFixed(2);
/** „LONG 2“, „BUY 1 LIMIT“, „PŘIKOUPENÍ BUY 1 LIMIT“ — tvar čáry bez ceny a P&L (stejné dělení jako štítek). */
const lineShape = (line: BacktestChartOrderLine) => line.label.trim().split(/\s{2,}/)[0] ?? '';

/**
 * Klíč proti dvojstisku: příkaz + čára + akce × + tvar (strana, qty, typ) + cena.
 */
export const liveHotkeyConfirmKey = (command: LiveHotkeyCommand, line: BacktestChartOrderLine, price: number): string => (
  `${command}:${line.id}:${line.cancelAction ?? line.ownerType}:${lineShape(line)}:${price}`
);

type HotkeyTarget = { line: BacktestChartOrderLine; price: number; text: string } | { blocked: string };

const single = (candidates: BacktestChartOrderLine[], none: string): BacktestChartOrderLine | { blocked: string } => {
  if (candidates.length === 1) return candidates[0];
  return { blocked: candidates.length ? 'Víc možných příkazů — použij ovládání přímo na čáře v grafu. Nic se neodeslalo.' : none };
};

/** Čára, na kterou klávesa míří — přesně ta, která totéž nabízí myší. */
function hotkeyTarget(command: LiveHotkeyCommand, state: LiveHotkeyState): HotkeyTarget {
  const own = state.lines.filter(line => line.ownerId === LIVE_POSITION_OWNER && line.kind === 'entry' && Number.isFinite(line.price));
  if (command === 'break-even') {
    const picked = single(own.filter(line => line.ownerType === 'position' && line.actions?.some(action => action.id === 'break-even')), 'BE jde jen u vyplněné spravovatelné pozice.');
    if ('blocked' in picked) return picked;
    const action = picked.actions?.find(item => item.id === 'break-even');
    if (!action || action.disabled) return { blocked: action?.title ?? 'BE teď nejde.' };
    const be = state.breakEven;
    if (!be || be.blocked) return { blocked: be?.blocked ?? 'BE teď nejde.' };
    if (be.price == null || !Number.isFinite(be.price)) return { blocked: 'Průměrný vstup leadera není známý — BE teď nejde.' };
    return { line: picked, price: be.price, text: `BE ${price2(be.price)}?` };
  }
  if (command === 'close-position') {
    const picked = single(
      own.filter(line => line.ownerType === 'position' && line.cancellable === true && line.cancelAction === 'close-position'),
      'Zavřít jde jen pozice, kterou nabízí × na čáře (spravovatelná, kopírka čerstvě zapnutá).',
    );
    if ('blocked' in picked) return picked;
    return { line: picked, price: picked.price, text: `Zavřít ${lineShape(picked)} @ ${price2(picked.price)}?` };
  }
  const picked = single(
    own.filter(line => line.ownerType === 'order' && line.cancellable === true && line.cancelAction === 'cancel-order'),
    'Není co zrušit — žádný čekající vstup ani přikoupení.',
  );
  if ('blocked' in picked) return picked;
  const what = picked.id === LIVE_PENDING_ADD_LINE_ID ? 'čekající přikoupení' : `čekající vstup ${lineShape(picked)}`;
  return { line: picked, price: picked.price, text: `Zrušit ${what} @ ${price2(picked.price)}?` };
}

/**
 * Záměr klávesy → co má integrace udělat. Jediný výsledek, který vede k příkazu, je `run`
 * (BE / zavřít / zrušit čekající): první stisk, když to čára nabízí a nic jiného neběží. Rychlý
 * dvojstisk téhož klíče (`repeat`, ref volajícího) nic dalšího nepošle.
 * Vstup (`prefill-draft`) je vždy jen návrh do panelu.
 */
export function resolveLiveHotkey(intent: LiveHotkeyIntent, state: LiveHotkeyState, repeat: { current: LiveClickState | null }, now: number): LiveHotkeyOutcome {
  switch (intent.kind) {
    case 'break-even':
    case 'close-position':
    case 'cancel-pending': {
      const command = intent.kind;
      if (state.busy) return { kind: 'blocked', command, text: LIVE_HOTKEY_BUSY_TEXT };
      const target = hotkeyTarget(command, state);
      if ('blocked' in target) return { kind: 'blocked', command, text: target.blocked };
      const step = liveRepeatClick(repeat.current, liveHotkeyConfirmKey(command, target.line, target.price), now);
      repeat.current = step.next;
      return step.send ? { kind: 'run', command, line: target.line, price: target.price } : { kind: 'none' };
    }
    case 'new-draft':
      return { kind: 'prefill-draft', side: intent.side };
    case 'discard-draft':
      return state.hasDraft ? { kind: 'discard-draft' } : { kind: 'none' };
    case 'flatten-dialog':
      // Nouzová cesta: ani běžící akce ji neblokuje; jen otevře dialog.
      return { kind: 'open-flatten' };
    case 'help':
      return { kind: 'toggle-help' };
    default:
      return { kind: 'none' };
  }
}
