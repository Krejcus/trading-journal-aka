import { describe, expect, it } from 'vitest';
import {
  CHART_WORKSPACE_LAYOUT_ROWS,
  CHART_WORKSPACE_LAYOUTS,
  buildChartWorkspaceLayout,
} from '../services/chartWorkspaceLayouts';

const countTabs = (node: unknown): number => {
  if (!node || typeof node !== 'object') return 0;
  const value = node as { type?: string; children?: unknown[] };
  if (value.type === 'tab') return 1;
  return value.children?.reduce<number>((sum, child) => sum + countTabs(child), 0) ?? 0;
};

describe('TradingView-like chart workspace layouts', () => {
  it('contains the complete first four TradingView rows', () => {
    expect(CHART_WORKSPACE_LAYOUT_ROWS.map(row => row.length)).toEqual([1, 2, 6, 10]);
    expect(CHART_WORKSPACE_LAYOUTS).toHaveLength(19);
  });

  it.each(CHART_WORKSPACE_LAYOUTS)('builds $id with $panelCount panels', template => {
    const tree = buildChartWorkspaceLayout({
      id: template.id,
      configs: Array.from({ length: template.panelCount }, (_, index) => ({ index })),
      component: 'alphatrade-chart',
      panelIdPrefix: 'chart-',
      panelTitle: panel => `Graf ${panel}`,
    });
    expect(countTabs(tree.layout)).toBe(template.panelCount);
    expect(template.cells).toHaveLength(template.panelCount);
    template.cells.forEach(cell => {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.y).toBeGreaterThanOrEqual(0);
      expect(cell.x + cell.width).toBeLessThanOrEqual(1.000001);
      expect(cell.y + cell.height).toBeLessThanOrEqual(1.000001);
    });
  });
});
