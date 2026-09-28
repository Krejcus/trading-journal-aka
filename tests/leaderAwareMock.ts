// Test-only adapter: the production broker can look up leader orders that
// arrived over the stream. The raw mock stores only orders created through
// its own write API, so a standalone protective-order check would otherwise
// exercise a mock limitation instead of the runtime path under test.
import type { BrokerEvent, BrokerOrder } from '../services/brokerPort';
import { createMockBroker as createRawMockBroker } from '../services/mockBroker';

export type { MockBroker } from '../services/mockBroker';

export const createLeaderAwareMockBroker: typeof createRawMockBroker = options => {
  const broker = createRawMockBroker(options);
  const streamedOrders = new Map<string, BrokerOrder>();
  const rawEmit = broker.emitEvent.bind(broker);
  const rawFind = broker.findOrderById.bind(broker);

  broker.emitEvent = (event: BrokerEvent) => {
    if (event.type === 'order') {
      streamedOrders.set(
        `${event.order.accountId}:${event.order.brokerOrderId}`,
        { ...event.order },
      );
    }
    rawEmit(event);
  };
  broker.findOrderById = async (accountId: number, brokerOrderId: string) => {
    const lookup = await rawFind(accountId, brokerOrderId);
    if (lookup.order) return lookup;
    const streamed = streamedOrders.get(`${accountId}:${brokerOrderId}`);
    return streamed ? { ...lookup, order: { ...streamed } } : lookup;
  };

  return broker;
};
