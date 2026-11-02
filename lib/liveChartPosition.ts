import {
  journalLiveIssueLabel, journalLivePriceLines,
  type JournalLiveTarget, type JournalLiveView, type LivePriceLine,
} from './journalLivePosition';

/**
 * Živá pozice pro LIVE → Graf (jen zobrazení): souhrn do panelu objednávky
 * a čáry do grafu. Stejný read model brokera jako graf dne a karta obchodu —
 * otevřené P&L je z brokera, nikdy z ceny TradingView (INV-UI-04). Neověřený
 * pohled = text místo čísel a žádné čáry, nikdy „flat“.
 */
export interface LiveChartPositionSummary {
  kind: 'position' | 'pending';
  side: 'long' | 'short';
  quantity: number;
  /** Průměrný vstup (u čekajícího vstupu jeho cena); null = neznámo. */
  entry: number | null;
  /** Typ čekajícího vstupu (Limit, Stop…). */
  entryType: string | null;
  /** Otevřené P&L z brokera (po poplatcích, když jsou známé); null = neznámo. */
  openPnl: number | null;
  /** Cena trhu odvozená z P&L brokera (jen zobrazení a UI pojistky, nikdy autorizace); null = neznámá. */
  mark: number | null;
  stop: number | null;
  target: number | null;
  /** „SL 3/3 · TP 3/3“ — kolik účtů v obchodu má ochranu na celou pozici. */
  protection: string;
  accounts: number;
  /** Souhrn jen jednoho účtu skupiny (ručně vypnutá kopírka, expozice jen na něm), např. „jen T2“. */
  scopeLabel: string | null;
  /**
   * Účet označený v pohledu jako leader (ne součet skupiny) — „co jsem viděl“ u správy
   * příkazu leadera. POZOR: `isLeader` je zobrazovací příznak (pohled jednoho účtu ho
   * dá i followerovi), proto správa vždy porovná `accountId` s leaderem skupiny workeru.
   */
  leader: { accountId: number; quantity: number; entry: number | null } | null;
  /** Účty v obchodu pro rozbalení karty pozice (jen zobrazení; leader první). */
  rows: readonly LiveChartPositionAccountRow[];
}

export interface LiveChartPositionAccountRow {
  accountId: number;
  name: string;
  /** Zobrazovací příznak — nikdy autorizace (viz `leader`). */
  isLeader: boolean;
  quantity: number;
  entry: number | null;
  /** Otevřené P&L účtu z brokera po poplatcích; null = neznámo. */
  openPnl: number | null;
  stop: number | null;
  target: number | null;
  /** SL i TP kryjí celou pozici účtu. */
  protectedFully: boolean;
  /** Výsledek na SL / TP v USD po poplatcích (jen při přesném krytí); null = neznámo. */
  stopUsd: number | null;
  targetUsd: number | null;
  /** Poplatky celé pozice a čas kotvy P&L — podklad živého P&L s cenou trhu (jen zobrazení). */
  fees: number | null;
  openPnlAsOf: string | null;
  /** Příkazy účtu ověřené; jinak SL/TP neznámé (nikdy „bez SL“). */
  ordersVerified: boolean;
  /** Kontrakty kryté SL / TP (víc cen = `stop`/`target` null, krytí > 0). */
  stopCoverage: number;
  targetCoverage: number;
}

export interface LiveChartPosition {
  /** Obsahový klíč — graf se překreslí jen při změně. */
  key: string;
  symbol: string | null;
  lines: readonly LivePriceLine[];
  summary: LiveChartPositionSummary | null;
  /** Proč čísla nejsou (neověřené čtení, dobíhající kopie, rozjetí…). */
  issue: string | null;
}

export const NO_LIVE_CHART_POSITION: LiveChartPosition = { key: 'none', symbol: null, lines: [], summary: null, issue: null };

const leaderOf = (accounts: readonly { accountId: number; isLeader: boolean; quantity: number; entry: number | null }[]) => {
  const leader = accounts.find(account => account.isLeader);
  return leader ? { accountId: leader.accountId, quantity: leader.quantity, entry: leader.entry } : null;
};

const MNQ_TICK = 0.25;
/** Odstup SL od trhu (podle P&L brokera), pod kterým UI utažení nenabídne — kopie followerům by závodila s trhem. */
export const TIGHTEN_MIN_TICKS = 8;

/** SL na BE: průměrný vstup na tick ve směru ochrany (long dolů, short nahoru); epsilon proti součtům fillů. */
export function breakEvenStop(side: 'long' | 'short', entryAvg: number | null | undefined, tick = MNQ_TICK): number | null {
  if (entryAvg == null || !Number.isFinite(entryAvg) || entryAvg <= 0) return null;
  const units = entryAvg / tick;
  return (side === 'long' ? Math.floor(units + 1e-9) : Math.ceil(units - 1e-9)) * tick;
}

/**
 * UI pojistka utažení SL (jen blokuje, nic neautorizuje — rozhoduje broker):
 * posun k trhu jen s čerstvou cenou z P&L brokera a aspoň `TIGHTEN_MIN_TICKS`
 * od ní. Posun dál od trhu pojistku nepotřebuje. Vrací důvod blokace, nebo null.
 */
