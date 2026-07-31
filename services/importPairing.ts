// Párování importovaných exekucí (Tradecopia) na obchody v deníku.
//
// Zdroje se liší v přesnosti, takže párování musí překlenout tři rozdíly:
//   1. Symbol — import má kontraktní měsíc (MNQU6), deník kořen (MNQ).
//   2. Čas — deník ukládá entryTime zaokrouhlený na minutu, import má sekundy.
//   3. Směr — deníkové záznamy mají direction často null, takže se NESMÍ použít
//      jako povinný klíč; slouží jen jako bonus při skórování.
//
// Hlavní klíč je proto VSTUPNÍ CENA: je přesná na tick a rozliší i dva obchody
// otevřené ve stejné minutě (reálný případ — re-entry hned po vykopnutí na SL).
// Když cena nerozhodne, párování raději vrátí `ambiguous` a nechá rozhodnout
// uživatele, než aby tiše přiřadilo špatný obchod.

export interface ImportedExecution {
  id: string;
  account_ext_id: number;
  account_name?: string | null;
  symbol: string;
  direction: 'Long' | 'Short' | null;
  buy_price: number;
  sell_price: number;
  qty: number;
  pnl: number;
  entry_at: string;
  exit_at: string;
  status: string;
  /** Sdílený klíč fan-out kopií — stejný obchod zkopírovaný na N účtů. */
  group_key?: string | null;
}

/** Fan-out skupina: jeden obchod, N kopií napříč účty. */
export interface ExecutionGroup {
  key: string;
  executions: ImportedExecution[];
  accountCount: number;
  totalPnl: number;
  /** Reprezentant skupiny (první kopie) — nese symbol, směr, časy. */
  sample: ImportedExecution;
}

/**
 * Klíč fan-out skupiny. Záměrně BEZ množství: kopie téhož obchodu mají různou
 * velikost podle copyMultiplier účtu (2× na jednom, 4× na druhém), takže qty
 * v klíči by jeden obchod rozpadlo na několik "skupin".
 * Počítá se z dat, ne z uloženého group_key, aby fungoval i nad staršími řádky.
 */
export function fanoutKey(e: ImportedExecution): string {
  return e.group_key || [e.symbol, e.entry_at, e.exit_at, e.buy_price, e.sell_price].join('|');
}

/** Kopírka může mít mezi účty několik sekund latence a jeden tick slippage. */
export const FANOUT_TIME_TOLERANCE_MS = 5_000;
export const FANOUT_PRICE_TOLERANCE = 0.51;

export function isSameFanout(a: ImportedExecution, b: ImportedExecution): boolean {
  if (normalizeSymbol(a.symbol) !== normalizeSymbol(b.symbol)) return false;
  if (a.direction !== b.direction) return false;
  if (Math.abs(new Date(a.entry_at).getTime() - new Date(b.entry_at).getTime()) > FANOUT_TIME_TOLERANCE_MS) return false;
  if (Math.abs(new Date(a.exit_at).getTime() - new Date(b.exit_at).getTime()) > FANOUT_TIME_TOLERANCE_MS) return false;
  if (Math.abs(executionEntryPrice(a) - executionEntryPrice(b)) > FANOUT_PRICE_TOLERANCE) return false;
  if (Math.abs(executionExitPrice(a) - executionExitPrice(b)) > FANOUT_PRICE_TOLERANCE) return false;
  return true;
}

/**
 * Seskupí kopie jednoho obchodu. Bez toho fronta ukazuje 96 řádků tam, kde
 * jde o 21 obchodů — a rozhodovat by se muselo o každé kopii zvlášť.
 */
