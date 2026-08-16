import { describe, expect, it } from 'vitest';
import {
  chartTemplateKey,
  mergeChartTemplates,
  upsertChartTemplate,
  type ChartTemplateRecord,
} from '../services/chartTemplateStore';

const template = (patch: Partial<ChartTemplateRecord>): ChartTemplateRecord => ({
  id: 'a',
  indicator: 'levels',
  name: 'Modré levely',
  value: { showVwap: true },
  updatedAt: '2026-08-01T00:00:00.000Z',
  ...patch,
});

describe('chartTemplateKey', () => {
  it('název porovnává bez ohledu na velikost písmen a mezery', () => {
    expect(chartTemplateKey(template({ name: '  Modré Levely ' })))
      .toBe(chartTemplateKey(template({ name: 'modré levely' })));
  });

  it('stejný název u jiného nástroje je jiná šablona', () => {
    expect(chartTemplateKey(template({ indicator: 'fvg' })))
      .not.toBe(chartTemplateKey(template({ indicator: 'levels' })));
  });
});

describe('upsertChartTemplate', () => {
  it('uložení pod existujícím názvem přepíše obsah a zachová id', () => {
    const next = upsertChartTemplate([template({})], template({
      id: 'b',
      name: 'MODRÉ LEVELY',
      value: { showVwap: false },
    }));
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('a');
    expect(next[0].value).toEqual({ showVwap: false });
  });

  it('nový název přidá další záznam', () => {
    const next = upsertChartTemplate([template({})], template({ id: 'b', name: 'Čisté levely' }));
    expect(next.map(record => record.name)).toEqual(['Modré levely', 'Čisté levely']);
  });

  it('přepis pod existujícím názvem nechá ostatní šablony na pokoji', () => {
    const records = [template({}), template({ id: 'b', name: 'Čisté levely' })];
    const next = upsertChartTemplate(records, template({ id: 'nové', value: { showVwap: false } }));
    expect(next.map(record => record.id).sort()).toEqual(['a', 'b']);
    expect(next.find(record => record.id === 'a')?.value).toEqual({ showVwap: false });
  });
});

describe('mergeChartTemplates', () => {
  it('pod stejným názvem vyhrává novější záznam', () => {
    const merged = mergeChartTemplates(
      [template({ id: 'local', updatedAt: '2026-08-05T00:00:00.000Z', value: { showVwap: false } })],
      [template({ id: 'cloud', updatedAt: '2026-08-01T00:00:00.000Z' })],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('local');
  });

  it('starší lokální kopie cloudovou nepřepíše', () => {
    const merged = mergeChartTemplates(
      [template({ id: 'local', updatedAt: '2026-07-01T00:00:00.000Z' })],
      [template({ id: 'cloud', updatedAt: '2026-08-01T00:00:00.000Z' })],
    );
    expect(merged[0].id).toBe('cloud');
  });

  it('šablony jen na jedné straně zůstanou obě', () => {
    const merged = mergeChartTemplates(
      [template({ id: 'local', name: 'Jen lokálně' })],
      [template({ id: 'cloud', name: 'Jen v cloudu' })],
    );
    expect(merged.map(record => record.name).sort()).toEqual(['Jen lokálně', 'Jen v cloudu']);
  });
});
