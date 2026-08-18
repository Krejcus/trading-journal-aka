import { describe, expect, it } from 'vitest';
import { createCopierRuntimeCommandAdapter } from '../services/copierRuntimeCommandAdapter';
import { bootstrapCopierRuntime } from '../services/copierRuntimeController';
import { createMemoryCopierStore } from '../services/copierStore';
import { createMockBroker } from '../services/mockBroker';
import type { CopyGroupConfig } from '../services/liveCopyTrading';

const initialGroup: CopyGroupConfig = {
  id: 'g1', name: 'Test', enabled: true, leaderAccountId: 100,
  followers: [{ accountId: 200, mode: 'on-submit', multiplier: 1 }],
};

describe('createCopierRuntimeCommandAdapter', () => {
  it('propíše násobek do živého runtime a explicitní Flatten předá s operationId', async () => {
    const broker = createMockBroker({ behavior: () => ({ kind: 'fill', price: 30_000 }) });
    await broker.placeOrder({
      tag: 'seed-position', accountId: 200, symbol: 'MNQU6', side: 'Buy', quantity: 1, orderType: 'Market',
    });
    const controller = await bootstrapCopierRuntime({
      broker, store: createMemoryCopierStore(), group: initialGroup,
    });
    broker.setConnected(true);
    await controller.waitForIdle();
    let group = initialGroup;
    const adapter = createCopierRuntimeCommandAdapter({
      controller,
      getGroup: () => group,
      setGroup: next => { group = next; },
    });

    await adapter.execute({ type: 'set-multiplier', groupId: 'g1', accountId: 200, multiplier: 2 });
    expect(group.followers[0].multiplier).toBe(2);

    await adapter.execute({
      type: 'flatten-account', groupId: 'g1', accountId: 200,
      operationId: 'adapter-flat-001',
    });
    expect(await broker.listPositions(200)).toEqual([expect.objectContaining({ netQuantity: 0 })]);
    expect(controller.status()).toMatchObject({ armed: false, reconciliationRequired: true });
    controller.stop();
  });
});
