import { LEADER_ENTRY_MAX_QUANTITY } from './leaderEntryPreview';
import type { LiveTicketScaleIn } from './liveScaleIn';
import {
  DEFAULT_STOP_POINTS,
  newTicketDraft,
  snapToTick,
  ticketEntry,
  type TicketDraft,
  type TicketInstrument,
  type TicketOrderType,
  type TicketProblem,
  type TicketQuote,
  type TicketSide,
} from './liveOrderTicket';
import { MANUAL_ENTRY_MARKET_MIN_BRACKET_TICKS } from '../services/manualEntryPreview';

/**
 * ATM šablony živého panelu (U8, 3. 11. 2026): uložené výchozí SL/TP uživatele
 * jako VZDÁLENOST od vstupu (ticky / body, TP i v násobcích R) a volitelná
 * velikost. Čistý výpočet — jen předvyplní návrh v panelu nebo listu, nic
 * neodesílá a nic neautorizuje (INV-UI-01). Odeslání dál jen tlačítkem panelu
 * („⚡ v live jen vyplní panel“) a worker vše přepočítá znovu (INV-MANUAL-01:
 * příkaz nese absolutní ceny spočtené až z návrhu).
 *
 * Šablona nikdy neukládá cenu (INV-UI-04): ani cenu z kanálu TV/IBKR, ani
 * cenu vstupu. Proto `sanitize` odmítne jednotky „cena“ a „$“.
 *
 * Nestaví se „odstup od skutečného fillu“ (přepočet SL/TP po fillu Marketu) —
 * to je změna jádra kopírky. Šablona se počítá od plánovaného vstupu návrhu.
 */

export type LiveTemplateStopUnit = 'ticks' | 'pts';
/** TP navíc v `r` = násobek vzdálenosti SL. */
export type LiveTemplateTargetUnit = LiveTemplateStopUnit | 'r';

export interface LiveTemplateDistance<Unit extends string> {
  unit: Unit;
  value: number;
}

/** Velikost ze šablony: kontrakty, nebo riziko v $ (počet pak spočte panel ze SL). */
export type LiveTemplateSizing =
  | { mode: 'qty'; quantity: number }
  | { mode: 'risk'; riskUsd: number };

export interface LiveBracketTemplate {
  id: string;
  name: string;
  /** SL je v šabloně povinný — výchozí šablona nesmí nikdy tiše odebrat stop loss. */
  stopLoss: LiveTemplateDistance<LiveTemplateStopUnit>;
  /** Null = šablona bez TP (runner). */
  takeProfit: LiveTemplateDistance<LiveTemplateTargetUnit> | null;
  /** Null = velikost zůstane z panelu (tak se chová i vestavěná 12 b / 2R). */
  sizing: LiveTemplateSizing | null;
  /** ISO čas poslední úpravy (jen řazení / poslední zápis vyhrává). */
  updatedAt: string;
}

/** Co zadá uživatel při „Uložit jako šablonu“ (id a čas doplní modul). */
export type LiveBracketTemplateInput = Omit<LiveBracketTemplate, 'id' | 'updatedAt'>;

export interface LiveBracketTemplateLibrary {
  templates: LiveBracketTemplate[];
  /** Id výchozí šablony (★); null = vestavěná 12 b / 2R. */
  defaultId: string | null;
}

/** Prázdná knihovna (jen vestavěná šablona) — vždy nový objekt, ať ho nikdo nesdílí. */
export const emptyLiveBracketTemplateLibrary = (): LiveBracketTemplateLibrary => ({ templates: [], defaultId: null });

