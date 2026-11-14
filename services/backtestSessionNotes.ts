import type {
  BacktestClosedTrade,
  BacktestInstrument,
  BacktestOrderEvent,
  BacktestOrderSide,
  BacktestRuntimeState,
} from './backtestTypes';

/**
 * Popisy rozhodnutí v backtest session.
 *
 * Journal objednávek říká, CO se stalo (vstup, posun stopky). Tady je PROČ —
 * a hlavně věci, které journal neumí zachytit vůbec: plán před obchodováním
 * a obchody, které uživatel viděl a nevzal. Bez nich se z backtestu nedá
 * oddělit diskrece od pravidel.
 *
 * Zápisy jsou append-only a nesou dvě časové osy jako journal objednávek:
 * `marketTime` (kde stál replay) a `recordedAt` (kdy uživatel psal). Popis
 * doplněný až po výsledku nese `late` — při rozboru se nesmí míchat s popisem
 * psaným před výsledkem.
 */

export type BacktestNoteSession = 'london' | 'ny';
export type BacktestNoteBias = 'long' | 'short' | 'neutral';
export type BacktestNoteDayType = 'trend' | 'range' | 'unknown';
export type BacktestMoveReason = 'structure' | 'breakeven' | 'fear' | 'news' | 'other';
/** Jediná diskreční část vstupu: jak cena na úroveň reaguje a na kterou. */
export type BacktestEntryReaction = 'breakout' | 'bounce';
export const BACKTEST_ENTRY_LEVELS = ['VWAP', '+1σ', '−1σ', '+2σ', '−2σ'] as const;
export type BacktestEntryLevel = typeof BACKTEST_ENTRY_LEVELS[number];

interface BacktestNoteBase {
  id: string;
  /** Čas replay kurzoru (unix sekundy), ke kterému se zápis váže. */
  marketTime: number;
  /** Reálný čas zápisu (unix ms). */
  recordedAt: number;
  /** Doplněno zpětně — ne v okamžiku rozhodnutí. */
  late?: boolean;
}

/** Plán jedné obchodní session (Londýn / New York) v jednom dni. */
export interface BacktestPlanNote extends BacktestNoteBase {
  kind: 'plan';
  /** Kalendářní den v newyorském čase (YYYY-MM-DD). */
  day: string;
  session: BacktestNoteSession;
  bias: BacktestNoteBias;
  dayType: BacktestNoteDayType;
  expectation: string;
  invalidation: string;
  /** Vyplněno jen u změny už existujícího plánu. */
  previousBias?: BacktestNoteBias;
  changeReason?: string;
}

export interface BacktestEntryNote extends BacktestNoteBase {
  kind: 'entry';
  orderId: string;
  side: BacktestOrderSide;
  price?: number;
  reaction?: BacktestEntryReaction;
  level?: BacktestEntryLevel;
  text: string;
}

export interface BacktestMoveNote extends BacktestNoteBase {
  kind: 'move';
  /** Událost journalu objednávek, kterou popis vysvětluje. */
  eventId: string;
  orderId: string;
  field: 'stop' | 'target';
  from?: number;
  to?: number;
  reason?: BacktestMoveReason;
  text: string;
}

/**
 * Kam by nevzatý obchod došel s původním SL do konce dne. Počítá se jen
 * z odkrytých svíček; `horizonTime` říká, po kterou svíčku.
 */
export interface BacktestSkipOutcome {
  horizonTime: number;
  /** Hotovo = zasažen SL nebo konec obchodního dne. */
  complete: boolean;
  result: 'tp' | 'sl' | 'cutoff' | 'open';
  /** Nejdál ve prospěch před SL / koncem dne, v R. */
  mfeR: number | null;
  tpR: number | null;
  /** Nejvzdálenější dosažená pojmenovaná úroveň. */
  top: { label: string; r: number } | null;
}

interface StructureSnapshot { dir: 'bull' | 'bear'; type: 'BoS' | 'CHoCH'; ageMin: number; run: number }

/**
 * Stav trhu v okamžiku nevzatého obchodu — stejná mechanická čtení, jaká se
 * ukládají u vzatých obchodů, aby šly obě skupiny porovnat.
 */
