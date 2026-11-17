import type { RithmicBrokerPort } from './rithmicBroker';

/** Only a matching broker order proves an entry reached the broker. Absence is inconclusive. */
export async function commandStatus(broker: RithmicBrokerPort, command: Record<string, unknown>, symbol: string) {
  const account = broker.accountIds()[0];
  const epoch = broker.routeEpoch?.(account);
  if (!broker.isConnected() || account === undefined || command.account !== broker.accountName(account) || command.symbol !== symbol ||
      !['entry', 'replace-entry'].includes(String(command.originalOp)) ||
      typeof command.clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,30}$/.test(command.clientId)) return null;
  const result = await broker.findOrdersByTag(account, 'ui-' + command.clientId);
  if (!broker.isConnected() || broker.routeEpoch?.(account) !== epoch) return null;
  if (result.completeness !== 'authoritative' || result.orders.length !== 1) return null;
  const order = result.orders[0];
  if (order.symbol !== symbol || order.accountId !== account) return null;
  return { orderId: order.brokerOrderId, status: order.status, quantity: order.quantity, filled: order.filledQuantity };
}
