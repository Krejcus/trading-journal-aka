import type { ChartViewApi } from '@getcandlekit/charts/react';

export interface ChartDrawingCollection {
  getDrawings: () => readonly { id: string }[];
  remove: (id: string) => void;
}

export const isManualChartDrawing = (drawing: { id: string }) => !drawing.id.startsWith('auto-');

export const countManualChartDrawings = (engine: ChartDrawingCollection | null | undefined): number => (
  engine?.getDrawings().filter(isManualChartDrawing).length ?? 0
);

export const removeManualChartDrawings = (engine: ChartDrawingCollection | null | undefined): number => {
  if (!engine) return 0;
  const drawings = engine.getDrawings().filter(isManualChartDrawing);
  drawings.forEach(drawing => engine.remove(drawing.id));
  return drawings.length;
};

export const countChartIndicators = (
  customIndicators: readonly boolean[],
  libraryIndicators: readonly string[],
): number => customIndicators.filter(Boolean).length + new Set(libraryIndicators).size;

export const resetChartView = (api: ChartViewApi | null | undefined): boolean => {
  if (!api) return false;
  const chart = api.controller.getChart();
  // Osa může být podle nastavení vlevo i vpravo; reset se má chytit vždy.
  (['right', 'left'] as const).forEach(scaleId => {
    try { chart.priceScale(scaleId).setAutoScale(true); } catch { /* osa není v grafu */ }
  });
  chart.timeScale().resetTimeScale();
  return true;
};

export const isResetChartViewShortcut = (event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code'>): boolean => (
  event.altKey
  && !event.ctrlKey
  && !event.metaKey
  && !event.shiftKey
  && event.code === 'KeyR'
);
