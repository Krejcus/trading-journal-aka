import { describe, expect, it } from 'vitest';
import {
  matchingIndicatorTemplateName,
  upsertIndicatorTemplate,
  type IndicatorTemplateRecord,
} from '../components/IndicatorTemplateMenu';

const record = (indicator: string, name: string, value: unknown): IndicatorTemplateRecord => ({
  id: `${indicator}:${name}`,
  indicator,
  name,
  value,
  updatedAt: '2026-08-03T00:00:00.000Z',
});

describe('drawing template menu helpers', () => {
  it('shows the matching template name only for the same drawing tool', () => {
    const style = { color: '#2962ff', width: 2, dashed: false, fill: null };
    const records = [
      record('drawing:TrendLine', 'Modrá trendline', style),
      record('drawing:Rectangle', 'Modrý box', style),
    ];

    expect(matchingIndicatorTemplateName(records, 'drawing:TrendLine', style)).toBe('Modrá trendline');
    expect(matchingIndicatorTemplateName(records, 'drawing:Rectangle', style)).toBe('Modrý box');
    expect(matchingIndicatorTemplateName(records, 'drawing:HorizontalLine', style)).toBeNull();
  });

  it('updates a same-name template without creating a duplicate', () => {
    const first = record('drawing:TrendLine', 'Červená', { width: 1 });
    const next = record('drawing:TrendLine', 'červená', { width: 4 });

    expect(upsertIndicatorTemplate([first], next)).toEqual([{ ...next, id: first.id }]);
  });
});

