import { describe, expect, it, vi } from 'vitest';
import {
  consumeTradovatePreflights,
  startTradovatePreflights,
} from '../lib/tradovatePreflightCoordinator';
import type { TradovatePreflightResult } from '../services/tradovateOAuthConnection';

const dataset = (connectionId: string) => ({ connectionId }) as TradovatePreflightResult;

describe('Tradovate preflight coordinator', () => {
  it('reuses a safe prestarted request and starts only newly confirmed IDs', async () => {
    const start = vi.fn(async (connectionId: string) => dataset(connectionId));
    const prestarted = startTradovatePreflights(['cached'], start);
    const received: string[] = [];

    await consumeTradovatePreflights(
      ['cached', 'fresh'],
      start,
      value => received.push(value.connectionId),
      prestarted,
    );

    expect(start.mock.calls.map(([connectionId]) => connectionId)).toEqual(['cached', 'fresh']);
    expect(received).toEqual(['cached', 'fresh']);
  });

  it('publishes a fast connection without waiting for the slowest one', async () => {
    let releaseSlow: ((value: TradovatePreflightResult) => void) | undefined;
    const slow = new Promise<TradovatePreflightResult>(resolve => { releaseSlow = resolve; });
    const received: string[] = [];
    let markFastPublished: (() => void) | undefined;
    const fastPublished = new Promise<void>(resolve => { markFastPublished = resolve; });
    const pending = consumeTradovatePreflights(
      ['slow', 'fast'],
      connectionId => connectionId === 'slow' ? slow : Promise.resolve(dataset('fast')),
      value => {
        received.push(value.connectionId);
        if (value.connectionId === 'fast') markFastPublished?.();
      },
    );

    await fastPublished;
    expect(received).toEqual(['fast']);
    releaseSlow?.(dataset('slow'));
    await pending;
    expect(received).toEqual(['fast', 'slow']);
  });

  it('never publishes an unconfirmed cached connection', async () => {
    const start = vi.fn(async (connectionId: string) => dataset(connectionId));
    const prestarted = startTradovatePreflights(['stale'], start);
    const received: string[] = [];

    await consumeTradovatePreflights(['confirmed'], start, value => {
      received.push(value.connectionId);
    }, prestarted);

    expect(received).toEqual(['confirmed']);
  });
  it('publishes a failed login without waiting for another slow connection', async () => {
    let resolveSlow!: (value: TradovatePreflightResult) => void;
    const slow = new Promise<TradovatePreflightResult>(resolve => { resolveSlow = resolve; });
    const rejected = new Error('tradovate-reauthorization-required');
    const seen: string[] = [];
    const completed = consumeTradovatePreflights(['bad', 'slow'],
      id => id === 'bad' ? Promise.reject(rejected) : slow,
      () => {}, undefined, (id, result) => seen.push(`${id}:${result.status}`));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(seen).toEqual(['bad:rejected']);
    resolveSlow(dataset('slow'));
    await completed;
    expect(seen).toEqual(['bad:rejected', 'slow:fulfilled']);
  });

});
