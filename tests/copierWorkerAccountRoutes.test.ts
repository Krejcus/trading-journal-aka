import { describe, expect, it } from 'vitest';
import {
  buildCopierWorkerAccountRoutes,
  copierWorkerMissingAccountIds,
  copierWorkerAccountSelectionBlocked,
} from '../lib/copierWorkerAccountRoutes';
import type { LocalCopierAgentStatus } from '../lib/localCopierAgentProtocol';

const status = (patch: Partial<LocalCopierAgentStatus> = {}) => ({
  version: 1,
  environment: 'demo',
  nonce: 'test',
  startedAt: '2026-09-28T12:00:00.000Z',
  ...patch,
}) as LocalCopierAgentStatus;

const connections = {
  lucid: { accounts: [{ id: 11 }, { id: 44 }] },
  fn: { accounts: [{ id: 22 }, { id: 44 }] },
  tradeify: { accounts: [{ id: 33 }] },
};

describe('copier worker account routes', () => {
  it('spojí OAuth účet s čerstvým devices manifestem a neháda nejednoznačné vlastnictví', () => {
    const result = buildCopierWorkerAccountRoutes(status({
      devices: [{ state: 'paired', deviceId: 'd1', deviceName: 'Mac', connectionId: 'lucid' }],
    }), true, connections);

    expect(result.known).toBe(true);
    expect(result.routes.get(11)).toBe('routable');
    expect(result.routes.get(22)).toBe('missing-worker');
    expect(result.routes.get(33)).toBe('missing-worker');
    expect(result.routes.get(44)).toBe('unknown');
  });

  it('připojení, které si worker načetl sám přes souhlas, je routable (4. 10.)', () => {
    const result = buildCopierWorkerAccountRoutes(status({
      devices: [{ state: 'paired', deviceId: 'd1', deviceName: 'Mac', connectionId: 'lucid' }],
      connectionDiscovery: {
        scope: 'owner', deviceId: 'd1', loadedConnectionIds: ['lucid', 'fn'], pendingConnectionIds: ['tradeify'], failedConnections: [],
      },
    }), true, connections);
    expect(result.routes.get(22)).toBe('routable');
    expect(result.routes.get(33)).toBe('missing-worker');
  });

  it('starší worker může doložit obsluhované spojení přes connectionUsage', () => {
    const result = buildCopierWorkerAccountRoutes(status({
      connectionUsage: [{ connectionId: 'fn' } as LocalCopierAgentStatus['connectionUsage'][number]],
    }), true, connections);
    expect(result.known).toBe(true);
    expect(result.routes.get(22)).toBe('routable');
    expect(result.routes.get(11)).toBe('missing-worker');
  });

  it('čerstvý prázdný nebo nepárovaný manifest je známý a účty označí jako chybějící', () => {
    const empty = buildCopierWorkerAccountRoutes(status({ devices: [] }), true, connections);
    expect(empty.known).toBe(true);
    expect(empty.routes.get(11)).toBe('missing-worker');

    const pairingRequired = buildCopierWorkerAccountRoutes(status({
      devices: [{ state: 'pairing-required', deviceId: 'd1', deviceName: 'Mac', connectionId: 'lucid' }],
    }), true, connections);
    expect(pairingRequired.routes.get(11)).toBe('missing-worker');
  });

  it('nečerstvý nebo nedoložený status nic neblokuje; vybraný chybějící účet jde odebrat', () => {
    const unknown = buildCopierWorkerAccountRoutes(status({ devices: [] }), false, connections);
    expect(unknown.known).toBe(false);
    expect([...unknown.routes.values()].every(route => route === 'unknown')).toBe(true);
    expect(copierWorkerAccountSelectionBlocked('missing-worker', false)).toBe(true);
    expect(copierWorkerAccountSelectionBlocked('missing-worker', true)).toBe(false);
    expect(copierWorkerAccountSelectionBlocked('unknown', false)).toBe(false);
  });

  it('vrátí všechny vybrané účty chybějící v workeru bez duplicit', () => {
    const routes = buildCopierWorkerAccountRoutes(status({
      devices: [{ state: 'paired', deviceId: 'd1', deviceName: 'Mac', connectionId: 'lucid' }],
    }), true, connections);
    expect(copierWorkerMissingAccountIds(routes, [11, 22, 33, 22, null])).toEqual([22, 33]);
  });
});
