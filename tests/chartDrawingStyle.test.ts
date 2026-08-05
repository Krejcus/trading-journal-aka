import { describe, expect, it } from 'vitest';
import { drawingToolSupportsFill } from '../services/chartDrawingStyle';

describe('chart drawing style capabilities', () => {
  it.each(['Rectangle', 'Circle', 'Triangle', 'ParallelChannel', 'PriceRange', 'DateRange'] as const)(
    'offers fill controls for %s',
    tool => expect(drawingToolSupportsFill(tool)).toBe(true),
  );

  it.each(['TrendLine', 'Ray', 'HorizontalLine', 'Arrow', 'FibExtension'] as const)(
    'does not offer fill controls for %s',
    tool => expect(drawingToolSupportsFill(tool)).toBe(false),
  );
});

