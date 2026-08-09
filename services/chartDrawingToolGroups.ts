import type { DrawingToolId } from '@getcandlekit/charts/react';

export type ChartDrawingToolGroupId = 'lines' | 'fibonacci' | 'annotation' | 'shapes' | 'measure' | 'position';

export interface ChartDrawingToolGroup {
  id: ChartDrawingToolGroupId;
  title: string;
  tools: readonly DrawingToolId[];
  defaultTool: DrawingToolId;
  dividerBefore?: boolean;
}

export const CHART_DRAWING_TOOL_GROUPS: readonly ChartDrawingToolGroup[] = [
  {
    id: 'lines',
    title: 'Čáry',
    tools: [
      'TrendLine', 'Ray', 'ExtendedLine',
      'HorizontalLine', 'HorizontalRay', 'VerticalLine', 'CrossLine',
      'ParallelChannel',
    ],
    defaultTool: 'TrendLine',
  },
  {
    id: 'fibonacci',
    title: 'Fibonacci',
    tools: ['FibRetracement', 'FibExtension'],
    defaultTool: 'FibRetracement',
    dividerBefore: true,
  },
  {
    id: 'annotation',
    title: 'Anotace',
    tools: ['Arrow', 'Text'],
    defaultTool: 'Arrow',
  },
  {
    id: 'shapes',
    title: 'Geometrické tvary',
    tools: ['Rectangle', 'Circle', 'Triangle'],
    defaultTool: 'Rectangle',
  },
  {
    id: 'measure',
    title: 'Měření',
    tools: ['PriceRange', 'DateRange'],
    defaultTool: 'PriceRange',
    dividerBefore: true,
  },
  {
    id: 'position',
    title: 'Predikce a měření',
    tools: ['LongPosition', 'ShortPosition'],
    defaultTool: 'LongPosition',
  },
] as const;

export type ChartDrawingToolSelections = Record<ChartDrawingToolGroupId, DrawingToolId>;

export const defaultChartDrawingToolSelections = (): ChartDrawingToolSelections => Object.fromEntries(
  CHART_DRAWING_TOOL_GROUPS.map(group => [group.id, group.defaultTool]),
) as ChartDrawingToolSelections;

export const chartDrawingToolGroupFor = (
  tool: DrawingToolId | null | undefined,
): ChartDrawingToolGroup | undefined => CHART_DRAWING_TOOL_GROUPS.find(group => (
  tool ? group.tools.includes(tool) : false
));

export const rememberChartDrawingTool = (
  selections: ChartDrawingToolSelections,
  tool: DrawingToolId,
): ChartDrawingToolSelections => {
  const group = chartDrawingToolGroupFor(tool);
  return group && selections[group.id] !== tool
    ? { ...selections, [group.id]: tool }
    : selections;
};

const CHART_DRAWING_TOOL_IDS = new Set<DrawingToolId>(
  CHART_DRAWING_TOOL_GROUPS.flatMap(group => [...group.tools]),
);

export const normalizeChartDrawingFavorites = (value: unknown): DrawingToolId[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tool): tool is DrawingToolId => (
    typeof tool === 'string' && CHART_DRAWING_TOOL_IDS.has(tool as DrawingToolId)
  )))];
};

export const toggleChartDrawingFavorite = (
  favorites: readonly DrawingToolId[],
  tool: DrawingToolId,
): DrawingToolId[] => favorites.includes(tool)
  ? favorites.filter(item => item !== tool)
  : [...favorites, tool];
