import { describe, expect, it } from 'vitest';
import { coveredWorkerAccounts, workerConnectionReadPlan, workerCoverageOwners } from '../lib/tradovateWorkerCoverage';
import type { TradovateWorkerAccountCoverage } from '../lib/tradovateRequestControl';
import type { WorkerConnectionDataset } from '../lib/tradovateWorkerCoverage';
const NOW = 1_800_000;
const proof = (id: number, patch: Partial<TradovateWorkerAccountCoverage> = {}): TradovateWorkerAccountCoverage => ({
  accountId: id, connectionId: 'login-a', environment: 'demo', routeEpoch: 7, currentRouteEpoch: 7, sessionId: 'session-a', currentSessionId: 'session-a',
  baselineAt: NOW - 600_000, lastDataAt: NOW - 60_000, observedAt: NOW, socketLive: true, synchronized: true, gap: false, backlog: false, mergeInProgress: false, ...patch,
});
const dataset = (ids = [100, 200]) => ({ connectionId: 'login-a', environment: 'demo', accounts: ids.map(id => ({ id })),
  coverage: { accounts: { availability: 'available', count: ids.length, httpStatus: 200 } } }) as WorkerConnectionDataset;
const receipt = (rows = [proof(100), proof(200)]) => ({ observedAt: NOW, status: { controller: { connected: true, exposure: { streamCoverage: rows } } } });

describe('worker-first read coverage is explicit and fenced', () => {
  it('two independent clients suppress redundant full ticks for the same completely covered baseline', () => {
    for (const client of [receipt(), receipt()]) {
      const plan = workerConnectionReadPlan(dataset(), client, NOW);
      expect(plan.suppressFullTick).toBe(true); expect(plan.uncoveredAccountIds).toEqual([]); expect(plan.covered.size).toBe(2);
    }
  });
  it('partial coverage keeps the independent bulk fallback and only suppresses covered anchors', () => {
    const plan = workerConnectionReadPlan(dataset(), receipt([proof(100)]), NOW);
    expect(plan.suppressFullTick).toBe(false); expect(plan.uncoveredAccountIds).toEqual([200]); expect([...plan.covered.keys()]).toEqual([100]);
    const other = workerConnectionReadPlan({ ...dataset([300]), connectionId: 'login-b' }, receipt(), NOW);
    expect(other.suppressFullTick).toBe(false); expect(other.uncoveredAccountIds).toEqual([300]);
  });
  it('an auto-known leader, successful heartbeat or account missing from baseline never grants coverage', () => {
    expect(workerConnectionReadPlan(dataset(), { observedAt: NOW, status: { controller: { connected: true } } }, NOW).suppressFullTick).toBe(false);
    const incomplete = dataset(); incomplete.coverage.accounts.availability = 'partial';
    expect(workerConnectionReadPlan(incomplete, receipt(), NOW).covered.size).toBe(0);
    expect(workerConnectionReadPlan(dataset([]), receipt(), NOW).suppressFullTick).toBe(false);
  });
  it('rejects stale proof, reconnect/route mismatch, gap, backlog, merge and wrong OAuth/environment', () => {
    const patches: Partial<TradovateWorkerAccountCoverage>[] = [{ observedAt: NOW - 8_001 }, { currentSessionId: 'new-session' }, { currentRouteEpoch: 8 },
      { gap: true }, { backlog: true }, { mergeInProgress: true }, { synchronized: false }, { socketLive: false }, { connectionId: 'login-b' }, { environment: 'live' }];
    for (const patch of patches) expect(coveredWorkerAccounts(receipt([proof(100, patch)]), dataset(), [100], NOW).size).toBe(0);
    expect(coveredWorkerAccounts({ ...receipt(), observedAt: NOW - 8_001 }, dataset(), [100], NOW).size).toBe(0);
  });
  it('an old complete baseline can remain current through continuity, without changing its actual data time', () => {
    const row = proof(100); const original = row.lastDataAt;
    expect(coveredWorkerAccounts(receipt([row]), dataset(), [100], NOW).get(100)?.lastDataAt).toBe(original);
    expect(row.baselineAt).toBe(NOW - 600_000);
  });
  it('duplicate OAuth ownership is ambiguous rather than silently choosing the first route', () => {
    const owners = workerCoverageOwners({ 'login-a': dataset([100]), 'login-b': { ...dataset([100, 200]), connectionId: 'login-b' } });
    expect(owners.has(100)).toBe(false); expect(owners.get(200)?.connectionId).toBe('login-b');
  });
});
