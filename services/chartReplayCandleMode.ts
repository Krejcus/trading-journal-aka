import { useEffect, useState } from 'react';
import {
  CHART_SETTINGS_EVENT,
  loadChartSettings,
  saveChartSettings,
  type ChartReplayCandleMode,
} from './chartSettings';
import { DEFAULT_CHART_PANEL_ID } from './chartPanelSettings';

/**
 * Režim svíček v přehrávání (nastavení grafu → Přehrávání). Je součástí
 * profilu grafů, takže platí pro přehrávač v detailu obchodu i Bar Replay
 * ve fullscreenu a synchronizuje se mezi zařízeními.
 */

const SOURCE = Symbol('replay-candle-mode');

export function useReplayCandleMode(isDark: boolean, panelId: string = DEFAULT_CHART_PANEL_ID): ChartReplayCandleMode {
  const [mode, setMode] = useState<ChartReplayCandleMode>(() => loadChartSettings(isDark, panelId).replay.candleMode);
  useEffect(() => {
    const reload = () => setMode(loadChartSettings(isDark, panelId).replay.candleMode);
    reload();
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ settings?: { replay?: { candleMode?: ChartReplayCandleMode } }; reload?: boolean }>).detail;
      if (detail?.settings?.replay?.candleMode) setMode(detail.settings.replay.candleMode);
      else reload();
    };
    window.addEventListener(CHART_SETTINGS_EVENT, onChange);
    return () => window.removeEventListener(CHART_SETTINGS_EVENT, onChange);
  }, [isDark, panelId]);
  return mode;
}

/** Přepnutí z replay panelu — uloží se do profilu (všechny grafy). */
export function setReplayCandleMode(mode: ChartReplayCandleMode, isDark: boolean, panelId: string = DEFAULT_CHART_PANEL_ID): void {
  const settings = loadChartSettings(isDark, panelId);
  if (settings.replay.candleMode === mode) return;
  saveChartSettings({ ...settings, replay: { ...settings.replay, candleMode: mode } }, SOURCE, { panelId, allPanels: true }, isDark);
}

export const REPLAY_CANDLE_MODE_OPTIONS: readonly { value: ChartReplayCandleMode; label: string; description: string }[] = [
  { value: 'smooth', label: 'Plynule', description: 'open → high/low → close' },
  { value: 'whole', label: 'Celá svíčka', description: 'naskočí najednou' },
];
