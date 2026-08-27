import { isOpenOrderStatus, type BrokerOrderRequest, type BrokerPort, type OrderSide } from './brokerPort';

/**
 * Poslední autoritativní ochrana celkové expozice přímo před side effectem.
 * Strop není limit jedné objednávky: započítá aktuální pozici i všechny
 * working orders na obou stranách. Celou objednávku buď pustí, nebo ji
 * fail-closed odmítne; množství nikdy potichu nezkracuje.
 */
export function createExposureCappedBroker(
  broker: BrokerPort,
  maxContractsFor: (accountId: number) => number | undefined,
): BrokerPort {
  const assertWithinCap = async (
    request: Pick<BrokerOrderRequest, 'accountId' | 'symbol' | 'side' | 'quantity'>,
    excludeOrderId?: string,
  ) => {
    const rawCap = maxContractsFor(request.accountId);
    if (rawCap == null) return;
    const cap = Math.floor(rawCap);
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error('Neplatný maxContracts strop');
    const [positions, orders] = await Promise.all([
      broker.listPositions(request.accountId),
      broker.listOrders(request.accountId),
    ]);
    const current = positions.find(item => item.symbol === request.symbol)?.netQuantity ?? 0;
    const pending = orders
      .filter(order => order.brokerOrderId !== excludeOrderId
        && order.symbol === request.symbol
        && isOpenOrderStatus(order.status))
      .reduce((totals, order) => {
        totals[order.side] += Math.max(0, order.quantity - order.filledQuantity);
        return totals;
      }, { Buy: 0, Sell: 0 } as Record<OrderSide, number>);
    const candidateBuy = request.side === 'Buy' ? request.quantity : 0;
    const candidateSell = request.side === 'Sell' ? request.quantity : 0;
    // Hodnotíme oba krajní scénáře. Sell, který dnes jen zavírá long, může
    // spolu s jiným working Sellem zítra pozici přetočit do shortu.
    const worstLong = current + pending.Buy + candidateBuy;
    const worstShort = current - pending.Sell - candidateSell;
    if (worstLong > cap || worstShort < -cap) {
      throw new Error(
        `maxContracts blokoval účet ${request.accountId}: current=${current}, pendingBuy=${pending.Buy}, pendingSell=${pending.Sell}, request=${request.side}:${request.quantity}, worstLong=${worstLong}, worstShort=${worstShort}, cap=${cap}`,
      );
    }
  };

  return {
    environment: broker.environment,
    async placeOrder(request) {
      try {
        await assertWithinCap(request);
      } catch (error) {
        return {
          brokerOrderId: '',
          accepted: false,
          definitive: true,
          rejectReason: error instanceof Error ? error.message : String(error),
        };
      }
      return broker.placeOrder(request);
    },
    liquidatePosition: broker.liquidatePosition
      ? request => broker.liquidatePosition!(request)
      : undefined,
    async placeOco(request) {
      if (!broker.placeOco) throw new Error('Broker nepodporuje nativní OCO');
      try {
        await assertWithinCap({ ...request, side: request.first.side });
        await assertWithinCap({ ...request, side: request.second.side });
      } catch (error) {
        return {
          firstBrokerOrderId: '',
          secondBrokerOrderId: '',
          accepted: false,
          definitive: true,
          rejectReason: error instanceof Error ? error.message : String(error),
        };
      }
      return broker.placeOco(request);
    },
    async placeOso(request) {
      if (!broker.placeOso) throw new Error('Broker nepodporuje nativní OSO');
      try {
        await assertWithinCap(request);
      } catch (error) {
        return {
          entryBrokerOrderId: '',
          firstBrokerOrderId: '',
          secondBrokerOrderId: '',
          accepted: false,
          definitive: true,
          rejectReason: error instanceof Error ? error.message : String(error),
        };
      }
      return broker.placeOso(request);
    },
    cancelOrder: (accountId, brokerOrderId) => broker.cancelOrder(accountId, brokerOrderId),
    async modifyOrder(accountId, brokerOrderId, changes) {
      const lookup = await broker.findOrderById(accountId, brokerOrderId);
      if (!lookup.order) throw new Error(`Nelze ověřit expozici modify orderu ${brokerOrderId}`);
      await assertWithinCap({
        accountId,
        symbol: lookup.order.symbol,
        side: lookup.order.side,
        quantity: changes.quantity,
      }, brokerOrderId);
      return broker.modifyOrder(accountId, brokerOrderId, changes);
    },
    listAccountCapabilities: accountIds => broker.listAccountCapabilities(accountIds),
    listPositions: accountId => broker.listPositions(accountId),
    listOrders: accountId => broker.listOrders(accountId),
    findOrdersByTag: (accountId, tag) => broker.findOrdersByTag(accountId, tag),
    findOrderById: (accountId, brokerOrderId) => broker.findOrderById(accountId, brokerOrderId),
    subscribe: listener => broker.subscribe(listener),
  };
}
