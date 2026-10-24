import { afterEach, describe, expect, it, vi } from 'vitest';
import { adoptJournalAppearance } from '../services/backtestAppearanceAdopt';
import {
  chartAppearanceSnapshot,
  closeChartAppearanceScope,
  inheritGlobalAppearance,
  openChartAppearanceScope,
  resetChartAppearanceScope,
  setChartAppearanceUserId,
  writeGlobalChartAppearance,
} from '../services/chartAppearanceScope';
import { mergeIndicatorSettings } from '../services/chartIndicatorSettings';

const stubStorage = () => {
  const values = new Map<string, string>();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  } });
};

afterEach(() => {
  resetChartAppearanceScope();
  vi.unstubAllGlobals();
});

describe('adoptJournalAppearance', () => {
  it('copies the journal profile into the open session for all panels and undoes back', () => {
    stubStorage();
    setChartAppearanceUserId('user-1');
    const journalIndicators = mergeIndicatorSettings(null);
    journalIndicators.fvg.bullColor = '#4caf50';
    writeGlobalChartAppearance('chartSettings', { __panelScoped: 1, shared: { canvas: { gridLines: 'none' } }, panels: {} });
    writeGlobalChartAppearance('indicatorSettings', { __panelScoped: 1, shared: journalIndicators, panels: {} });
    writeGlobalChartAppearance('drawingStyleDefaults', { trendLine: { color: '#fff' } });

    const sessionAppearance = {
      chartSettings: { __panelScoped: 1, shared: { canvas: { gridLines: 'both' } }, panels: { 'alphatrade-chart-2': { canvas: { gridLines: 'vert' } } } },
      indicatorSettings: { __panelScoped: 1, shared: { fvg: { bullColor: '#2196f3' } }, panels: {} },
    };
    openChartAppearanceScope('backtest:run-1', sessionAppearance, inheritGlobalAppearance);

    const undo = adoptJournalAppearance();
    expect(undo).toBeTypeOf('function');
    const adopted = chartAppearanceSnapshot()!;
    // Odchylky panelů zmizí: profil platí pro všechny panely session.
    expect(adopted.chartSettings).toEqual({ __panelScoped: 1, shared: { canvas: { gridLines: 'none' } }, panels: {} });
    expect((adopted.indicatorSettings as { shared: typeof journalIndicators }).shared.fvg.bullColor).toBe('#4caf50');
    expect(adopted.drawingStyleDefaults).toEqual({ trendLine: { color: '#fff' } });

    undo!();
    expect(chartAppearanceSnapshot()).toEqual({ ...sessionAppearance, drawingStyleDefaults: { trendLine: { color: '#fff' } } });
  });

  it('does nothing outside a backtest session and never undoes into another session', () => {
    stubStorage();
    setChartAppearanceUserId('user-1');
    expect(adoptJournalAppearance()).toBeNull();

    openChartAppearanceScope('backtest:a', { chartSettings: { shared: { a: 1 } } }, () => undefined);
    const undo = adoptJournalAppearance()!;
    closeChartAppearanceScope('backtest:a');
    openChartAppearanceScope('backtest:b', { chartSettings: { shared: { b: 1 } } }, () => undefined);
    undo();
    expect(chartAppearanceSnapshot()?.chartSettings).toEqual({ shared: { b: 1 } });
  });
});
