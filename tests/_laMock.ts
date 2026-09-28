// Probe helper: mock broker, jehož findOrderById vidí i leader ordery vstříknuté přes emitEvent
// (v produkci je Tradovate REST najde; holý mock je nezná a vrací null => umělý fail-closed).
import type { BrokerEvent, BrokerOrder } from '../services/brokerPort';
import { createMockBroker as createRawMockBroker } from '../services/mockBroker';
export { MockBrokerTimeoutError } from '../services/mockBroker';
export type { MockBroker } from '../services/mockBroker';

export const createMockBroker: typeof createRawMockBroker = (options) => {
  const broker = createRawMockBroker(options);
  const emitted = new Map<string, BrokerOrder>();
  const rawEmit = broker.emitEvent.bind(broker);
  const rawFind = broker.findOrderById.bind(broker);
  broker.emitEvent = (event: BrokerEvent) => {
    if (event.type === 'order') emitted.set(`${event.order.accountId}:${event.order.brokerOrderId}`, { ...event.order });
    rawEmit(event);
  };
  broker.findOrderById = async (accountId: number, brokerOrderId: string) => {
    const lookup = await rawFind(accountId, brokerOrderId);
    if (lookup.order) return lookup;
    const seen = emitted.get(`${accountId}:${brokerOrderId}`);
    return seen ? { ...lookup, order: { ...seen } } : lookup;
  };
  return broker;
};

