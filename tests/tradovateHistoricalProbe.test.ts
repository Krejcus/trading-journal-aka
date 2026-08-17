import { describe, expect, it, vi } from 'vitest';
import {
  probeTradovateHistoricalSync,
  tradovateReportBaseUrl,
} from '../server/tradovateHistoricalProbe';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('Tradovate historical reporting capability', () => {
  it('použije správnou reporting doménu podle prostředí', () => {
    expect(tradovateReportBaseUrl('demo')).toBe('https://rpt-demo.tradovateapi.com/v1');
    expect(tradovateReportBaseUrl('live')).toBe('https://rpt-live.tradovateapi.com/v1');
  });

  it('rozpozná dostupné historické reporty bez generování reportu', async () => {
    const fetchImpl = vi.fn(async () => json([
      { name: 'Performance', params: [{ name: 'startDate', paramType: 'Date', optional: false }] },
      { name: 'Orders', params: [{ name: 'account', paramType: 'accounts', optional: false }] },
      { name: 'Cash History', params: [] },
      { name: 'Account Balance History', params: [] },
    ])) as unknown as typeof fetch;

    const capability = await probeTradovateHistoricalSync({
      environment: 'demo',
      accessToken: 'secret-token',
      fetchImpl,
      now: Date.parse('2026-08-15T12:00:00Z'),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://rpt-demo.tradovateapi.com/v1/reports/requestReportDefinitions',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(capability).toMatchObject({
      status: 'available',
      httpStatus: 200,
      definitionCount: 4,
      supportsPerformance: true,
      supportsOrders: true,
      supportsCashHistory: true,
      supportsAccountBalanceHistory: true,
    });
    expect(capability.reports[0].parameters[0]).toEqual({
      name: 'startDate',
      paramType: 'Date',
      optional: false,
    });
  });

  it('rozpozná definice v objektovém obalu a bezpečně popíše strukturu', async () => {
    const capability = await probeTradovateHistoricalSync({
      environment: 'demo',
      accessToken: 'secret-token',
      fetchImpl: (async () => json({ reportDefinitions: [{ name: 'Performance', params: [] }], requestId: 'x' })) as typeof fetch,
    });
    expect(capability).toMatchObject({
      status: 'available',
      definitionCount: 1,
      responseShape: {
        kind: 'object',
        topLevelKeys: ['reportDefinitions', 'requestId'],
        arrayKeys: ['reportDefinitions'],
      },
    });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not-found'],
    [500, 'unavailable'],
  ] as const)('převede HTTP %s na bezpečný stav %s', async (status, expected) => {
    const capability = await probeTradovateHistoricalSync({
      environment: 'demo',
      accessToken: 'secret-token',
      fetchImpl: (async () => json({}, status)) as typeof fetch,
    });
    expect(capability).toMatchObject({ status: expected, httpStatus: status, definitionCount: 0 });
  });

  it('síťová chyba nezastaví standardní read-only preflight', async () => {
    const capability = await probeTradovateHistoricalSync({
      environment: 'demo',
      accessToken: 'secret-token',
      fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch,
    });
    expect(capability).toMatchObject({ status: 'unavailable', httpStatus: null });
  });
});
