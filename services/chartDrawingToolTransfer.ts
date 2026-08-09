import type { Drawing, DrawingToolId } from '@getcandlekit/charts';

interface DrawingToolEngineLike {
  getActiveTool: () => DrawingToolId | null;
  getDraft: () => Drawing | null;
  getDrawings: () => readonly Drawing[];
  startTool: (tool: DrawingToolId) => void;
  stopTool: () => void;
  select: (id: string | null) => void;
  onChange: (listener: () => void) => () => void;
}

const uniqueEngines = (engines: readonly DrawingToolEngineLike[]) => [...new Set(engines)];

export const setWorkspaceDrawingTool = (
  engines: readonly DrawingToolEngineLike[],
  tool: DrawingToolId | null,
) => {
  uniqueEngines(engines).forEach(engine => {
    if (tool === null) {
      engine.stopTool();
      engine.select(null);
    } else if (engine.getActiveTool() !== tool) {
      engine.startTool(tool);
    }
  });
};

export const installWorkspaceDrawingToolSync = (engines: readonly DrawingToolEngineLike[]) => {
  const available = uniqueEngines(engines);
  const previous = new Map(available.map(engine => [engine, {
    tool: engine.getActiveTool(),
    manualCount: engine.getDrawings().filter(drawing => !drawing.id.startsWith('auto-')).length,
  }]));
  let synchronizing = false;
  const refresh = () => available.forEach(engine => previous.set(engine, {
    tool: engine.getActiveTool(),
    manualCount: engine.getDrawings().filter(drawing => !drawing.id.startsWith('auto-')).length,
  }));
  const cleanups = available.map(engine => engine.onChange(() => {
    if (synchronizing) return;
    const before = previous.get(engine);
    const tool = engine.getActiveTool();
    const manualCount = engine.getDrawings().filter(drawing => !drawing.id.startsWith('auto-')).length;
    previous.set(engine, { tool, manualCount });
    const committed = Boolean(before?.tool && !tool && manualCount > before.manualCount);
    if (!committed) return;
    synchronizing = true;
    available.forEach(other => {
      if (other !== engine && other.getActiveTool()) other.stopTool();
    });
    synchronizing = false;
    refresh();
  }));
  return () => cleanups.forEach(cleanup => cleanup());
};

export const transferArmedDrawingTool = (
  source: DrawingToolEngineLike | null | undefined,
  target: DrawingToolEngineLike | null | undefined,
) => {
  if (!source || !target || source === target) return false;
  const tool = source.getActiveTool();
  if (!tool || source.getDraft()) return false;
  source.stopTool();
  target.startTool(tool);
  return true;
};
