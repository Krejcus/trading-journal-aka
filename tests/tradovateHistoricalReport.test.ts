import { describe, expect, it, vi } from 'vitest';
import { requestTradovatePerformanceReport } from '../server/tradovateHistoricalReport';

describe('Tradovate Performance report', () => {
  it('odesílá pouze read-only CSV report s přesnými parametry', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response('Account,P/L\r\n61887494,16.50\r\n', {
      status: 200,
      headers: { 'Content-Type': 'text/csv' },
      });
    }) as unknown as typeof fetch;
    const result = await requestTradovatePerformanceReport({
      environment: 'demo',
      accessToken: 'secret',
      accountId: 61887494,
      accountSpec: 'TDFYG50549979811',
      startDate: '08/13/2026',
      endDate: '08/15/2026',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://rpt-demo.tradovateapi.com/v1/reports/requestReport',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(String(capturedInit?.body))).toEqual({
      name: 'Performance',
      representationType: 'csv',
      timezone: -300,
      params: [
        { name: 'startDate', value: '08/13/2026' },
        { name: 'endDate', value: '08/15/2026' },
        { name: 'account', value: 'TDFYG50549979811' },
      ],
    });
    expect(result).toMatchObject({ status: 'available', columns: ['Account', 'P/L'], rowCount: 1, rows: [['61887494', '16.50']] });
  });

  it('správně parsuje čárky a nové řádky v uvozovkách', async () => {
    const result = await requestTradovatePerformanceReport({
      environment: 'demo', accessToken: 'secret', accountId: 1, accountSpec: 'DEMO1',
      startDate: '08/13/2026', endDate: '08/15/2026',
      fetchImpl: (async () => new Response('A,B\n"one,two","line 1\nline 2"\n')) as typeof fetch,
    });
    expect(result.rows).toEqual([['one,two', 'line 1\nline 2']]);
  });

  it('vrací bezpečnou diagnostiku při odmítnutí', async () => {
    const result = await requestTradovatePerformanceReport({
      environment: 'demo', accessToken: 'secret', accountId: 1, accountSpec: 'DEMO1',
      startDate: '08/13/2026', endDate: '08/15/2026',
      fetchImpl: (async () => new Response('Access denied', { status: 403 })) as typeof fetch,
    });
    expect(result).toMatchObject({ status: 'forbidden', httpStatus: 403, diagnostic: 'Access denied' });
  });

  it('rozpozná Tradovate chybu vrácenou uvnitř HTTP 200', async () => {
    const result = await requestTradovatePerformanceReport({
      environment: 'demo', accessToken: 'secret', accountId: 1, accountSpec: 'DEMO1',
      startDate: '08/13/2026', endDate: '08/15/2026',
      fetchImpl: (async () => new Response('{"errorText":"account is not found (ID:0)"}', { status: 200 })) as typeof fetch,
    });
    expect(result).toMatchObject({ status: 'invalid-response', httpStatus: 200, diagnostic: 'account is not found (ID:0)' });
  });

  it('bere živou prázdnou HTTP 200 JSON obálku jako interval bez obchodů', async () => {
    const result = await requestTradovatePerformanceReport({
      environment: 'demo', accessToken: 'secret', accountId: 1, accountSpec: 'DEMO1',
      startDate: '01/01/2010', endDate: '07/20/2010',
      fetchImpl: (async () => new Response(JSON.stringify({ data: '\r\n' }), { status: 200 })) as typeof fetch,
    });
    expect(result).toMatchObject({
      status: 'available', httpStatus: 200, columns: [], rowCount: 0, rows: [], diagnostic: null,
    });
  });

  it('rozbalí CSV z reálného Tradovate JSON data obalu', async () => {
    const result = await requestTradovatePerformanceReport({
      environment: 'demo', accessToken: 'secret', accountId: 1, accountSpec: 'DEMO1',
      startDate: '08/13/2026', endDate: '08/15/2026',
      fetchImpl: (async () => new Response(JSON.stringify({ data: 'symbol,qty,pnl\r\nMNQU6,7,$10.50\r\n' }), { status: 200 })) as typeof fetch,
    });
    expect(result).toMatchObject({ status: 'available', columns: ['symbol', 'qty', 'pnl'], rowCount: 1, rows: [['MNQU6', '7', '$10.50']] });
  });
});
