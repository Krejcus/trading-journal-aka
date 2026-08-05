import type { DrawingToolId } from '@getcandlekit/charts/react';

export interface ChartDrawingShortcutEvent {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  code: string;
}

const SHORTCUTS: Readonly<Record<string, DrawingToolId>> = {
  KeyT: 'TrendLine',
  KeyH: 'HorizontalLine',
  KeyJ: 'HorizontalRay',
  KeyV: 'VerticalLine',
  KeyC: 'CrossLine',
};

export const chartDrawingToolForShortcut = (
  event: ChartDrawingShortcutEvent,
): DrawingToolId | null => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  return SHORTCUTS[event.code] ?? null;
};
