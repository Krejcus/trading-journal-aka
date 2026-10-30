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
    stop: model.ladder.stop,
    target: model.ladder.target,
    protection: `SL ${model.stopCovered}/${accounts} · TP ${model.targetCovered}/${accounts}`,
    accounts,
    scopeLabel: view.scopeLabel,
    leader: leaderOf(model.accounts),
  };
  const lines = journalLivePriceLines(model);
  return { key: JSON.stringify([model.symbol, summary, lines.map(line => [line.id, line.price, line.title])]), symbol: model.symbol, lines, summary, issue: null };
}
