import { describe, expect, it } from 'vitest';
import {
  applyTradovateConnectionDataRefresh,
  buildTradovateConnectionSummaries,
  readTradovateConnectionShell,
  writeTradovateConnectionShell,
} from '../lib/tradovateLiveConnectionCache';
import type { TradovateOAuthStatus, TradovatePreflightResult } from '../services/tradovateOAuthConnection';
import type { TradovateAccountProfile } from '../lib/tradovateAccountProfileTypes';

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
  it.each([null, undefined, '', '   '])('handles a missing prop firm (%s) without crashing LIVE', propFirm => {
    const dataset = { accounts: [{ id: 1 }, { id: 2 }, { id: 3 }] } as unknown as TradovatePreflightResult;
    const profiles = [
      { externalAccountId: '1', propFirm },
      { externalAccountId: '2', propFirm: ' Tradeify ' },
      { externalAccountId: '3', propFirm: 'Tradeify' },
      { externalAccountId: '99', propFirm: 'Lucid' },
    ] as TradovateAccountProfile[];
    expect(buildTradovateConnectionSummaries(status, { 'connection-1': dataset }, profiles)).toEqual({
      'connection-1': { accountCount: 3, organizationName: 'Tradeify' },
    });
  });

  it('preserves organization fallbacks when no account has a prop firm', () => {
    const dataset = { accounts: [{ id: 1 }] } as unknown as TradovatePreflightResult;
    const profiles = [{ externalAccountId: '1', propFirm: null }] as TradovateAccountProfile[];
    const data = { 'connection-1': dataset };
    const previous = { 'connection-1': { accountCount: 9, organizationName: 'Cached firm' } };
    const brokerStatus = { ...status, connections: [{ ...status.connections[0], organizationName: 'Broker organization' }] };
    expect(buildTradovateConnectionSummaries(brokerStatus, data, profiles, previous)['connection-1'])
      .toEqual({ accountCount: 1, organizationName: 'Broker organization' });
    expect(buildTradovateConnectionSummaries(status, data, profiles, previous)['connection-1'])
      .toEqual({ accountCount: 1, organizationName: 'Cached firm' });
    expect(buildTradovateConnectionSummaries(status, data, profiles)['connection-1'])
      .toEqual({ accountCount: 1, organizationName: null });
  });

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

  it('renders all connections when a newly added prop account has no firm yet', () => {
    const connections = ['tradeify', 'lucid', 'new-prop'].map(id => ({ ...status.connections[0], id }));
    const data = Object.fromEntries(connections.map((connection, index) => [connection.id, {
      connectionId: connection.id, accounts: [{ id: index + 1 }],
    } as TradovatePreflightResult]));
    const profiles = ['Tradeify', 'Lucid', null].map((propFirm, index) => ({
      externalAccountId: String(index + 1), propFirm,
    } as TradovateAccountProfile));

    expect(buildTradovateConnectionSummaries({ ...status, connections }, data, profiles)).toEqual({
      tradeify: { accountCount: 1, organizationName: 'Tradeify' },
      lucid: { accountCount: 1, organizationName: 'Lucid' },
      'new-prop': { accountCount: 1, organizationName: null },
    });
  });

  it('ignores unset or blank firms and keeps the existing organization fallback', () => {
    const dataset = { accounts: [{ id: 1 }, { id: 2 }] } as TradovatePreflightResult;
    const profiles = [null, '   '].map((propFirm, index) => ({
      externalAccountId: String(index + 1), propFirm,
    } as TradovateAccountProfile));
    expect(buildTradovateConnectionSummaries(status, { 'connection-1': dataset }, profiles, {
      'connection-1': { accountCount: 2, organizationName: 'Known organization' },
    })['connection-1']).toEqual({ accountCount: 2, organizationName: 'Known organization' });

    profiles[1].propFirm = ' Lucid ';
    expect(buildTradovateConnectionSummaries(status, { 'connection-1': dataset }, profiles)['connection-1'])
      .toEqual({ accountCount: 2, organizationName: 'Lucid' });
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
