import { describe, expect, it } from 'vitest';
import { createTradovateBroker, TradovateRateLimitError } from '../services/tradovateBroker';

/**
 * Circuit breaker rate limitu: Tradovate po HTTP 429 počítá hodinové okno
 * ZNOVU od každého dalšího pokusu. Jediný „testovací" retry tedy blokaci
 * prodlouží o další hodinu — po 429 se proto žádný request nesmí dotknout
 * sítě, dokud okno nevyprší. `p-ticket` s `p-time` blokuje jen svůj interval.
 */

const harness = (responder: (path: string, hit: number) => { status: number; body: string }) => {
  let now = 1_000_000;
  const hits = new Map<string, number>();
  const broker = createTradovateBroker({
    environment: 'demo',
    accessToken: 'token',
    accountSpecsByAccountId: { 100: 'L' },
    clock: () => now,
    fetchImpl: (async (url: unknown) => {
      const path = new URL(String(url)).pathname;
      const hit = (hits.get(path) ?? 0) + 1;
      hits.set(path, hit);
      const { status, body } = responder(path, hit);
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: () => null },
        json: async () => JSON.parse(body),
        text: async () => body,
      };
    }) as unknown as typeof fetch,
    webSocketFactory: () => {
      throw new Error('test nepoužívá WebSocket');
    },
  });
  const totalHits = () => [...hits.values()].reduce((sum, count) => sum + count, 0);
  return { broker, hits, totalHits, advance: (ms: number) => { now += ms; } };
};

describe('rate limit circuit breaker', () => {
  it('po 429 se další requesty odmítají lokálně bez dotyku sítě', async () => {
    const { broker, totalHits, advance } = harness(() => ({ status: 429, body: '' }));

    await expect(broker.listPositions(100)).rejects.toBeInstanceOf(TradovateRateLimitError);
    const hitsAfterFirst = totalHits();

    // Druhý pokus uvnitř okna: fail-fast, síť nedotčena.
    await expect(broker.listPositions(100)).rejects.toBeInstanceOf(TradovateRateLimitError);
    expect(totalHits()).toBe(hitsAfterFirst);

    // Ani po 59 minutách ne.
    advance(59 * 60_000);
    await expect(broker.listPositions(100)).rejects.toBeInstanceOf(TradovateRateLimitError);
    expect(totalHits()).toBe(hitsAfterFirst);

    // Po vypršení hodiny se request zase pouští na síť.
    advance(2 * 60_000);
    await expect(broker.listPositions(100)).rejects.toBeInstanceOf(TradovateRateLimitError);
    expect(totalHits()).toBeGreaterThan(hitsAfterFirst);
  });

  it('p-ticket v HTTP 200 blokuje jen po dobu p-time', async () => {
    const { broker, totalHits, advance } = harness((path, hit) => (
      hit === 1 && path.endsWith('/position/list')
        ? { status: 200, body: JSON.stringify({ 'p-ticket': 'tk', 'p-time': 5, 'p-message': 'zpomal' }) }
        : { status: 200, body: '[]' }
    ));

    await expect(broker.listPositions(100)).rejects.toBeInstanceOf(TradovateRateLimitError);
    const hitsAfterFirst = totalHits();

    // Uvnitř p-time: lokální odmítnutí.
    await expect(broker.listPositions(100)).rejects.toBeInstanceOf(TradovateRateLimitError);
    expect(totalHits()).toBe(hitsAfterFirst);

    // Po p-time projde normálně.
    advance(6_000);
    await expect(broker.listPositions(100)).resolves.toEqual([]);
    expect(totalHits()).toBeGreaterThan(hitsAfterFirst);
  });
});
