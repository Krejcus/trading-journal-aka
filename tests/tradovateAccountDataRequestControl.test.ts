import { afterEach, describe, expect, it } from 'vitest';
import { loadTradovateAccountData } from '../server/tradovateAccountData';
import { TradovateRequestControlError } from '../server/tradovateServerRequestControl';

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe('preflight při zamítnutí kontroly dotazů (9. 11. 2026)', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  afterEach(() => { process.off('unhandledRejection', onUnhandled); unhandled.length = 0; });

  it('vyčerpaný rozpočet čtení ukončí bez neodchycené chyby a bez dalších dotazů', async () => {
    process.on('unhandledRejection', onUnhandled);
    const seen: string[] = [];
    let budgetLeft = 2;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname.replace('/v1', '');
      seen.push(path);
      // Seznam účtů odpoví až po zamítnutí globálních seznamů — čtení obohacení
      // tak selže teprve po odmítnutí hlavního Promise.all.
      if (path === '/account/list') { await tick(); return json([{ id: 1, name: 'A1' }, { id: 2, name: 'A2' }]); }
      if (budgetLeft-- > 0) return json([]);
      throw new TradovateRequestControlError('tradovate-request-budget', 1_000);
    }) as typeof fetch;

    await expect(loadTradovateAccountData({ baseUrl: 'https://demo.tradovateapi.com/v1', accessToken: 't', fetchImpl, detail: 'full' }))
      .rejects.toMatchObject({ code: 'tradovate-request-budget' });
    const countAtReject = seen.length;
    await tick(); await tick();
    expect(unhandled).toEqual([]);
    // Po zamítnutí se žádné další čtení účtů nespustí.
    expect(seen.length).toBe(countAtReject);
    expect(seen.filter(path => path.startsWith('/cashBalance/getcashbalancesnapshot'))).toEqual([]);
  });
});
