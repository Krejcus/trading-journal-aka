import { describe, expect, it } from 'vitest';
import {
  applyTradovateConnectionDataRefresh,
  buildTradovateConnectionSummaries,
  readTradovateConnectionDataCache,
  readTradovateConnectionShell,
  TRADOVATE_LIVE_DATA_CACHE_MAX_AGE_MS,
  writeTradovateConnectionDataCache,
  writeTradovateConnectionShell,
} from '../lib/tradovateLiveConnectionCache';
import type { TradovateOAuthStatus, TradovatePreflightResult } from '../services/tradovateOAuthConnection';

const status: TradovateOAuthStatus = {
  connected: true,
  environment: 'demo',
  connections: [{
    id: 'connection-1',
    connected: true,
    environment: 'demo',
    expiresAt: '2026-08-16T12:00:00.000Z',
    hasRefreshToken: true,
    connectedAt: '2026-08-15T12:00:00.000Z',
    refreshedAt: '2026-08-16T10:00:00.000Z',
    tradovateUserId: 123,
    tradovateEmail: 'private@example.com',
    organizationName: null,
    disconnectedAt: null,
    disconnectReason: null,
  }],
};

describe('Tradovate LIVE connection shell cache', () => {
  it('restores the connected shell without persisting identity or token metadata', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const summaries = { 'connection-1': { accountCount: 5, organizationName: 'Tradeify' } };

    writeTradovateConnectionShell('user-1', status, summaries, storage);
    const restored = readTradovateConnectionShell('user-1', storage);

    expect(restored?.status.connected).toBe(true);
    expect(restored?.status.connections[0].tradovateEmail).toBeNull();
    expect(restored?.status.connections[0].tradovateUserId).toBeNull();
    expect(restored?.status.connections[0].hasRefreshToken).toBe(false);
    expect(restored?.summaries['connection-1']).toEqual(summaries['connection-1']);
  });

  it('keeps the last account count until fresh preflight data arrives', () => {
    expect(buildTradovateConnectionSummaries(status, {}, [], {
      'connection-1': { accountCount: 5, organizationName: 'Tradeify' },
    })).toEqual({
      'connection-1': { accountCount: 5, organizationName: 'Tradeify' },
    });
  });

  it('prefers fresh account data over the cached count', () => {
    const dataset = {
      accounts: [{ id: 1 }, { id: 2 }],
    } as unknown as TradovatePreflightResult;
    expect(buildTradovateConnectionSummaries(status, { 'connection-1': dataset }, [], {
      'connection-1': { accountCount: 5, organizationName: 'Tradeify' },
    })['connection-1'].accountCount).toBe(2);
  });

  it('keeps unrelated broker connections during a partial post-close refresh', () => {
    const tradeify = {
      connectionId: 'connection-tradeify',
      accounts: [{ id: 1, balance: 50_000 }],
    } as unknown as TradovatePreflightResult;
    const updatedTradeify = {
      connectionId: 'connection-tradeify',
      accounts: [{ id: 1, balance: 49_900 }],
    } as unknown as TradovatePreflightResult;
    const lucid = {
      connectionId: 'connection-lucid',
      accounts: [{ id: 2, balance: 50_000 }],
    } as unknown as TradovatePreflightResult;

    const refreshed = applyTradovateConnectionDataRefresh({
      [tradeify.connectionId]: tradeify,
      [lucid.connectionId]: lucid,
    }, [updatedTradeify], 'merge');

    expect(refreshed['connection-tradeify']).toBe(updatedTradeify);
    expect(refreshed['connection-lucid']).toBe(lucid);
  });

  it('still removes absent connections during a complete refresh', () => {
    const tradeify = {
      connectionId: 'connection-tradeify',
      accounts: [{ id: 1 }],
    } as unknown as TradovatePreflightResult;
    const lucid = {
      connectionId: 'connection-lucid',
      accounts: [{ id: 2 }],
    } as unknown as TradovatePreflightResult;

    const refreshed = applyTradovateConnectionDataRefresh({
      [tradeify.connectionId]: tradeify,
      [lucid.connectionId]: lucid,
    }, [tradeify], 'replace');

    expect(refreshed).toEqual({ 'connection-tradeify': tradeify });
  });
});

