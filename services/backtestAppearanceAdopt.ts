import {
  activeChartAppearanceScope,
  chartAppearanceSnapshot,
  chartAppearanceUserId,
  inheritGlobalAppearance,
  replaceChartAppearance,
  type ChartAppearanceState,
} from './chartAppearanceScope';
import { readProfileSettings, writeAllPanelSettings } from './chartPanelSettings';
import { detailIndicatorStyleSnapshot } from './detailIndicators';

/**
 * „Převzít styl z hlavní appky“ v backtest session. Session si drží vlastní
 * vzhled (graf, indikátory, výchozí styly kreseb) od svého založení, takže
 * pozdější úpravy v deníku do ní neprosakují. Tohle je jednorázové převzetí:
 * profil hlavní appky se zkopíruje do session (pro všechny její panely) a
 * od té doby se zase vyvíjí samostatně. Rozložení, kresby ani obchody se
 * nemění.
 */
export function journalAppearanceForSession(): ChartAppearanceState {
  const next: ChartAppearanceState = {
    indicatorSettings: writeAllPanelSettings(detailIndicatorStyleSnapshot()),
  };
  const chart = readProfileSettings(inheritGlobalAppearance('chartSettings'));
  if (chart !== undefined) next.chartSettings = writeAllPanelSettings(chart);
  const drawing = inheritGlobalAppearance('drawingStyleDefaults');
  if (drawing !== undefined) next.drawingStyleDefaults = drawing;
  return next;
}

/** Vrací funkci pro návrat, nebo `null`, když žádná session není otevřená. */
export function adoptJournalAppearance(): (() => void) | null {
  const scope = activeChartAppearanceScope();
  const before = chartAppearanceSnapshot();
  // Účet se ještě ověřuje: profil by se četl prázdný a session by dostala výchozí styl.
  if (scope === null || before === undefined || chartAppearanceUserId() === undefined) return null;
  replaceChartAppearance({ ...before, ...journalAppearanceForSession() });
  return () => {
    // Mezitím zavřená nebo přepnutá session: návrat by zapsal jinam.
    if (activeChartAppearanceScope() !== scope) return;
    try { replaceChartAppearance(before); } catch { /* session mezitím patří jinému účtu */ }
  };
}
