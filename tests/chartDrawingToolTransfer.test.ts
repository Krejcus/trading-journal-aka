import { DrawingEngine } from '@getcandlekit/charts';
import { describe, expect, it } from 'vitest';
import {
  installWorkspaceDrawingToolSync,
  setWorkspaceDrawingTool,
  transferArmedDrawingTool,
} from '../services/chartDrawingToolTransfer';

describe('drawing tool transfer between workspace charts', () => {
  it('moves an armed tool to the chart receiving the first click', () => {
    const source = new DrawingEngine();
    const target = new DrawingEngine();
    source.startTool('TrendLine');

    expect(transferArmedDrawingTool(source, target)).toBe(true);
    expect(source.getActiveTool()).toBeNull();
    expect(target.getActiveTool()).toBe('TrendLine');
  });

  it('does not move a drawing that already has its first anchor', () => {
    const source = new DrawingEngine();
    const target = new DrawingEngine();
    source.startTool('TrendLine');
    source.beginDraft('TrendLine', { time: 60, price: 100 });

    expect(transferArmedDrawingTool(source, target)).toBe(false);
    expect(source.getDraft()).not.toBeNull();
    expect(target.getActiveTool()).toBeNull();
  });

  it('arms every chart so inactive panels have magnet preview before clicking', () => {
    const first = new DrawingEngine();
    const second = new DrawingEngine();

    setWorkspaceDrawingTool([first, second], 'Rectangle');

    expect(first.getActiveTool()).toBe('Rectangle');
    expect(second.getActiveTool()).toBe('Rectangle');
  });

  it('disarms the other charts after a drawing is completed', () => {
    const first = new DrawingEngine();
    const second = new DrawingEngine();
    setWorkspaceDrawingTool([first, second], 'TrendLine');
    const cleanup = installWorkspaceDrawingToolSync([first, second]);
    const draft = {
      id: 'manual-1',
      tool: 'TrendLine' as const,
      points: [{ time: 1, price: 100 }, { time: 2, price: 101 }],
      style: { color: '#000', width: 1, dashed: false, fill: null },
    };

    first.beginDraft('TrendLine', draft.points[0]);
    first.commit(draft);

    expect(first.getActiveTool()).toBeNull();
    expect(second.getActiveTool()).toBeNull();
    cleanup();
  });
});