export function groupExecutions(executions: ImportedExecution[]): ExecutionGroup[] {
  const groups: ImportedExecution[][] = [];
  const sorted = [...executions].sort((a, b) =>
    new Date(a.entry_at).getTime() - new Date(b.entry_at).getTime());
  for (const execution of sorted) {
    const group = groups.find(list =>
      // Jeden účet může mít rychlý re-entry se skoro stejnými cenami. Ten nikdy
      // nesmí skončit ve stejné fan-out skupině jako předchozí vlastní exekuce.
      !list.some(item => item.account_ext_id === execution.account_ext_id)
      && isSameFanout(list[0], execution));
    if (group) group.push(execution);
    else groups.push([execution]);
  }
  return groups
    .map(list => ({
      key: `${fanoutKey(list[0])}:${list[0].id}`,
      executions: list,
      accountCount: new Set(list.map(e => e.account_ext_id)).size,
      totalPnl: list.reduce((s, e) => s + (Number(e.pnl) || 0), 0),
      sample: list[0],
    }))
    .sort((a, b) => new Date(b.sample.entry_at).getTime() - new Date(a.sample.entry_at).getTime());
}

export interface JournalTrade {
  id: string | number;
  accountId: string;
  date?: string;
  instrument?: string;
  entryPrice?: number;
  exitPrice?: number;
  entryTime?: number;
  timestamp: number;
  direction?: 'Long' | 'Short';
  groupId?: string;
  pnl: number;
  executionStatus?: 'Valid' | 'Invalid' | 'Missed';
  isValid?: boolean;
}

export interface ManualLinkOption {
  key: string;
  trades: JournalTrade[];
  pairs: Array<{ execution: ImportedExecution; trade: JournalTrade }>;
  coverage: number;
  totalExecutions: number;
  representative: JournalTrade;
}

const manualTradeGroupKey = (trade: JournalTrade): string => {
  if (trade.groupId) return `group:${trade.groupId}`;
  const time = trade.entryTime || trade.timestamp;
  return `legacy:${normalizeSymbol(trade.instrument)}:${time}:${trade.direction || ''}`;
};

/**
 * Sestaví ruční 1:1 volby na úrovni celého fan-out obchodu. Jeden klik tak
 * propojí kopie na odpovídající účty, nikdy ale nepoužije stejný deníkový
 * obchod pro dvě exekuce.
 */
export function buildManualLinkOptions(
  group: ExecutionGroup,
  accountMap: Map<number, string>,
  tradesByAccount: Map<string, JournalTrade[]>,
): ManualLinkOption[] {
  const buckets = new Map<string, Map<string, JournalTrade>>();
  const sampleMs = new Date(group.sample.entry_at).getTime();

  for (const execution of group.executions) {
    const accountId = accountMap.get(execution.account_ext_id);
    if (!accountId) continue;
    for (const trade of tradesByAccount.get(accountId) || []) {
      const key = manualTradeGroupKey(trade);
      const byAccount = buckets.get(key) || new Map<string, JournalTrade>();
      const current = byAccount.get(accountId);
      const tradeMs = trade.entryTime || trade.timestamp;
      const currentMs = current ? (current.entryTime || current.timestamp) : 0;
      if (!current || Math.abs(tradeMs - sampleMs) < Math.abs(currentMs - sampleMs)) {
        byAccount.set(accountId, trade);
      }
      buckets.set(key, byAccount);
    }
  }

  return [...buckets.entries()]
    .map(([key, byAccount]) => {
      const pairs = group.executions.flatMap(execution => {
        const accountId = accountMap.get(execution.account_ext_id);
        const trade = accountId ? byAccount.get(accountId) : undefined;
        return trade ? [{ execution, trade }] : [];
      });
      const trades = [...new Map(pairs.map(pair => [String(pair.trade.id), pair.trade])).values()];
      return {
        key,
        trades,
        pairs,
        coverage: pairs.length,
        totalExecutions: group.executions.length,
        representative: trades[0],
      };
    })
    .filter(option => option.coverage > 0)
    .sort((a, b) => {
      if (b.coverage !== a.coverage) return b.coverage - a.coverage;
      const aTime = a.representative.entryTime || a.representative.timestamp;
      const bTime = b.representative.entryTime || b.representative.timestamp;
      const aSymbol = normalizeSymbol(a.representative.instrument) === normalizeSymbol(group.sample.symbol) ? 1 : 0;
      const bSymbol = normalizeSymbol(b.representative.instrument) === normalizeSymbol(group.sample.symbol) ? 1 : 0;
      if (bSymbol !== aSymbol) return bSymbol - aSymbol;
      return Math.abs(aTime - sampleMs) - Math.abs(bTime - sampleMs);
    });
}

