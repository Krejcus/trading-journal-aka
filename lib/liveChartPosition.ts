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
  };
  const lines = journalLivePriceLines(model);
  return { key: JSON.stringify([model.symbol, summary, lines.map(line => [line.id, line.price, line.title])]), symbol: model.symbol, lines, summary, issue: null };
}