/** Meze proti poškozeným datům a překlepům — rozhoduje stejně worker, ne tyto čísla. */
export const LIVE_TEMPLATE_MAX_COUNT = 12;
export const LIVE_TEMPLATE_NAME_MAX = 32;
export const LIVE_TEMPLATE_MAX_TICKS = 2000;
export const LIVE_TEMPLATE_MAX_POINTS = 500;
export const LIVE_TEMPLATE_MIN_R = 0.1;
export const LIVE_TEMPLATE_MAX_R = 20;
/** Stejný strop jako validace příkazu (`validateLeaderEntryPreview`); skutečný strop skupiny je nižší. */
export const LIVE_TEMPLATE_MAX_QUANTITY = LEADER_ENTRY_MAX_QUANTITY;
export const LIVE_TEMPLATE_MAX_RISK_USD = 10_000;
/** Stejné číslo, jaké vynucuje worker u Marketu se SL/TP (`manualEntryMarketQuoteBlockers`). */
export const LIVE_TEMPLATE_MARKET_MIN_BRACKET_TICKS = MANUAL_ENTRY_MARKET_MIN_BRACKET_TICKS;

export const LIVE_BUILTIN_TEMPLATE_ID = 'builtin:12b-2r';
const BUILTIN_PREFIX = 'builtin:';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EPOCH = new Date(0).toISOString();

/**
 * Vestavěná šablona = dosavadní pevné chování `withBracket` / `newTicketDraft`
 * (SL 12 b, TP 2R, velikost z panelu). Neukládá se a nejde smazat.
 */
export const LIVE_BUILTIN_BRACKET_TEMPLATE: LiveBracketTemplate = Object.freeze({
  id: LIVE_BUILTIN_TEMPLATE_ID,
  name: 'Výchozí',
  stopLoss: Object.freeze({ unit: 'pts', value: DEFAULT_STOP_POINTS }),
  takeProfit: Object.freeze({ unit: 'r', value: 2 }),
  sizing: null,
  updatedAt: EPOCH,
}) as LiveBracketTemplate;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value != null && typeof value === 'object' && !Array.isArray(value)
);
const direction = (side: TicketSide) => (side === 'buy' ? 1 : -1);
const round = (value: number, digits: number) => Number(value.toFixed(digits));
const nameKey = (name: string) => name.trim().toLocaleLowerCase('cs-CZ');

export const isBuiltinLiveBracketTemplateId = (id: string | null | undefined): boolean => (
  typeof id === 'string' && id.startsWith(BUILTIN_PREFIX)
);

export const newLiveBracketTemplateId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

