import type { DrawingToolId } from '@getcandlekit/charts';

const FILL_CAPABLE_TOOLS = new Set<DrawingToolId>([
  'Rectangle',
  'Circle',
  'Triangle',
  'ParallelChannel',
  'PriceRange',
  'DateRange',
]);

export const drawingToolSupportsFill = (tool: DrawingToolId): boolean => FILL_CAPABLE_TOOLS.has(tool);

