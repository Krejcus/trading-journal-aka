import { describe, expect, it } from 'vitest';
import {
  applyTradovateConnectionDataRefresh,
  buildTradovateConnectionSummaries,
  readTradovateConnectionShell,
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
