// 2. 11. 2026: front kontrakt podle brokera jako původ kontraktu Limit/Stop bez IBKR.
import { afterEach, describe, expect, it } from 'vitest';
import type { BrokerAccountRiskSnapshot } from '../services/brokerPort';
import { bootstrapCopierRuntime, type CopierRuntimeController } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { manualOnlyDemoSafety, type CopyGroupConfig } from '../services/liveCopyTrading';
import { createMockBroker } from '../services/mockBroker';
import { buildLeaderEntryPreviewCommand } from '../lib/leaderEntryPreview';
import { buildLeaderEntryPlaceCommand } from '../lib/leaderEntryPlace';

const LEADER = 61038658;
const START = Date.UTC(2026, 10, 2, 2, 0, 0);
const group = (): CopyGroupConfig => ({ id: `manual-demo-${LEADER}`, name: 'Ruční DEMO test', enabled: true, leaderAccountId: LEADER,
  followers: [], localOnly: true, manualOnly: true, manualEntryMaxContracts: 5, safety: manualOnlyDemoSafety() });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let active: CopierRuntimeController | null = null;
afterEach(() => { active?.stop(); active = null; });

describe('front kontrakt podle brokera', () => {
  it('status ho nese a Limit bez IBKR s ním odejde; Market ne', { timeout: 30_000 }, async () => {
    const clock = { now: START };
    const broker = createMockBroker({ behavior: () => ({ kind: 'working' }), accountRiskSnapshots: [{
      accountId: LEADER, at: START + 500, realizedPnlUsd: 0, openPnlUsd: 0, netLiq: 50_000, minNetLiq: null, dailyLossAutoLiq: null, trailingMaxDrawdown: null,
    } as unknown as BrokerAccountRiskSnapshot] });
    const calls: Array<[string, number]> = [];
    (broker as { frontContract?: (root: string, accountId: number) => Promise<{ contract: string; expiration: string | null }> }).frontContract = async (root, accountId) => {
      calls.push([root, accountId]);
      return { contract: 'MNQZ6', expiration: '2026-12-18T00:00' };
    };
    const controller = await bootstrapCopierRuntime({ broker, store: createMemoryCopierStore(), group: group(), clock: () => clock.now, osoCorrelationWindowMs: 50,
      manualEntryTimingsMs: { post: 300, start: 500, legWait: 300 }, manualEntryQuote: () => null });
    active = controller;
    broker.setConnected(true);
    await controller.waitForIdle();
    await controller.reconcile();
    controller.arm();
    await controller.waitForIdle();
    clock.now = START + 1_000;
    // První čtení po připojení (interval 15 s; v testu hodiny workeru stojí, čeká se reálně).
    await sleep(15_300);
    expect(calls[0]).toEqual(['MNQ', LEADER]);
    expect(controller.status().brokerFrontContract).toMatchObject({ contract: 'MNQZ6' });
    const status = controller.status();
    const build = (draft: Parameters<typeof buildLeaderEntryPreviewCommand>[0], id: string) => buildLeaderEntryPlaceCommand(buildLeaderEntryPreviewCommand(draft,
      { group: { ...group(), leaderAccountId: LEADER }, armedAt: status.armedAt ?? 0, excludedFollowers: new Set(), participation: [], operationId: `preview:${id}` }), `entry:${id}`);
    const market = await controller.placeLeaderEntry(build({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Market', referencePrice: 25_000, quoteReceivedAt: clock.now - 200, stopLoss: 24_990, takeProfit: 25_020 }, 'frontmkt01'), { deadlineAt: clock.now + 15_000 });
    expect(market.blockers.map(issue => issue.code)).toContain('contract-unverified');
    const limit = await controller.placeLeaderEntry(build({ symbol: 'MNQZ6', side: 'Buy', quantity: 1, orderType: 'Limit', price: 24_900, stopLoss: 24_890, takeProfit: 24_950 }, 'frontlmt01'), { deadlineAt: clock.now + 15_000 });
    expect(limit.status).toBe('acknowledged');
    const wrong = await controller.placeLeaderEntry(build({ symbol: 'MNQH7', side: 'Buy', quantity: 1, orderType: 'Limit', price: 24_900, stopLoss: 24_890, takeProfit: 24_950 }, 'frontlmt02'), { deadlineAt: clock.now + 20_000 });
    expect(wrong.status).toBe('blocked');
    expect(broker.placedOsoRequests()).toHaveLength(1);
  });
});