export type PairOutcome =
  | { kind: 'matched'; execution: ImportedExecution; trade: JournalTrade; score: number }
  | { kind: 'ambiguous'; execution: ImportedExecution; candidates: JournalTrade[] }
  | { kind: 'unmatched'; execution: ImportedExecution };

/** Tolerance vstupní ceny — jeden tick MNQ/NQ je 0.25, necháme půltick rezervu. */
export const PRICE_TOLERANCE = 0.13;
/** Deník má minutovou přesnost, exekuce sekundovou → okno musí být štědré. */
export const TIME_WINDOW_MS = 5 * 60 * 1000;

/**
 * "MNQU6" → "MNQ", "NQZ5" → "NQ". Odstraní kontraktní měsíc+rok, který deník nemá.
 * Kořen bereme jako úvodní písmena; zbytek (měsíční kód + rok) zahodíme.
 */
export function normalizeSymbol(symbol?: string | null): string {
  if (!symbol) return '';
  const upper = String(symbol).toUpperCase().trim();
  const match = upper.match(/^([A-Z]+?)([FGHJKMNQUVXZ]\d{1,2})$/);
  return (match ? match[1] : upper).replace(/[^A-Z]/g, '');
}

/** Vstupní cena exekuce — u shortu se vstupuje prodejem. */
export function executionEntryPrice(exec: ImportedExecution): number {
  return exec.direction === 'Short' ? exec.sell_price : exec.buy_price;
}

export function executionExitPrice(exec: ImportedExecution): number {
  return exec.direction === 'Short' ? exec.buy_price : exec.sell_price;
}

/** Čas vstupu deníkového obchodu; entryTime je nepovinný, fallback na timestamp. */
function tradeEntryMs(trade: JournalTrade): number {
  return trade.entryTime || trade.timestamp;
}

/**
 * Skóre shody, nebo null když kandidát nevyhovuje tvrdým podmínkám
 * (účet, symbol, cena, časové okno). Vyšší skóre = jistější shoda.
 */
export function scoreCandidate(exec: ImportedExecution, trade: JournalTrade): number | null {
  if (normalizeSymbol(exec.symbol) !== normalizeSymbol(trade.instrument)) return null;

  const execEntry = executionEntryPrice(exec);
  if (typeof trade.entryPrice !== 'number') return null;
  const priceDelta = Math.abs(trade.entryPrice - execEntry);
  if (priceDelta > PRICE_TOLERANCE) return null;

  const timeDelta = Math.abs(tradeEntryMs(trade) - new Date(exec.entry_at).getTime());
  if (timeDelta > TIME_WINDOW_MS) return null;

  // Základ: čím přesnější cena a čas, tím vyšší skóre.
  let score = 100 - (priceDelta / PRICE_TOLERANCE) * 20 - (timeDelta / TIME_WINDOW_MS) * 30;

  // Bonusy za shodu dalších polí. Direction i exitPrice bývají v deníku prázdné,
  // proto jen přidávají jistotu, nikdy nediskvalifikují.
  if (trade.direction && exec.direction && trade.direction === exec.direction) score += 15;
  if (typeof trade.exitPrice === 'number'
      && Math.abs(trade.exitPrice - executionExitPrice(exec)) <= PRICE_TOLERANCE) score += 25;

  return score;
}

/** Rozdíl skóre, pod kterým považujeme dva kandidáty za nerozlišitelné. */
export const AMBIGUITY_MARGIN = 10;

