import { describe, expect, it } from 'vitest';
import {
  CHART_DRAWING_TOOL_GROUPS,
  chartDrawingToolGroupFor,
  defaultChartDrawingToolSelections,
  normalizeChartDrawingFavorites,
  rememberChartDrawingTool,
  toggleChartDrawingFavorite,
} from '../services/chartDrawingToolGroups';

describe('TradingView-like drawing tool groups', () => {
  it('contains every AlphaTrade drawing tool exactly once', () => {
    const tools = CHART_DRAWING_TOOL_GROUPS.flatMap(group => [...group.tools]);
    expect(tools).toHaveLength(new Set(tools).size);
    expect(tools).toEqual(expect.arrayContaining([
      'TrendLine', 'Ray', 'ExtendedLine', 'HorizontalLine', 'HorizontalRay', 'VerticalLine', 'CrossLine', 'ParallelChannel',
      'FibRetracement', 'FibExtension', 'Arrow', 'Text', 'Rectangle', 'Circle', 'Triangle', 'PriceRange', 'DateRange',
      'LongPosition', 'ShortPosition',
    ]));
  });

  it('remembers the last selected tool in its group only', () => {
    const initial = defaultChartDrawingToolSelections();
    const next = rememberChartDrawingTool(initial, 'HorizontalLine');

    expect(chartDrawingToolGroupFor('HorizontalLine')?.id).toBe('lines');
    expect(next.lines).toBe('HorizontalLine');
    expect(next.shapes).toBe(initial.shapes);
    expect(next.measure).toBe(initial.measure);
  });

  it('keeps valid unique favorites and toggles them without reordering the rest', () => {
    expect(normalizeChartDrawingFavorites(['TrendLine', 'TrendLine', 'bad-tool', 7])).toEqual(['TrendLine']);
    expect(toggleChartDrawingFavorite(['TrendLine', 'Rectangle'], 'TrendLine')).toEqual(['Rectangle']);
    expect(toggleChartDrawingFavorite(['TrendLine'], 'HorizontalLine')).toEqual(['TrendLine', 'HorizontalLine']);
  });
});
