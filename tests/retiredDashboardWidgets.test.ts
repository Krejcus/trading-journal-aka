import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withoutRetiredWidgets } from '../lib/retiredDashboardWidgets';

describe('odstraněné AI funkce (12. 10. 2026)', () => {
  it('uložené rozvržení s dlaždicí „Insight Dne“ ji nevykreslí (žádná prázdná karta)', async () => {
    const layouts = {
      lg: [{ id: 'equity', visible: true }, { id: 'daily_insight', visible: true }],
      sm: [{ id: 'daily_insight', visible: true }],
    } as never;
    expect(withoutRetiredWidgets(layouts)).toEqual({ lg: [{ id: 'equity', visible: true }], sm: [] });
    const clean = { lg: [{ id: 'equity', visible: true }] } as never;
    expect(withoutRetiredWidgets(clean)).toBe(clean);
  });

  it('appka už nevolá generate-insight ani morning-brief', () => {
    for (const path of ['App.tsx', 'components/Dashboard.tsx']) {
      const text = readFileSync(join(__dirname, '..', path), 'utf8');
      expect(text, path).not.toMatch(/generate-insight|morning-brief|MorningBriefBanner|DailyInsightWidget/);
    }
  });
});