/**
 * Spáruje jednu exekuci proti obchodům v deníku. `trades` musí být předfiltrované
 * na účet odpovídající exekuci (mapování ext účtu → účet v appce dělá volající).
 * Obchody, které už jsou spárované s jinou exekucí, předej v `takenTradeIds`.
 */
export function pairExecution(
  exec: ImportedExecution,
  trades: JournalTrade[],
  takenTradeIds: Set<string> = new Set(),
): PairOutcome {
  const scored = trades
    .filter(t => !takenTradeIds.has(String(t.id)))
    .map(t => ({ trade: t, score: scoreCandidate(exec, t) }))
    .filter((c): c is { trade: JournalTrade; score: number } => c.score !== null)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { kind: 'unmatched', execution: exec };
  if (scored.length === 1) return { kind: 'matched', execution: exec, trade: scored[0].trade, score: scored[0].score };

  // Víc kandidátů: přijmi jen když je nejlepší znatelně lepší než druhý.
  const [best, second] = scored;
  if (best.score - second.score >= AMBIGUITY_MARGIN) {
    return { kind: 'matched', execution: exec, trade: best.trade, score: best.score };
  }
  return {
    kind: 'ambiguous',
    execution: exec,
    candidates: scored.map(s => s.trade),
  };
}

export interface PairingInput {
  executions: ImportedExecution[];
  /** Obchody v deníku, klíčované accountId → obchody na tom účtu. */
  tradesByAccount: Map<string, JournalTrade[]>;
  /** Mapa externí účet → účet v appce. Exekuce bez mapování se přeskočí. */
  accountMap: Map<number, string>;
  /** Cutoff per účet v appce (YYYY-MM-DD): starší exekuce se ignorují. */
  cutoffByAccount?: Map<string, string>;
}

export interface PairingResult {
  matched: Array<{ execution: ImportedExecution; trade: JournalTrade; score: number }>;
  ambiguous: Array<{ execution: ImportedExecution; candidates: JournalTrade[] }>;
  unmatched: ImportedExecution[];
  /** Přeskočené kvůli cutoffu nebo chybějícímu mapování účtu. */
  skipped: Array<{ execution: ImportedExecution; reason: 'no-account-map' | 'before-cutoff' }>;
}

/**
 * Spáruje dávku exekucí. Zpracovává se od nejjistějších shod, aby silný pár
 * "nesebral" obchod slabšímu — proto dvě fáze: nejdřív skóre všech kombinací,
 * pak přiřazení od nejlepší.
 */
