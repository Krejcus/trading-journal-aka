import type { ChartViewApi } from '@getcandlekit/charts/react';

/** Capture exactly one chart panel, including its CandleKit primitives. */
export const captureChartSnapshotDataUrl = (
  api: ChartViewApi,
  executionOverlay?: HTMLCanvasElement | null,
): string => {
  const chartCanvas = api.controller.getChart().takeScreenshot(true, false);
  if (!executionOverlay) return chartCanvas.toDataURL('image/png');

  // Execution connectors and fill triangles live in a lightweight React
  // canvas above CandleKit, so the library screenshot cannot see them. Merge
  // that canvas to make the saved snapshot match what is visible on screen.
  const output = document.createElement('canvas');
  output.width = chartCanvas.width;
  output.height = chartCanvas.height;
  const context = output.getContext('2d');
  if (!context) return chartCanvas.toDataURL('image/png');
  context.drawImage(chartCanvas, 0, 0);
  context.drawImage(executionOverlay, 0, 0, output.width, output.height);
  return output.toDataURL('image/png');
};

/**
 * Capture the complete visible chart workspace in its current layout. Unlike
 * the panel API screenshot this includes every open graph, FlexLayout chrome,
 * React execution overlays and drawings exactly as the trader sees them.
 */
export const captureChartWorkspaceSnapshotDataUrl = async (
  workspace: HTMLElement,
  isDark: boolean,
): Promise<string> => {
  if (typeof document !== 'undefined') await document.fonts?.ready;
  const { toPng } = await import('html-to-image');
  const pixelRatio = typeof window === 'undefined'
    ? 1
    : Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  return toPng(workspace, {
    backgroundColor: isDark ? '#070a0f' : '#ffffff',
    cacheBust: false,
    pixelRatio,
    skipAutoScale: true,
    // Fonty už jsou v prohlížeči načtené a výsledkem je hned raster. Pokus o
    // jejich znovuvložení čte cross-origin Google CSS a v localhostu zbytečně
    // vyhazuje SecurityError, i když samotný snapshot následně uspěje.
    skipFonts: true,
  });
};