export function tightenBlockReason(
  side: 'long' | 'short', currentStop: number | null, nextStop: number | null, mark: number | null, tick = MNQ_TICK,
): string | null {
  if (currentStop == null || nextStop == null) return null;
  const toward = side === 'long' ? nextStop > currentStop : nextStop < currentStop;
  if (!toward) return null;
  if (mark == null || !Number.isFinite(mark)) return 'Cena trhu od brokera není známá — utažení SL teď nejde.';
  const gap = side === 'long' ? mark - nextStop : nextStop - mark;
  if (gap < TIGHTEN_MIN_TICKS * tick - 1e-9) return `Nový SL je blíž než ${TIGHTEN_MIN_TICKS} ticků od trhu (nebo za ním) — kopírka by followerům posun nestihla.`;
  return null;
}

/** Nejstarší kotace IBKR, kterou smí pojistka utažení SL použít místo ceny z P&L brokera. */
export const TIGHTEN_IBKR_MARK_MAX_AGE_MS = 3_000;

/**
 * Cena trhu pro pojistku utažení SL / BE (2. 11. 2026, Filip: „jen IBKR pro risk“):
 * když cena z P&L brokera chybí (čerstvá pozice, REST zaostává), vezme se čerstvá
 * kotace z IBKR pro STEJNÝ konkrétní kontrakt pozice. TradingView ani kontinuální
 * řada nikdy. Jen blokuje — nic neautorizuje; SL přes trh odmítne broker.
 */
export function withIbkrTightenMark<T extends { mark: number | null }>(
  summary: T,
  positionSymbol: string | null,
  quote: { source: string | null; price: number | null; at: number | null; stale: boolean },
  now: number,
): T {
  if (summary.mark != null && Number.isFinite(summary.mark)) return summary;
  const source = (quote.source ?? '').trim().toUpperCase();
  const match = /^IBKR:(MNQ)([HMUZ])20(\d{2})$/.exec(source);
  const contract = match ? `${match[1]}${match[2]}${match[3].slice(-1)}` : null;
  if (!contract || contract !== positionSymbol || quote.stale || quote.price == null || !Number.isFinite(quote.price)
    || quote.at == null || now - quote.at > TIGHTEN_IBKR_MARK_MAX_AGE_MS || quote.at > now + 2_000) return summary;
  return { ...summary, mark: quote.price };
}

/**
 * „Co jsem viděl“ pro správu příkazu leadera — jen když souhrn opravdu patří
 * leaderovi skupiny workeru (ne followerovi s přepsaným `isLeader`). null = nenabízet.
 */
export function leaderManageBasis(summary: LiveChartPositionSummary | null | undefined, leaderAccountId: number | null | undefined) {
  const leader = summary?.leader ?? null;
  return leader && leaderAccountId != null && leader.accountId === leaderAccountId ? leader : null;
}

export function liveChartPosition(view: JournalLiveView, requested: JournalLiveTarget): LiveChartPosition {
  // Pohled tiše spadlý na skupinu (účet zmizel) nesmí ukázat cizí pozici.
  if (view.target !== requested) {
    return { key: `mismatch:${requested}`, symbol: null, lines: [], summary: null, issue: 'Pozice vybraného účtu není v datech' };
  }
  if (!view.verified) {
    const issue = journalLiveIssueLabel(view) ?? 'Pozice neověřené';
    return { key: `issue:${issue}`, symbol: null, lines: [], summary: null, issue };
  }
  const model = view.model;
  if (!model) return NO_LIVE_CHART_POSITION;
  const accounts = model.accounts.length;
  const summary: LiveChartPositionSummary = {
    kind: model.kind,
    side: model.direction === 1 ? 'long' : 'short',
    quantity: model.quantity,
    entry: model.entry,
    entryType: model.entryType,
    openPnl: model.kind === 'position' ? model.openPnl : null,
    mark: model.kind === 'position' ? model.mark : null,
    stop: model.ladder.stop,
    target: model.ladder.target,
    // Neověřené příkazy některého účtu: krytí neznámé, ne „0/n“ (PC panel i telefon).
    protection: model.accounts.some(account => account.ordersVerified === false)
      ? `SL ?/${accounts} · TP ?/${accounts}`
      : `SL ${model.stopCovered}/${accounts} · TP ${model.targetCovered}/${accounts}`,
    accounts,
    scopeLabel: view.scopeLabel,
    leader: leaderOf(model.accounts),
    rows: model.accounts.map(account => ({
      accountId: account.accountId,
      name: account.name,
      isLeader: account.isLeader,
      quantity: account.quantity,
      entry: account.entry,
      openPnl: model.kind === 'position' ? account.openPnl : null,
      stop: account.stop?.price ?? null,
      target: account.target?.price ?? null,
      protectedFully: account.stop?.exact === true && account.target?.exact === true,
      stopUsd: account.stop?.usd ?? null,
      targetUsd: account.target?.usd ?? null,
      fees: account.fees,
      openPnlAsOf: model.kind === 'position' ? account.openPnlAsOf : null,
      ordersVerified: account.ordersVerified,
      stopCoverage: account.stop?.coverage ?? 0,
      targetCoverage: account.target?.coverage ?? 0,
    })),
  };
  const lines = journalLivePriceLines(model);
  // Klíč bez polí, která se mění každým tickem bez změny obrazu PC grafu (kotva P&L, poplatky, $ úrovní).
  const keyRows = summary.rows.map(({ openPnlAsOf: _asOf, fees: _fees, stopUsd: _stopUsd, targetUsd: _targetUsd, ...row }) => row);
  return { key: JSON.stringify([model.symbol, { ...summary, rows: keyRows }, lines.map(line => [line.id, line.price, line.title])]), symbol: model.symbol, lines, summary, issue: null };
}
