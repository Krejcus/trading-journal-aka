import { describe, expect, it, vi } from 'vitest';
import type { DrawingToolId } from '@getcandlekit/charts/react';
import { installKeepDrawingBehavior } from '../services/chartDrawingContinuation';

const engine = () => {
  let active: DrawingToolId | null = null;
  let drawings: { id: string }[] = [];
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  const api = {
    getActiveTool: () => active,
    getDrawings: () => drawings,
    startTool: vi.fn((tool: DrawingToolId) => { active = tool; emit(); }),
    onChange: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    arm: (tool: DrawingToolId) => { active = tool; emit(); },
    cancel: () => { active = null; emit(); },
    commit: (id: string) => { drawings = [...drawings, { id }]; active = null; emit(); },
    addGenerated: (id: string) => { drawings = [...drawings, { id: `auto-${id}` }]; emit(); },
  };
  return api;
};

describe('TradingView-like keep drawing', () => {
  it('re-arms the same tool after a committed manual drawing', () => {
    const drawingEngine = engine();
    installKeepDrawingBehavior(drawingEngine, () => true);
    drawingEngine.arm('TrendLine');
    drawingEngine.commit('manual-1');
    expect(drawingEngine.startTool).toHaveBeenCalledWith('TrendLine');
  });

  it('does not re-arm after cancel, generated overlays or when disabled', () => {
    const drawingEngine = engine();
    let enabled = true;
    installKeepDrawingBehavior(drawingEngine, () => enabled);
    drawingEngine.arm('Rectangle');
    drawingEngine.cancel();
    drawingEngine.addGenerated('fvg');
    expect(drawingEngine.startTool).not.toHaveBeenCalled();

    drawingEngine.arm('Rectangle');
    enabled = false;
    drawingEngine.commit('manual-2');
    expect(drawingEngine.startTool).not.toHaveBeenCalled();
  });
});