describe('Tradovate LIVE connection data cache', () => {
  const now = Date.parse('2026-08-27T12:00:00.000Z');
  const makeStorage = () => {
    const values = new Map<string, string>();
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      values,
    };
  };
  const dataset = (capturedAt: string): TradovatePreflightResult => ({
    connectionId: 'connection-1',
    environment: 'demo',
    capturedAt,
    accounts: [{ id: 1 }],
    contracts: [],
    coverage: {},
    historicalSync: { status: 'available' },
  } as unknown as TradovatePreflightResult);

  it('restores a fresh snapshot for instant card rendering after reload', () => {
    const storage = makeStorage();
    const data = { 'connection-1': dataset('2026-08-27T11:59:00.000Z') };

    writeTradovateConnectionDataCache('user-1', data, storage, now);
    const restored = readTradovateConnectionDataCache('user-1', storage, now);

    expect(restored).toEqual(data);
  });

  it('rejects a snapshot whose broker data is older than the reconciliation window', () => {
    const storage = makeStorage();
    const staleCapturedAt = new Date(now - TRADOVATE_LIVE_DATA_CACHE_MAX_AGE_MS - 1_000).toISOString();
    writeTradovateConnectionDataCache('user-1', { 'connection-1': dataset(staleCapturedAt) }, storage, now);

    expect(readTradovateConnectionDataCache('user-1', storage, now)).toBeNull();
  });

  it('does not resurrect stale data through re-saved savedAt timestamps', () => {
    const storage = makeStorage();
    const capturedAt = new Date(now - TRADOVATE_LIVE_DATA_CACHE_MAX_AGE_MS + 60_000).toISOString();
    const data = { 'connection-1': dataset(capturedAt) };
    writeTradovateConnectionDataCache('user-1', data, storage, now);
    // Hydratace zapisuje tatáž data znovu s novým savedAt — freshness ale
    // musí dál řídit capturedAt broker snapshotu.
    writeTradovateConnectionDataCache('user-1', data, storage, now + 5 * 60_000);

    expect(readTradovateConnectionDataCache('user-1', storage, now + 5 * 60_000)).toBeNull();
  });

  it('clears the snapshot when the last connection disconnects', () => {
    const storage = makeStorage();
    writeTradovateConnectionDataCache('user-1', { 'connection-1': dataset('2026-08-27T11:59:00.000Z') }, storage, now);
    writeTradovateConnectionDataCache('user-1', {}, storage, now);

    expect(readTradovateConnectionDataCache('user-1', storage, now)).toBeNull();
  });

  it('drops only the stale connection when another one is fresh', () => {
    const storage = makeStorage();
    const fresh = dataset('2026-08-27T11:59:00.000Z');
    const staleCapturedAt = new Date(now - TRADOVATE_LIVE_DATA_CACHE_MAX_AGE_MS - 1_000).toISOString();
    const stale = { ...dataset(staleCapturedAt), connectionId: 'connection-2' };
    writeTradovateConnectionDataCache('user-1', {
      'connection-1': fresh,
      'connection-2': stale,
    }, storage, now);

    // Čerstvé připojení nesmí protáhnout do UI výrazně starší dataset
    // jiného připojení — každý se posuzuje samostatně.
    expect(readTradovateConnectionDataCache('user-1', storage, now)).toEqual({ 'connection-1': fresh });
  });

  it('rejects malformed datasets and other users', () => {
    const storage = makeStorage();
    writeTradovateConnectionDataCache('user-1', {
      'connection-1': { connectionId: 'connection-2' } as unknown as TradovatePreflightResult,
    }, storage, now);

    expect(readTradovateConnectionDataCache('user-1', storage, now)).toBeNull();
    expect(readTradovateConnectionDataCache('user-2', storage, now)).toBeNull();
    expect(readTradovateConnectionDataCache('user-1', undefined, now)).toBeNull();
  });
});