export function pairExecutions(input: PairingInput): PairingResult {
  const result: PairingResult = { matched: [], ambiguous: [], unmatched: [], skipped: [] };

  const relevant: Array<{ exec: ImportedExecution; accountId: string }> = [];
  for (const exec of input.executions) {
    const accountId = input.accountMap.get(exec.account_ext_id);
    if (!accountId) {
      result.skipped.push({ execution: exec, reason: 'no-account-map' });
      continue;
    }
    const cutoff = input.cutoffByAccount?.get(accountId);
    if (cutoff && exec.entry_at.slice(0, 10) < cutoff) {
      result.skipped.push({ execution: exec, reason: 'before-cutoff' });
      continue;
    }
    relevant.push({ exec, accountId });
  }

  // Fáze 1 — ohodnoť všechny přípustné dvojice.
  type Pair = { exec: ImportedExecution; trade: JournalTrade; score: number };
  const pairs: Pair[] = [];
  for (const { exec, accountId } of relevant) {
    for (const trade of input.tradesByAccount.get(accountId) || []) {
      const score = scoreCandidate(exec, trade);
      if (score !== null) pairs.push({ exec, trade, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score);

  // Fáze 2 — iterativní one-to-one matching. Nejdřív se vezmou jednoznačné
  // exekuce; jejich rezervace může odstranit soupeře a bezpečně vyřešit další.
  // Kandidát z `ambiguous` proto nikdy zároveň neskončí v automatickém matchi.
  const takenTrades = new Set<string>();
  const resolvedExecs = new Set<string>();
  const relevantById = new Map(relevant.map(item => [item.exec.id, item.exec]));
  const candidatesFor = (execId: string) => pairs.filter(pair =>
    pair.exec.id === execId && !takenTrades.has(String(pair.trade.id)));

  let progress = true;
  while (progress) {
    progress = false;
    const proposals = [...relevantById.keys()]
      .filter(id => !resolvedExecs.has(id))
      .map(id => ({ id, candidates: candidatesFor(id) }))
      .filter(item => item.candidates.length > 0)
      .filter(item => item.candidates.length === 1
        || item.candidates[0].score - item.candidates[1].score >= AMBIGUITY_MARGIN)
      .sort((a, b) => b.candidates[0].score - a.candidates[0].score);

    for (const proposal of proposals) {
      if (resolvedExecs.has(proposal.id)) continue;
      const available = candidatesFor(proposal.id);
      if (available.length === 0) continue;
      if (available.length > 1 && available[0].score - available[1].score < AMBIGUITY_MARGIN) continue;
      const best = available[0];
      result.matched.push({ execution: best.exec, trade: best.trade, score: best.score });
      resolvedExecs.add(proposal.id);
      takenTrades.add(String(best.trade.id));
      progress = true;
    }
  }

  for (const { exec } of relevant) {
    if (resolvedExecs.has(exec.id)) continue;
    const available = candidatesFor(exec.id);
    if (available.length === 0) result.unmatched.push(exec);
    else result.ambiguous.push({ execution: exec, candidates: available.map(pair => pair.trade) });
  }
  return result;
}

/**
 * Podklad k rozhodnutí u nespárovaných exekucí — fakta, ne hodnocení.
 * `gapSeconds` = odstup od předchozí exekuce na stejném účtu; klesající odstupy
 * spolu s tržními vstupy jsou signatura tiltu, ale závěr si dělá uživatel.
 */
export function describeExecutionContext(
  exec: ImportedExecution,
  allExecutions: ImportedExecution[],
): { gapSeconds: number | null; sameMinuteCount: number } {
  const sameAccount = allExecutions
    .filter(e => e.account_ext_id === exec.account_ext_id)
    .sort((a, b) => new Date(a.entry_at).getTime() - new Date(b.entry_at).getTime());
  const idx = sameAccount.findIndex(e => e.id === exec.id);
  const prev = idx > 0 ? sameAccount[idx - 1] : null;
  const entryMs = new Date(exec.entry_at).getTime();
  return {
    gapSeconds: prev ? Math.round((entryMs - new Date(prev.entry_at).getTime()) / 1000) : null,
    sameMinuteCount: sameAccount.filter(e =>
      e.entry_at.slice(0, 16) === exec.entry_at.slice(0, 16)).length,
  };
}

/**
 * Kontext na úrovni skupiny — odstup od předchozího OBCHODU, ne od kopie.
 * Kopie vznikají ve stejnou sekundu, takže per-exekuce odstupy dávají "0 s".
 */
export function describeGroupContext(
  group: ExecutionGroup,
  allGroups: ExecutionGroup[],
): { gapSeconds: number | null; sameMinuteCount: number } {
  const sorted = [...allGroups].sort(
    (a, b) => new Date(a.sample.entry_at).getTime() - new Date(b.sample.entry_at).getTime());
  const idx = sorted.findIndex(g => g.key === group.key);
  const prev = idx > 0 ? sorted[idx - 1] : null;
  const entryMs = new Date(group.sample.entry_at).getTime();
  return {
    gapSeconds: prev ? Math.round((entryMs - new Date(prev.sample.entry_at).getTime()) / 1000) : null,
    sameMinuteCount: sorted.filter(g =>
      g.sample.entry_at.slice(0, 16) === group.sample.entry_at.slice(0, 16)).length,
  };
}
