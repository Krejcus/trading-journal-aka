import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertGatewayEndpoint,
  createReadOnlyIbClient,
  IB_GATEWAY_HOST,
  redactAccountIds,
} from '../services/ibkrMarketData';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const MARKET_DATA_SOURCE = read('../services/ibkrMarketData.ts');
const PRICE_SOURCE = read('../services/ibkrPriceSource.ts');

/** Volání IB API, která posílají příkazy nebo čtou účet, pozice či exekuce. */
const FORBIDDEN = [
  'placeOrder',
  'cancelOrder',
  'reqGlobalCancel',
  'exerciseOptions',
  'reqOpenOrders',
  'reqAllOpenOrders',
  'reqAutoOpenOrders',
  'reqAccountUpdates',
  'reqAccountSummary',
  'reqAccountUpdatesMulti',
  'reqPositions',
  'reqPositionsMulti',
  'reqExecutions',
  'reqPnL',
  'reqManagedAccts',
  'managedAccounts',
  'replaceFA',
  'requestFA',
  'reqIds',
  'nextValidId',
];

describe('IBKR — jen čtení', () => {
  it('sdílený modul ani zdroj ceny nevolají nic, co by poslalo příkaz nebo četlo účet', () => {
    for (const [file, source] of [['ibkrMarketData', MARKET_DATA_SOURCE], ['ibkrPriceSource', PRICE_SOURCE]] as const) {
      for (const name of FORBIDDEN) expect(source, `${file}: ${name}`).not.toContain(name);
      expect(source, file).not.toContain('process.env');
      expect(source, file).not.toMatch(/\bimport\(/);
    }
  });

  it('IBApi vzniká jen ve sdíleném modulu, jednou a jen na 127.0.0.1', () => {
    expect(MARKET_DATA_SOURCE.match(/new IBApi\(/g)).toHaveLength(1);
    expect(PRICE_SOURCE).not.toMatch(/\bIBApi\b/);
    expect(IB_GATEWAY_HOST).toBe('127.0.0.1');
    expect(() => assertGatewayEndpoint('192.168.1.10', 4001)).toThrow();
    expect(() => assertGatewayEndpoint(IB_GATEWAY_HOST, 8080)).toThrow();
    expect(() => assertGatewayEndpoint(IB_GATEWAY_HOST, 4001)).not.toThrow();
    expect(() => createReadOnlyIbClient({ port: 5432, clientId: 1 }, {})).toThrow();
  });

  it('importy: sdílený modul jen @stoqey/ib, zdroj ceny jen ho a sdílený modul — nic z kopírky', () => {
    const imports = (source: string) => [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]);
    expect(imports(MARKET_DATA_SOURCE)).toEqual(['@stoqey/ib']);
    expect([...new Set(imports(PRICE_SOURCE))].sort()).toEqual(['./ibkrMarketData', '@stoqey/ib']);
  });

  it('klient nabízí jen čtecí volání a nepouští ven IBApi ani posluchače', () => {
    const client = createReadOnlyIbClient({ port: 4001, clientId: 91 }, {});
    expect(Object.keys(client).sort()).toEqual([
      'cancelMinuteBars',
      'cancelTrades',
      'cancelVolume',
      'connect',
      'disconnect',
      'isConnected',
      'requestContractDetails',
      'requestMinuteBars',
      'requestRealtimeData',
      'subscribeTrades',
      'subscribeVolume',
    ]);
    expect(Object.isFrozen(client)).toBe(true);
    expect(client.isConnected()).toBe(false);
  });

  it('z hlášek maže čísla účtů', () => {
    expect(redactAccountIds('Account U1234567 and DU7654321 ok')).toBe('Account [account] and [account] ok');
    expect(redactAccountIds('MNQZ6 conId 730283085')).toBe('MNQZ6 conId 730283085');
  });

  it('zdroj ceny nikdy nečte ani nehlásí text chyb Gateway (může nést účet), jen kód', () => {
    expect(PRICE_SOURCE).not.toMatch(/onError:\s*\(code,\s*reqId,\s*message/);
    expect(PRICE_SOURCE).not.toMatch(/lastMessage|message:/);
  });
});