export interface BacktestSkipContext {
  available: boolean;
  /** Poslední zlom struktury na 1m, 5m, 15m a 1h. */
  s1?: StructureSnapshot | null;
  s5?: StructureSnapshot | null;
  s15?: StructureSnapshot | null;
  s60?: StructureSnapshot | null;
  /** Cena uvnitř FVG na 5m / 15m / 1h. */
  inFvg5?: boolean;
  inFvg15?: boolean;
  inFvg60?: boolean;
  vwapDistSigma?: number | null;
  /** CHoCH = první zlom mým směrem, BoS = další; `structureOrder` říká kolikátý. */
  structureType?: 'CHoCH' | 'BoS' | null;
  structureOrder?: number;
  structureBarsAgo?: number | null;
  /** Úrovně, od kterých se pohyb otočil. */
  reactionLevels?: string[];
  /** Vstup na hraně platného 1m FVG. */
  entryFvg?: boolean;
}

/** Obchod, který uživatel viděl a nevzal. */
export interface BacktestSkipNote extends BacktestNoteBase {
  kind: 'skip';
  side: BacktestOrderSide;
  price: number;
  stopLoss?: number;
  takeProfit?: number;
  reasons: string[];
  text: string;
  outcome?: BacktestSkipOutcome;
  context?: BacktestSkipContext;
}

export type BacktestNote = BacktestPlanNote | BacktestEntryNote | BacktestMoveNote | BacktestSkipNote;

export const BACKTEST_ENTRY_REACTION_LABELS: Record<BacktestEntryReaction, string> = { breakout: 'Průraz', bounce: 'Odraz' };
export const BACKTEST_SKIP_REASONS = ['Choppy', 'Proti biasu', 'Malý poměr', 'Pozdě', 'Není čistý spouštěč', 'Nevím'] as const;
export const BACKTEST_MOVE_REASON_LABELS: Record<BacktestMoveReason, string> = {
  structure: 'Struktura',
  breakeven: 'Break-even',
  fear: 'Strach / nejistota',
  news: 'Zprávy',
  other: 'Jiné',
};
export const BACKTEST_SESSION_LABELS: Record<BacktestNoteSession, string> = { london: 'Londýn', ny: 'New York' };
export const BACKTEST_SESSION_SHORT: Record<BacktestNoteSession, string> = { london: 'LON', ny: 'NY' };
export const BACKTEST_BIAS_LABELS: Record<BacktestNoteBias, string> = { long: 'Long', short: 'Short', neutral: 'Neutrál' };
export const BACKTEST_DAY_TYPE_LABELS: Record<BacktestNoteDayType, string> = { trend: 'Trend', range: 'Range', unknown: 'Nevím' };

const NY_TIME_ZONE = 'America/New_York';
/** Před 8:00 NY (14:00 Praha) jde o londýnskou session, potom o newyorskou. */
const NY_SESSION_START_HOUR = 8;

