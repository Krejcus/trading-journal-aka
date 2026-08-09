import { describe, expect, it, vi } from 'vitest';
import {
  buildCostRequestUrl,
  estimateBackfillCost,
  mostRecentFullyHistoricalUtcDay,
  parseCostResponse,
  runBackfillCostCli,
  subtractUtcYears,
} from '../scripts/market-data/estimate-backfill-cost.mjs';

describe('Databento backfill cost-only estimator', () => {
  it('uses the latest fully historical UTC boundary and exactly five calendar years', () => {
    expect(mostRecentFullyHistoricalUtcDay(new Date('2026-08-08T12:00:00Z'))).toBe('2026-08-07');
    expect(subtractUtcYears('2026-08-07', 5)).toBe('2021-08-07');
    expect(subtractUtcYears('2024-02-29', 5)).toBe('2019-02-28');
  });

  it('builds a continuous OHLCV-1m cost request without a record limit', () => {
    const url = new URL(buildCostRequestUrl({
      symbol: 'MNQ.v.0',
      start: '2021-08-07',
      end: '2026-08-07',
    }));
    expect(url.pathname).toBe('/v0/metadata.get_cost');
    expect(url.searchParams.get('dataset')).toBe('GLBX.MDP3');
    expect(url.searchParams.get('schema')).toBe('ohlcv-1m');
    expect(url.searchParams.get('stype_in')).toBe('continuous');
    expect(url.searchParams.get('symbols')).toBe('MNQ.v.0');
    expect(url.searchParams.has('limit')).toBe(false);
  });

  it('quotes MNQ and NQ separately and totals the authenticated free estimates', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('1.25', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"cost_usd":2.75}', { status: 200 }));

    const result = await estimateBackfillCost({
      apiKey: 'configured-secret',
      start: '2021-08-07',
      end: '2026-08-07',
      fetchImpl,
    });

    expect(result.estimates).toEqual([
      { symbol: 'MNQ.v.0', costUsd: 1.25 },
      { symbol: 'NQ.v.0', costUsd: 2.75 },
    ]);
    expect(result.totalCostUsd).toBe(4);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const headers = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    expect(headers.Authorization).not.toContain('configured-secret');
  });

  it('fails closed on missing credentials or malformed provider output', async () => {
    await expect(estimateBackfillCost({
      apiKey: '',
      start: '2021-08-07',
      end: '2026-08-07',
      fetchImpl: vi.fn(),
    })).rejects.toThrow('DATABENTO_API_KEY');

    await expect(estimateBackfillCost({
      apiKey: 'configured-secret',
      start: '2021-08-07',
      end: '2026-08-07',
      fetchImpl: vi.fn().mockResolvedValue(new Response('not-a-price', { status: 200 })),
    })).rejects.toThrow('cost quote failed');
    expect(parseCostResponse('-1')).toBeNaN();
  });

  it('prints only the quote inputs and results, never the credential', async () => {
    const lines: string[] = [];
    await runBackfillCostCli({
      args: ['--start', '2021-08-07', '--end', '2026-08-07'],
      env: { DATABENTO_API_KEY: 'configured-secret' },
      log: (line: string) => lines.push(line),
      fetchImpl: vi.fn()
        .mockResolvedValueOnce(new Response('1', { status: 200 }))
        .mockResolvedValueOnce(new Response('2', { status: 200 })),
    });

    expect(lines.join('\n')).toContain('TOTAL: $3.000000');
    expect(lines.join('\n')).not.toContain('configured-secret');
  });
});
