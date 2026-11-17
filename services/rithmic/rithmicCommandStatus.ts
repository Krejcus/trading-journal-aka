import type { BrokerOrder } from '../brokerPort';
import type { RithmicBrokerPort } from './rithmicBroker';

/** Read-only recovery. A missing order is never proof of cancellation or non-delivery. */
export async function commandStatus(broker: RithmicBrokerPort, command: Record<string, unknown>, symbol: string) {
  const account = broker.accountIds()[0];
  if (!broker.isConnected() || account === undefined || command.account !== broker.accountName(account) || command.symbol !== symbol) return null;
  const epoch = broker.routeEpoch?.(account);
  let order: BrokerOrder | null;
  if (command.originalOp === 'cancel') {
    if (typeof command.orderId !== 'string' || !/^\d{1,30}$/.test(command.orderId)) return null;
    const lookup = await broker.findOrderById(account, command.orderId);
    order = lookup.order;
    if (lookup.completeness !== 'authoritative' || !order || order.brokerOrderId !== command.orderId ||
      order.status !== 'canceled' || order.filledQuantity !== 0 || !/^(ui-|uiprot-|uiflat-)/.test(order.tag ?? '')) return null;
  } else {
    if (!['entry', 'replace-entry'].includes(String(command.originalOp)) ||
      typeof command.clientId !== 'string' || !/^[a-zA-Z0-9_-]{1,30}$/.test(command.clientId)) return null;
    const lookup = await broker.findOrdersByTag(account, 'ui-' + command.clientId);
    if (lookup.completeness !== 'authoritative' || lookup.orders.length !== 1) return null;
    order = lookup.orders[0];
  }
  if (!broker.isConnected() || broker.routeEpoch?.(account) !== epoch || order.symbol !== symbol || order.accountId !== account) return null;
  return { orderId: order.brokerOrderId, status: order.status, quantity: order.quantity, filled: order.filledQuantity };
}
