import type { DrawingToolId } from '@getcandlekit/charts/react';

export interface RepeatableDrawingEngine {
  getActiveTool: () => DrawingToolId | null;
  getDrawings: () => readonly { id: string }[];
  startTool: (tool: DrawingToolId) => void;
  onChange: (listener: () => void) => () => void;
}

const manualDrawingCount = (engine: RepeatableDrawingEngine) => (
  engine.getDrawings().filter(drawing => !drawing.id.startsWith('auto-')).length
);

/**
 * Re-arms the last tool only after the engine committed a new manual drawing.
 * Cancellation, tool transfer and generated overlays therefore stay untouched.
 */
export const installKeepDrawingBehavior = (
  engine: RepeatableDrawingEngine,
  isEnabled: () => boolean,
): (() => void) => {
  let lastArmedTool = engine.getActiveTool();
  let previousDrawingCount = manualDrawingCount(engine);
  let restarting = false;

  const sync = () => {
    if (restarting) return;
    const activeTool = engine.getActiveTool();
    const drawingCount = manualDrawingCount(engine);

    if (activeTool) {
      lastArmedTool = activeTool;
      previousDrawingCount = drawingCount;
      return;
    }

    const committedDrawing = Boolean(lastArmedTool && drawingCount > previousDrawingCount);
    previousDrawingCount = drawingCount;
    if (!committedDrawing || !isEnabled()) {
      lastArmedTool = null;
      return;
    }

    const tool = lastArmedTool;
    restarting = true;
    engine.startTool(tool!);
    restarting = false;
  };

  return engine.onChange(sync);
};