const nyParts = new Intl.DateTimeFormat('en-CA', {
  timeZone: NY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

export const backtestNoteSessionAt = (marketTime: number): { day: string; session: BacktestNoteSession } => {
  const parts = nyParts.formatToParts(new Date(marketTime * 1_000));
  const value = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return {
    day: `${value('year')}-${value('month')}-${value('day')}`,
    session: Number(value('hour')) < NY_SESSION_START_HOUR ? 'london' : 'ny',
  };
};

export const createBacktestNoteId = (): string => `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const MOVE_FIELDS: Partial<Record<BacktestOrderEvent['kind'], 'stop' | 'target'>> = {
  'stop-moved': 'stop',
  'position-stop-moved': 'stop',
  'target-moved': 'target',
  'position-target-moved': 'target',
};

export const backtestMoveField = (event: BacktestOrderEvent): 'stop' | 'target' | null => MOVE_FIELDS[event.kind] ?? null;

/** Skutečný posun čáry uživatelem — první nasazení SL/TP (bez předchozí ceny) posun není. */
const isUserMove = (event: BacktestOrderEvent): boolean => backtestMoveField(event) !== null
  && event.recordedAt !== undefined
  && Number.isFinite(event.previousPrice as number)
  && Number.isFinite(event.price as number)
  && event.price !== event.previousPrice;

/** Poslední platný plán dané session; pozdější zápis přebíjí dřívější. */
export const backtestSessionPlan = (
  notes: readonly BacktestNote[] | undefined,
  day: string,
  session: BacktestNoteSession,
): BacktestPlanNote | null => {
  let found: BacktestPlanNote | null = null;
  notes?.forEach(note => {
    if (note.kind === 'plan' && note.day === day && note.session === session) found = note;
  });
  return found;
};

export const backtestEntryNote = (notes: readonly BacktestNote[] | undefined, orderId: string): BacktestEntryNote | null => {
  let found: BacktestEntryNote | null = null;
  notes?.forEach(note => { if (note.kind === 'entry' && note.orderId === orderId) found = note; });
  return found;
};

export const backtestMoveNote = (notes: readonly BacktestNote[] | undefined, eventId: string): BacktestMoveNote | null => {
  let found: BacktestMoveNote | null = null;
  notes?.forEach(note => { if (note.kind === 'move' && note.eventId === eventId) found = note; });
  return found;
};

/** Přidá zápis; popis téhož vstupu / posunu nahradí předchozí (oprava překlepu). */
export const addBacktestNote = (runtime: BacktestRuntimeState, note: BacktestNote): BacktestRuntimeState => {
  const same = (candidate: BacktestNote) => candidate.id === note.id
    || (note.kind === 'entry' && candidate.kind === 'entry' && candidate.orderId === note.orderId)
    || (note.kind === 'move' && candidate.kind === 'move' && candidate.eventId === note.eventId);
  return { ...runtime, notes: [...(runtime.notes ?? []).filter(candidate => !same(candidate)), note] };
};

export const removeBacktestNote = (runtime: BacktestRuntimeState, id: string): BacktestRuntimeState => (
  { ...runtime, notes: (runtime.notes ?? []).filter(note => note.id !== id) }
);

/**
 * Návrat replaye: zápisy za cílovým časem zmizí spolu s obchody, které už
 * v novém čase neproběhly. Popisy vstupů a posunů zrušených příkazů také.
 */
export const trimBacktestNotes = (
  notes: readonly BacktestNote[] | undefined,
  targetTime: number,
  keptOrderIds: ReadonlySet<string>,
): BacktestNote[] | undefined => notes?.filter(note => {
  if (note.marketTime > targetTime) return false;
  if (note.kind === 'entry' || note.kind === 'move') return keptOrderIds.has(note.orderId);
  return true;
}).map(note => {
  // Dopočet nevzatého obchodu ze svíček za cílem by prozradil budoucnost.
  if (note.kind !== 'skip' || !note.outcome || note.outcome.horizonTime <= targetTime) return note;
  const { outcome: _future, ...rest } = note;
  return rest;
});

export const backtestEntryNoteLabel = (note: Pick<BacktestEntryNote, 'reaction' | 'level'>): string => (
  [note.reaction ? BACKTEST_ENTRY_REACTION_LABELS[note.reaction] : '', note.level ?? ''].filter(Boolean).join(' ')
);

const skipHasRisk = (note: BacktestSkipNote): boolean => Number.isFinite(note.stopLoss as number) && note.stopLoss !== note.price;

/** Nevzaté obchody, kterým chybí kontext vstupu nebo hotový dopočet dosahu. */
export const pendingBacktestSkips = (notes: readonly BacktestNote[] | undefined): BacktestSkipNote[] => (notes ?? [])
  .filter((note): note is BacktestSkipNote => note.kind === 'skip'
    && (note.context === undefined || (skipHasRisk(note) && !note.outcome?.complete)));

/** Výběr mechanických čtení z namapovaného obchodu (entryContext + entryMap). */
export const backtestSkipContextFromTrade = (trade: { entryContext?: unknown; entryMap?: unknown }): BacktestSkipContext => {
  const context = trade.entryContext as {
    available?: boolean; vwapDistSigma?: number | null;
    ctx?: { s1?: StructureSnapshot | null; s5?: StructureSnapshot | null; s15?: StructureSnapshot | null; s60?: StructureSnapshot | null } | null;
    htfFvg?: { inside5?: unknown; inside15?: unknown; inside60?: unknown } | null;
  } | undefined;
  const map = trade.entryMap as {
    available?: boolean; structureType?: 'CHoCH' | 'BoS' | null; structureOrder?: number; structureBarsAgo?: number | null;
    odrazLevels?: string[]; entryFvgValid?: boolean;
  } | undefined;
  if (!context?.available && !map?.available) return { available: false };
  return {
    available: true,
    s1: context?.ctx?.s1 ?? null, s5: context?.ctx?.s5 ?? null, s15: context?.ctx?.s15 ?? null, s60: context?.ctx?.s60 ?? null,
    inFvg5: Boolean(context?.htfFvg?.inside5), inFvg15: Boolean(context?.htfFvg?.inside15), inFvg60: Boolean(context?.htfFvg?.inside60),
    vwapDistSigma: context?.vwapDistSigma ?? null,
    structureType: map?.structureType ?? null, structureOrder: map?.structureOrder, structureBarsAgo: map?.structureBarsAgo ?? null,
    reactionLevels: map?.odrazLevels ?? [], entryFvg: Boolean(map?.entryFvgValid),
  };
};

/**
 * Nevzatý obchod ve tvaru uzavřeného obchodu — stejná analytika pak spočítá,
 * kam by došel. Vstup i výstup jsou v okamžiku rozhodnutí, P&L nulové.
 */
export const backtestSkipAsClosedTrade = (note: BacktestSkipNote, runId: string, instrument: BacktestInstrument): BacktestClosedTrade => ({
  id: `skip:${note.id}`, runId, instrument, direction: note.side === 'buy' ? 'Long' : 'Short', quantity: 1,
  entryPrice: note.price, exitPrice: note.price, entryTime: note.marketTime, exitTime: note.marketTime,
  grossPnl: 0, commission: 0, pnl: 0, reason: 'manual',
  stopLoss: note.stopLoss, takeProfit: note.takeProfit, initialStopLoss: note.stopLoss, initialTakeProfit: note.takeProfit,
});

interface ExcursionLike {
  available?: boolean; complete?: boolean; stopReason?: 'cutoff' | 'sl' | 'end';
  mfePotentialR?: number | null; tpR?: number; topReached?: { label: string; r: number } | null;
}

/** Shrnutí dosahu z analytiky „kam by to došlo do konce dne“. */
export const backtestReachFromExcursion = (excursion: unknown, horizonTime: number): BacktestSkipOutcome | null => {
  const data = excursion as ExcursionLike | null | undefined;
  if (!data || data.available !== true) return null;
  const mfeR = Number.isFinite(data.mfePotentialR as number) ? Number(data.mfePotentialR) : null;
  const tpR = data.tpR && data.tpR > 0 ? data.tpR : null;
  const complete = data.complete === true;
  // Dosah se měří jen do zásahu původního SL, takže cíl uvnitř dosahu padl dřív než SL.
  const result = tpR !== null && mfeR !== null && mfeR >= tpR ? 'tp'
    : data.stopReason === 'sl' ? 'sl' : data.stopReason === 'cutoff' ? 'cutoff' : 'open';
  return { horizonTime, complete, result, mfeR, tpR, top: data.topReached ?? null };
};

/** Posuny SL/TP provedené uživatelem, ke kterým chybí důvod. */
export const unexplainedBacktestMoves = (
  events: readonly BacktestOrderEvent[] | undefined,
  notes: readonly BacktestNote[] | undefined,
): BacktestOrderEvent[] => {
  const explained = new Set<string>();
  notes?.forEach(note => { if (note.kind === 'move') explained.add(note.eventId); });
  return (events ?? []).filter(event => isUserMove(event) && !explained.has(event.id));
};

/** Id příkazů, kterými se do uzavřeného obchodu vstupovalo. */
export const backtestTradeEntryOrderIds = (runtime: BacktestRuntimeState, trade: BacktestClosedTrade): string[] => {
  if (!trade.positionId) return [];
  const ids = runtime.fills
    .filter(fill => fill.positionId === trade.positionId && fill.orderId)
    .map(fill => String(fill.orderId));
  return [...new Set(ids)];
};

/**
 * Co z popisů patří do deníkového obchodu: text vstupu jako poznámka a bias
 * session platný v okamžiku vstupu. Zpětně doplněný text se označí.
 */
export const backtestTradeNoteFields = (
  runtime: BacktestRuntimeState,
  trade: BacktestClosedTrade,
): { notes?: string; sessionBias?: 'Long' | 'Short' | 'Neutral' } => {
  const notes = runtime.notes ?? [];
  const texts = backtestTradeEntryOrderIds(runtime, trade)
    .map(orderId => backtestEntryNote(notes, orderId))
    .filter((note): note is BacktestEntryNote => note !== null)
    .map(note => {
      const body = [backtestEntryNoteLabel(note), note.text.trim()].filter(Boolean).join(' — ');
      return note.late && body ? `${body} (doplněno zpětně)` : body;
    })
    .filter(Boolean);
  const { day, session } = backtestNoteSessionAt(trade.entryTime);
  let plan: BacktestPlanNote | null = null;
  notes.forEach(note => {
    if (note.kind === 'plan' && note.day === day && note.session === session && note.marketTime <= trade.entryTime) plan = note;
  });
  const bias = (plan as BacktestPlanNote | null)?.bias;
  return {
    notes: texts.length ? texts.join('\n') : undefined,
    sessionBias: bias === 'long' ? 'Long' : bias === 'short' ? 'Short' : bias === 'neutral' ? 'Neutral' : undefined,
  };
};

export type BacktestJournalRow =
  | { type: 'header'; key: string; time: number; day: string; session: BacktestNoteSession; hasPlan: boolean }
  | { type: 'plan'; key: string; time: number; note: BacktestPlanNote }
  | { type: 'skip'; key: string; time: number; note: BacktestSkipNote }
  | { type: 'entry'; key: string; time: number; orderId: string; side: BacktestOrderSide; quantity: number; price?: number;
      orderType: string; status: string; note: BacktestEntryNote | null }
  | { type: 'move'; key: string; time: number; event: BacktestOrderEvent; field: 'stop' | 'target'; note: BacktestMoveNote | null }
  | { type: 'exit'; key: string; time: number; trade: BacktestClosedTrade };

const ROW_ORDER: Record<BacktestJournalRow['type'], number> = { header: 0, plan: 1, skip: 2, entry: 3, move: 4, exit: 5 };

/**
 * Jeden časový sloupec: plány, nevzaté obchody, vstupy, posuny a výstupy,
 * rozdělené hlavičkami podle dne a session. Řádky bez popisu zůstávají
 * (`note: null`), aby bylo vidět, co chybí.
 */
export const buildBacktestJournal = (runtime: BacktestRuntimeState): BacktestJournalRow[] => {
  const notes = runtime.notes ?? [];
  const rows: BacktestJournalRow[] = [];
  notes.forEach(note => {
    if (note.kind === 'plan') rows.push({ type: 'plan', key: note.id, time: note.marketTime, note });
    if (note.kind === 'skip') rows.push({ type: 'skip', key: note.id, time: note.marketTime, note });
  });
  runtime.orders.forEach(order => {
    if (order.reduceOnly || order.status === 'rejected') return;
    rows.push({
      type: 'entry', key: `entry:${order.id}`, time: order.createdAt, orderId: order.id, side: order.side,
      quantity: order.quantity, price: order.limitPrice ?? order.stopPrice
        ?? runtime.fills.find(fill => fill.orderId === order.id)?.price,
      orderType: order.type, status: order.status, note: backtestEntryNote(notes, order.id),
    });
  });
  (runtime.orderEvents ?? []).forEach(event => {
    const field = backtestMoveField(event);
    if (!field || !isUserMove(event)) return;
    rows.push({ type: 'move', key: `move:${event.id}`, time: event.marketTime, event, field, note: backtestMoveNote(notes, event.id) });
  });
  runtime.closedTrades.forEach(trade => rows.push({ type: 'exit', key: `exit:${trade.id}`, time: trade.exitTime, trade }));
  rows.sort((left, right) => left.time - right.time || ROW_ORDER[left.type] - ROW_ORDER[right.type]);

  const result: BacktestJournalRow[] = [];
  let currentKey = '';
  rows.forEach(row => {
    const scope = row.type === 'plan' ? { day: row.note.day, session: row.note.session } : backtestNoteSessionAt(row.time);
    const key = `${scope.day}:${scope.session}`;
    if (key !== currentKey) {
      currentKey = key;
      result.push({
        type: 'header', key: `header:${key}:${row.time}`, time: row.time, day: scope.day, session: scope.session,
        hasPlan: backtestSessionPlan(notes, scope.day, scope.session) !== null,
      });
    }
    result.push(row);
  });
  return result;
};

export interface BacktestNotesSummary {
  plans: number;
  skips: number;
  entries: number;
  entriesDescribed: number;
  moves: number;
  movesExplained: number;
}

export const summarizeBacktestNotes = (runtime: BacktestRuntimeState): BacktestNotesSummary => {
  const rows = buildBacktestJournal(runtime);
  const entries = rows.filter(row => row.type === 'entry');
  const moves = rows.filter(row => row.type === 'move');
  return {
    plans: rows.filter(row => row.type === 'plan').length,
    skips: rows.filter(row => row.type === 'skip').length,
    entries: entries.length,
    entriesDescribed: entries.filter(row => row.type === 'entry' && row.note !== null).length,
    moves: moves.length,
    movesExplained: moves.filter(row => row.type === 'move' && row.note !== null).length,
  };
};