const distanceError = (label: 'SL' | 'TP', distance: LiveTemplateDistance<string>): string | null => {
  const { unit, value } = distance;
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${label}: zadej číslo.`;
  if (unit === 'ticks') {
    if (!Number.isInteger(value)) return `${label}: ticky musí být celé číslo.`;
    if (value < 1 || value > LIVE_TEMPLATE_MAX_TICKS) return `${label}: 1 až ${LIVE_TEMPLATE_MAX_TICKS} ticků.`;
    return null;
  }
  if (unit === 'pts') return value > 0 && value <= LIVE_TEMPLATE_MAX_POINTS ? null : `${label}: víc než 0 a nejvýš ${LIVE_TEMPLATE_MAX_POINTS} bodů.`;
  if (unit === 'r' && label === 'TP') {
    return value >= LIVE_TEMPLATE_MIN_R && value <= LIVE_TEMPLATE_MAX_R ? null : `TP: ${LIVE_TEMPLATE_MIN_R} až ${LIVE_TEMPLATE_MAX_R} R.`;
  }
  // „cena“ ani „$“ do šablony nesmí: cena by ukládala čísla z grafu (INV-UI-04),
  // $ by se tiše měnily s počtem kontraktů.
  return `${label}: šablona ukládá jen vzdálenost v ticích nebo bodech${label === 'TP' ? ' (TP i v R)' : ''}.`;
};

/** Chyby šablony česky (prázdné pole = v pořádku). Stejná pravidla jako `sanitize`. */
export function validateLiveBracketTemplate(input: LiveBracketTemplateInput): string[] {
  const errors: string[] = [];
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) errors.push('Šablona potřebuje název.');
  else if (name.length > LIVE_TEMPLATE_NAME_MAX) errors.push(`Název nejvýš ${LIVE_TEMPLATE_NAME_MAX} znaků.`);
  if (!input.stopLoss) errors.push('Šablona potřebuje stop loss.');
  else {
    const error = distanceError('SL', input.stopLoss);
    if (error) errors.push(error);
  }
  if (input.takeProfit) {
    const error = distanceError('TP', input.takeProfit);
    if (error) errors.push(error);
  }
  const sizing = input.sizing;
  if (sizing) {
    if (sizing.mode === 'qty') {
      if (!Number.isInteger(sizing.quantity) || sizing.quantity < 1 || sizing.quantity > LIVE_TEMPLATE_MAX_QUANTITY) {
        errors.push(`Počet kontraktů 1 až ${LIVE_TEMPLATE_MAX_QUANTITY} (celé číslo).`);
      }
    } else if (sizing.mode === 'risk') {
      if (typeof sizing.riskUsd !== 'number' || !(sizing.riskUsd > 0) || sizing.riskUsd > LIVE_TEMPLATE_MAX_RISK_USD) {
        errors.push(`Riziko víc než 0 a nejvýš ${LIVE_TEMPLATE_MAX_RISK_USD} $.`);
      }
    } else {
      errors.push('Neznámý způsob velikosti.');
    }
  }
  return errors;
}

const parseDistance = <Unit extends string>(value: unknown, units: readonly Unit[]): LiveTemplateDistance<Unit> | null => {
  if (!isRecord(value) || typeof value.unit !== 'string' || !(units as readonly string[]).includes(value.unit)) return null;
  if (typeof value.value !== 'number') return null;
  return { unit: value.unit as Unit, value: value.value };
};

const parseSizing = (value: unknown): LiveTemplateSizing | null | undefined => {
  if (value == null) return null;
  if (!isRecord(value)) return undefined;
  if (value.mode === 'qty' && typeof value.quantity === 'number') return { mode: 'qty', quantity: value.quantity };
  if (value.mode === 'risk' && typeof value.riskUsd === 'number') return { mode: 'risk', riskUsd: value.riskUsd };
  return undefined;
};

/**
 * Šablona z neznámých dat (úložiště, jiné zařízení, starší verze appky) —
 * cokoli podezřelého ji celou odmítne (null), nic se „neopravuje“ na jiná
 * čísla, než jaká uživatel uložil. Vestavěné id do uložených dat nepatří.
 */
export function sanitizeLiveBracketTemplate(value: unknown): LiveBracketTemplate | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== 'string' || !ID_PATTERN.test(value.id) || isBuiltinLiveBracketTemplateId(value.id)) return null;
  if (typeof value.name !== 'string') return null;
  const stopLoss = parseDistance(value.stopLoss, ['ticks', 'pts'] as const);
  if (!stopLoss) return null;
  let takeProfit: LiveTemplateDistance<LiveTemplateTargetUnit> | null = null;
  if (value.takeProfit != null) {
    takeProfit = parseDistance(value.takeProfit, ['ticks', 'pts', 'r'] as const);
    if (!takeProfit) return null;
  }
  const sizing = parseSizing(value.sizing);
  if (sizing === undefined) return null;
  const input: LiveBracketTemplateInput = { name: value.name.trim(), stopLoss, takeProfit, sizing };
  if (validateLiveBracketTemplate(input).length) return null;
  const time = typeof value.updatedAt === 'string' ? Date.parse(value.updatedAt) : NaN;
  return { id: value.id, ...input, updatedAt: new Date(Number.isFinite(time) ? time : 0).toISOString() };
}

/** Knihovna z neznámých dat: neplatné šablony vypadnou, duplicitní id/název vyhrává první, ★ jen na existující. */
export function sanitizeLiveBracketTemplateLibrary(value: unknown): LiveBracketTemplateLibrary {
  if (!isRecord(value)) return emptyLiveBracketTemplateLibrary();
  const list = Array.isArray(value.templates) ? value.templates : [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const templates: LiveBracketTemplate[] = [];
  for (const raw of list) {
    if (templates.length >= LIVE_TEMPLATE_MAX_COUNT) break;
    const template = sanitizeLiveBracketTemplate(raw);
    if (!template || ids.has(template.id) || names.has(nameKey(template.name))) continue;
    ids.add(template.id);
    names.add(nameKey(template.name));
    templates.push(template);
  }
  const defaultId = typeof value.defaultId === 'string' && ids.has(value.defaultId) ? value.defaultId : null;
  return { templates, defaultId };
}

export type LiveTemplateCreateResult =
  | { ok: true; template: LiveBracketTemplate }
  | { ok: false; errors: string[] };

/** Nová (nebo upravená) šablona z formuláře; chyby česky, nic se nezaokrouhluje potichu. */
export function createLiveBracketTemplate(
  input: LiveBracketTemplateInput,
  options: { id?: string; now?: Date } = {},
): LiveTemplateCreateResult {
  const normalized: LiveBracketTemplateInput = { ...input, name: typeof input.name === 'string' ? input.name.trim() : '' };
  const errors = validateLiveBracketTemplate(normalized);
  if (errors.length) return { ok: false, errors };
  const template = sanitizeLiveBracketTemplate({
    ...normalized,
    id: options.id ?? newLiveBracketTemplateId(),
    updatedAt: (options.now ?? new Date()).toISOString(),
  });
  return template ? { ok: true, template } : { ok: false, errors: ['Šablonu nejde uložit (neplatné id).'] };
}

// ---------------------------------------------------------------------------
// Vzdálenost → ceny

/** SL šablony v celých ticích (aspoň 1 — SL nikdy neleží na vstupu). */
export const liveTemplateStopTicks = (template: Pick<LiveBracketTemplate, 'stopLoss'>, tickSize: number): number => (
  template.stopLoss.unit === 'ticks'
    ? template.stopLoss.value
    : Math.max(1, Math.round(template.stopLoss.value / tickSize))
);

/** TP šablony v celých ticích; `r` = násobek skutečné vzdálenosti SL v ticích. */
export const liveTemplateTargetTicks = (
  template: Pick<LiveBracketTemplate, 'takeProfit'>,
  stopTicks: number,
  tickSize: number,
): number | null => {
  const target = template.takeProfit;
  if (!target) return null;
  if (target.unit === 'ticks') return target.value;
  if (target.unit === 'r') return Math.max(1, Math.round(target.value * stopTicks));
  return Math.max(1, Math.round(target.value / tickSize));
};

export interface LiveTemplateBracketPrices {
  stopLoss: number;
  takeProfit: number | null;
  stopTicks: number;
  targetTicks: number | null;
}

/**
 * Ceny SL/TP šablony pro stranu a vstup, zarovnané na tick: SL proti směru
 * obchodu, TP po směru. Vstup = plánovaná cena návrhu (u „Přidat SL/TP“ k holé
 * pozici průměr pozice od workeru). Null = neplatný vstup nebo tick.
 */
export function liveTemplateBracketPrices(
  template: Pick<LiveBracketTemplate, 'stopLoss' | 'takeProfit'>,
  side: TicketSide,
  entry: number,
  tickSize: number,
  /** Skutečný SL v ticích, ke kterému se počítá TP v R (Přidat jen TP k existujícímu SL). */
  stopTicksForR?: number,
): LiveTemplateBracketPrices | null {
  if (!Number.isFinite(entry) || !(tickSize > 0) || !Number.isFinite(tickSize)) return null;
  const d = direction(side);
  const stopTicks = liveTemplateStopTicks(template, tickSize);
  const targetTicks = liveTemplateTargetTicks(template, stopTicksForR ?? stopTicks, tickSize);
  return {
    stopLoss: snapToTick(entry - d * stopTicks * tickSize, tickSize),
    takeProfit: targetTicks == null ? null : snapToTick(entry + d * targetTicks * tickSize, tickSize),
    stopTicks,
    targetTicks,
  };
}

export interface LiveTemplateApplyOptions {
  /**
   * Otevřená pozice z vlastních lístků. Návrh na její stranu je přikoupení —
   * platí SL/TP pozice (worker jiné nepustí), šablona se ignoruje.
   */
  scaleIn?: Pick<LiveTicketScaleIn, 'side'> | null;
  /** ⚡ z position boxu: SL/TP i velikost jsou z boxu, šablona se nepoužije. */
  fromPositionBox?: boolean;
  /** Jen chybějící SL/TP („Přidat SL/TP“, „+“ u čáry); existující ceny se nemění. */
  onlyMissing?: boolean;
  /** Převzít i velikost šablony (výchozí ano; s `onlyMissing` nikdy). */
  applySizing?: boolean;
  /** Strop kontraktů účtu/skupiny — počet ze šablony se nad něj nezvedne. */
  maxContracts?: number;
}

export type LiveTemplateSkipReason = 'scale-in' | 'position-box' | 'invalid';

export interface LiveTemplateApplyResult {
  draft: TicketDraft;
  /** True = šablona návrh změnila (aspoň závorky). */
  applied: boolean;
  skipped: LiveTemplateSkipReason | null;
  /** Upozornění pro panel/list (např. snížený počet kontraktů). */
  notes: string[];
}

/**
 * Šablona na návrh podle strany a vstupu (`ticketEntry`: u Marketu strana trhu
 * panelu, jinak cena návrhu). Jen předvyplnění — návrh se dál odesílá tlačítkem
 * panelu a worker vše ověří znovu.
 */
export function applyLiveBracketTemplate(
  draft: TicketDraft,
  template: LiveBracketTemplate,
  instrument: TicketInstrument,
  quote: TicketQuote,
  options: LiveTemplateApplyOptions = {},
): LiveTemplateApplyResult {
  if (options.fromPositionBox) return { draft, applied: false, skipped: 'position-box', notes: [] };
  if (options.scaleIn && options.scaleIn.side === draft.side) return { draft, applied: false, skipped: 'scale-in', notes: [] };
  const entry = ticketEntry(draft, quote);
  const d = direction(draft.side);
  const tick = instrument.tickSize;
  // TP v R k ručně nastavenému SL (Přidat jen TP): R = skutečné riziko návrhu.
  const keptStopTicks = options.onlyMissing && draft.stopLoss != null && (entry - draft.stopLoss) * d > 0
    ? Math.max(1, Math.round(((entry - draft.stopLoss) * d) / tick))
    : undefined;
  const prices = liveTemplateBracketPrices(template, draft.side, entry, tick, keptStopTicks);
  if (!prices) return { draft, applied: false, skipped: 'invalid', notes: ['Šablonu teď nejde použít — chybí cena vstupu.'] };

  const next: TicketDraft = { ...draft };
  if (options.onlyMissing) {
    if (next.stopLoss == null) next.stopLoss = prices.stopLoss;
    if (next.takeProfit == null && prices.takeProfit != null) next.takeProfit = prices.takeProfit;
  } else {
    next.stopLoss = prices.stopLoss;
    next.takeProfit = prices.takeProfit;
  }

  const notes: string[] = [];
  const sizing = template.sizing;
  if (sizing && !options.onlyMissing && options.applySizing !== false) {
    if (sizing.mode === 'qty') {
      const cap = options.maxContracts;
      const capped = cap != null && Number.isInteger(cap) && cap >= 1 && sizing.quantity > cap ? cap : sizing.quantity;
      if (capped !== sizing.quantity) notes.push(`Šablona má ${sizing.quantity} ks, účet dovolí ${capped} — vyplněno ${capped}.`);
      next.sizing = 'qty';
      next.quantity = capped;
    } else {
      next.sizing = 'risk';
      next.riskUsd = sizing.riskUsd;
    }
  }
  const changed = next.stopLoss !== draft.stopLoss || next.takeProfit !== draft.takeProfit
    || next.sizing !== draft.sizing || next.quantity !== draft.quantity || next.riskUsd !== draft.riskUsd;
  return { draft: changed ? next : draft, applied: changed, skipped: null, notes };
}

/**
 * Nový návrh (pravý klik, Shift+B/S, „+“ na telefonu) se šablonou místo
 * pevných 12 b / 2R. Přeskočená šablona (přikoupení) nechá výchozí závorky —
 * na ně pak volající nasadí SL/TP pozice jako dnes (`livePhoneScaleInDraft`).
 */
export function liveTemplateTicketDraft(
  side: TicketSide,
  type: TicketOrderType,
  price: number,
  instrument: TicketInstrument,
  quote: TicketQuote,
  template: LiveBracketTemplate,
  base?: Pick<TicketDraft, 'sizing' | 'quantity' | 'riskUsd'>,
  options: Omit<LiveTemplateApplyOptions, 'onlyMissing'> = {},
): LiveTemplateApplyResult {
  const draft = newTicketDraft(side, type, price, instrument, quote, base);
  return applyLiveBracketTemplate(draft, template, instrument, quote, options);
}

// ---------------------------------------------------------------------------
// Uložit jako šablonu

export interface LiveTemplateFromDraftOptions {
  name: string;
  stopUnit?: LiveTemplateStopUnit;
  targetUnit?: LiveTemplateTargetUnit;
  /** Uložit i velikost návrhu (výchozí ano). */
  includeSizing?: boolean;
  id?: string;
  now?: Date;
}

/**
 * „Uložit jako šablonu“: z aktuálního návrhu se vezme jen VZDÁLENOST SL/TP od
 * vstupu v ticích (žádná cena — INV-UI-04) a případně velikost. SL je povinný
 * a obě závorky musí ležet na správné straně vstupu.
 */
export function liveTemplateFromDraft(
  draft: TicketDraft,
  instrument: TicketInstrument,
  quote: TicketQuote,
  options: LiveTemplateFromDraftOptions,
): LiveTemplateCreateResult {
  if (draft.stopLoss == null) return { ok: false, errors: ['Šablona potřebuje stop loss — nejdřív ho v návrhu nastav.'] };
  const tick = instrument.tickSize;
  const entry = ticketEntry(draft, quote);
  const d = direction(draft.side);
  const stopDistance = (entry - draft.stopLoss) * d;
  if (!(stopDistance > 0)) return { ok: false, errors: ['Stop loss je na špatné straně vstupu.'] };
  const stopTicks = Math.max(1, Math.round(stopDistance / tick));
  const stopUnit = options.stopUnit ?? 'ticks';
  const stopLoss: LiveTemplateDistance<LiveTemplateStopUnit> = stopUnit === 'ticks'
    ? { unit: 'ticks', value: stopTicks }
    : { unit: 'pts', value: round(stopTicks * tick, 6) };
  let takeProfit: LiveTemplateDistance<LiveTemplateTargetUnit> | null = null;
  if (draft.takeProfit != null) {
    const targetDistance = (draft.takeProfit - entry) * d;
    if (!(targetDistance > 0)) return { ok: false, errors: ['Take profit je na špatné straně vstupu.'] };
    const targetTicks = Math.max(1, Math.round(targetDistance / tick));
    const unit = options.targetUnit ?? 'ticks';
    takeProfit = unit === 'ticks' ? { unit, value: targetTicks }
      : unit === 'pts' ? { unit, value: round(targetTicks * tick, 6) }
        : { unit, value: round(targetTicks / stopTicks, 2) };
  }
  const sizing: LiveTemplateSizing | null = options.includeSizing === false ? null
    : draft.sizing === 'qty' ? { mode: 'qty', quantity: Math.floor(draft.quantity) }
      : { mode: 'risk', riskUsd: draft.riskUsd };
  return createLiveBracketTemplate({ name: options.name, stopLoss, takeProfit, sizing }, { id: options.id, now: options.now });
}

// ---------------------------------------------------------------------------
// Varování Marketu

const marketTooCloseText = () => (
  `U Marketu musí být SL i TP aspoň ${LIVE_TEMPLATE_MARKET_MIN_BRACKET_TICKS} ticků od ceny — worker by příkaz odmítl.`
);

/** Čip šablony: SL nebo TP pod 16 ticků = Market se SL/TP z ní worker odmítne. */
export function liveTemplateMarketWarning(template: Pick<LiveBracketTemplate, 'stopLoss' | 'takeProfit'>, tickSize: number): string | null {
  if (!(tickSize > 0)) return null;
  const stopTicks = liveTemplateStopTicks(template, tickSize);
  const targetTicks = liveTemplateTargetTicks(template, stopTicks, tickSize);
  const min = LIVE_TEMPLATE_MARKET_MIN_BRACKET_TICKS;
  return stopTicks < min || (targetTicks != null && targetTicks < min) ? marketTooCloseText() : null;
}

/**
 * Návrh Marketu se SL/TP blíž než 16 ticků od ceny, kterou uživatel vidí.
 * Jen varování v panelu — rozhoduje brána workeru (proti jeho kotaci z IBKR).
 * Holý Market (bez SL i TP) pravidlo nemá.
 */
export function liveMarketBracketDistanceProblem(
  draft: TicketDraft,
  instrument: TicketInstrument,
  quote: TicketQuote,
): TicketProblem | null {
  if (draft.type !== 'market' || (draft.stopLoss == null && draft.takeProfit == null)) return null;
  const entry = ticketEntry(draft, quote);
  const min = LIVE_TEMPLATE_MARKET_MIN_BRACKET_TICKS * instrument.tickSize - 1e-9;
  const tooClose = [draft.stopLoss, draft.takeProfit].some(price => price != null && Math.abs(price - entry) < min);
  return tooClose ? { level: 'warning', text: marketTooCloseText() } : null;
}

// ---------------------------------------------------------------------------
// Knihovna (čipy, ★, uložení)

export type LiveTemplateLibraryResult =
  | { ok: true; library: LiveBracketTemplateLibrary }
  | { ok: false; error: string };

/** Šablona podle id včetně vestavěné. */
export function findLiveBracketTemplate(library: LiveBracketTemplateLibrary, id: string | null | undefined): LiveBracketTemplate | null {
  if (id === LIVE_BUILTIN_TEMPLATE_ID) return LIVE_BUILTIN_BRACKET_TEMPLATE;
  return library.templates.find(template => template.id === id) ?? null;
}

/** Výchozí šablona (★) pro nový návrh; bez volby vestavěná 12 b / 2R. */
export function defaultLiveBracketTemplate(library: LiveBracketTemplateLibrary): LiveBracketTemplate {
  return (library.defaultId ? findLiveBracketTemplate(library, library.defaultId) : null) ?? LIVE_BUILTIN_BRACKET_TEMPLATE;
}

/**
 * Uloží šablonu: stejné id = úprava, stejný název = přepis té šablony (id se
 * zachová, ★ zůstane), jinak nová — nejvýš `LIVE_TEMPLATE_MAX_COUNT`.
 */
export function upsertLiveBracketTemplate(library: LiveBracketTemplateLibrary, template: LiveBracketTemplate): LiveTemplateLibraryResult {
  const clean = sanitizeLiveBracketTemplate(template);
  if (!clean) return { ok: false, error: 'Šablona není platná — nic se neuložilo.' };
  const replaceAt = (index: number, saved: LiveBracketTemplate): LiveTemplateLibraryResult => ({
    ok: true,
    library: { templates: library.templates.map((item, i) => (i === index ? saved : item)), defaultId: library.defaultId },
  });
  const byId = library.templates.findIndex(item => item.id === clean.id);
  const byName = library.templates.findIndex(item => item.id !== clean.id && nameKey(item.name) === nameKey(clean.name));
  if (byId >= 0) {
    // Úprava existující šablony nesmí převzít název jiné.
    if (byName >= 0) return { ok: false, error: `Šablona „${library.templates[byName].name}“ už existuje — zvol jiný název.` };
    return replaceAt(byId, clean);
  }
  if (byName >= 0) return replaceAt(byName, { ...clean, id: library.templates[byName].id });
  if (library.templates.length >= LIVE_TEMPLATE_MAX_COUNT) {
    return { ok: false, error: `Šablon může být nejvýš ${LIVE_TEMPLATE_MAX_COUNT} — nejdřív nějakou smaž.` };
  }
  return { ok: true, library: { templates: [...library.templates, clean], defaultId: library.defaultId } };
}

/** Smaže šablonu; byla-li výchozí, výchozí se vrátí na vestavěnou. */
export function removeLiveBracketTemplate(library: LiveBracketTemplateLibrary, id: string): LiveTemplateLibraryResult {
  if (isBuiltinLiveBracketTemplateId(id)) return { ok: false, error: 'Vestavěnou šablonu nejde smazat.' };
  if (!library.templates.some(template => template.id === id)) return { ok: false, error: 'Šablona už neexistuje.' };
  return {
    ok: true,
    library: {
      templates: library.templates.filter(template => template.id !== id),
      defaultId: library.defaultId === id ? null : library.defaultId,
    },
  };
}

/** ★ — výchozí šablona; null nebo vestavěné id = vestavěná 12 b / 2R. */
export function setDefaultLiveBracketTemplate(library: LiveBracketTemplateLibrary, id: string | null): LiveTemplateLibraryResult {
  if (id == null || id === LIVE_BUILTIN_TEMPLATE_ID) return { ok: true, library: { ...library, defaultId: null } };
  if (!library.templates.some(template => template.id === id)) return { ok: false, error: 'Šablona už neexistuje.' };
  return { ok: true, library: { ...library, defaultId: id } };
}

const formatNumber = (value: number) => String(round(value, 2));
const unitLabel = (unit: LiveTemplateStopUnit) => (unit === 'ticks' ? 't' : 'b');

/** Krátký popis vzdáleností: „12/24 t“, „40 t / 2R“, „12 b / bez TP“. */
export function liveTemplateSummary(template: Pick<LiveBracketTemplate, 'stopLoss' | 'takeProfit'>): string {
  const { stopLoss, takeProfit } = template;
  const stop = `${formatNumber(stopLoss.value)} ${unitLabel(stopLoss.unit)}`;
  if (!takeProfit) return `${stop} / bez TP`;
  if (takeProfit.unit === 'r') return `${stop} / ${formatNumber(takeProfit.value)}R`;
  if (takeProfit.unit === stopLoss.unit) return `${formatNumber(stopLoss.value)}/${formatNumber(takeProfit.value)} ${unitLabel(stopLoss.unit)}`;
  return `${stop} / ${formatNumber(takeProfit.value)} ${unitLabel(takeProfit.unit)}`;
}

/** Velikost šablony pro čip: „2 ks“, „200 $“, null = z panelu. */
export function liveTemplateSizingLabel(template: Pick<LiveBracketTemplate, 'sizing'>): string | null {
  const sizing = template.sizing;
  if (!sizing) return null;
  return sizing.mode === 'qty' ? `${sizing.quantity} ks` : `${formatNumber(sizing.riskUsd)} $`;
}

export interface LiveBracketTemplateChoice {
  template: LiveBracketTemplate;
  builtIn: boolean;
  /** ★ */
  isDefault: boolean;
  /** „Scalp 12/24 t“ */
  label: string;
  sizingLabel: string | null;
  /** Text varování u Marketu (SL/TP pod 16 ticků), jinak null. */
  marketWarning: string | null;
}

/** Čipy šablon pro panel/list: vestavěná první, pak uložené v pořadí uložení. */
export function liveBracketTemplateChoices(library: LiveBracketTemplateLibrary, tickSize: number): LiveBracketTemplateChoice[] {
  const current = defaultLiveBracketTemplate(library);
  return [LIVE_BUILTIN_BRACKET_TEMPLATE, ...library.templates].map(template => ({
    template,
    builtIn: template.id === LIVE_BUILTIN_TEMPLATE_ID,
    isDefault: template.id === current.id,
    label: `${template.name} ${liveTemplateSummary(template)}`,
    sizingLabel: liveTemplateSizingLabel(template),
    marketWarning: liveTemplateMarketWarning(template, tickSize),
  }));
}
