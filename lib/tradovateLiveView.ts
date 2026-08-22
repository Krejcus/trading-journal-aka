import type {
  TradovateAccountDataAccount,
  TradovateAccountFillPair,
  TradovateAccountOrder,
} from './tradovateAccountDataTypes';
import type { TradovateAccountProfile } from './tradovateAccountProfileTypes';

export interface TradovateLiveTotals {
  balance: number;
  netLiq: number;
  realizedPnl: number;
  openPnl: number;
  knownFees: number;
  openPositionCount: number;
  workingOrderCount: number;
  fillCount: number;
}

export type TradovateLiveActivityKind = 'trade' | 'fill' | 'order' | 'cash';

export type TradovateLiveActivitySemantic =
  | 'trade-closed'
  | 'fill'
  | 'entry-fill'
  | 'exit-fill'
  | 'stop-loss-fill'
  | 'take-profit-fill'
  | 'entry-order'
  | 'exit-order'
  | 'stop-loss-order'
  | 'take-profit-order'
  | 'order'
  | 'cash';

export type TradovateLiveActivityEvidence = 'broker-confirmed' | 'fillpair-derived' | 'historical-limited';

export interface TradovateLiveActivity {
  id: string;
  kind: TradovateLiveActivityKind;
  accountId: number;
  accountName: string;
  timestamp: string;
  title: string;
  detail: string;
  pnl: number | null;
  pnlLabel?: string;
  semantic: TradovateLiveActivitySemantic;
  evidence: TradovateLiveActivityEvidence;
  evidenceDetail: string;
  symbol: string | null;
  side: 'Long' | 'Short' | null;
  quantity: number | null;
  openedAt: string | null;
  entryPrice: number | null;
  exitPrice: number | null;
  componentCount: number;
  price: number | null;
  orderId: number | null;
  linkedTradeId: number | null;
}

export interface TradovateLiveDay {
  tradeDate: string;
  reportedRealizedPnl: number | null;
  grossTradePnl: number;
  feeDelta: number;
  cashDelta: number;
  fillCount: number;
  pairedTradeCount: number;
}

const terminalOrderStatuses = new Set(['filled', 'canceled', 'cancelled', 'rejected', 'expired', 'completed']);

const value = (candidate: number | null) => candidate ?? 0;

export const isWorkingTradovateOrder = (order: TradovateAccountOrder) =>
  !terminalOrderStatuses.has((order.status ?? '').toLowerCase());

export const aggregateTradovateLive = (accounts: TradovateAccountDataAccount[]): TradovateLiveTotals =>
  accounts.reduce<TradovateLiveTotals>((totals, account) => ({
    balance: totals.balance + value(account.balance.totalCashValue),
    netLiq: totals.netLiq + value(account.balance.netLiq ?? account.balance.totalCashValue),
    realizedPnl: totals.realizedPnl + value(account.balance.realizedPnL),
    openPnl: totals.openPnl + value(account.balance.openPnL),
    knownFees: totals.knownFees + account.activity.knownFees,
    openPositionCount: totals.openPositionCount + account.netPositionCount,
    workingOrderCount: totals.workingOrderCount + account.workingOrderCount,
    fillCount: totals.fillCount + account.activity.fillCount,
  }), {
    balance: 0,
    netLiq: 0,
    realizedPnl: 0,
    openPnl: 0,
    knownFees: 0,
    openPositionCount: 0,
    workingOrderCount: 0,
    fillCount: 0,
  });

export const profileMap = (profiles: TradovateAccountProfile[]) =>
  new Map(profiles.map(profile => [profile.externalAccountId, profile]));

export const accountDisplayName = (
  account: TradovateAccountDataAccount,
  profiles: Map<string, TradovateAccountProfile>,
) => profiles.get(String(account.id))?.displayName || account.name;

const highestFinite = (values: Array<number | null | undefined>): number | null => {
  const finiteValues = values.filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value));
  return finiteValues.length > 0 ? Math.max(...finiteValues) : null;
};

export const accountRiskPeak = (
  account: TradovateAccountDataAccount,
  profile?: TradovateAccountProfile,
): number | null => {
  const accountSize = profile?.accountSize ?? null;
  if (profile?.drawdownType === 'none') return null;
  if (profile?.drawdownType === 'static' || profile?.drawdownType == null) return accountSize;

  if (profile.drawdownType === 'eod_trailing') {
    // Tradovate defines maxNetLiq as the account high-watermark. In EOD mode
    // the broker itself advances it only at the session close, so it is more
    // authoritative than rebuilding the watermark from an occasionally
    // incomplete cash log.
    return highestFinite([
      accountSize,
      account.risk.maxNetLiq,
      ...account.daily.map(day => day.endingBalance),
    ]);
  }

  // Intraday trailing plans can move on unrealized equity. Prefer Tradovate's
  // observed maximum and include the current equity as a safe lower bound.
  return highestFinite([
    accountSize,
    account.risk.maxNetLiq,
    account.balance.netLiq,
    account.balance.totalCashValue,
  ]);
};

export const accountRiskFloor = (
  account: TradovateAccountDataAccount,
  profile?: TradovateAccountProfile,
): number | null => {
  if (profile?.drawdownType === 'none') return null;
  // Brokerův auto-liq level je skutečný aktuální floor a má přednost před
  // rekonstrukcí z high-watermarku a nominálního max loss pravidla.
  if (account.balance.autoLiqLevel != null && Number.isFinite(account.balance.autoLiqLevel)) {
    return account.balance.autoLiqLevel;
  }
  const maxLoss = account.risk.trailingMaxDrawdown ?? profile?.maxLoss ?? null;
  if (maxLoss == null) return null;
  const peak = accountRiskPeak(account, profile);
  return peak == null ? null : peak - maxLoss;
};

export const accountRiskCushion = (
  account: TradovateAccountDataAccount,
  profile?: TradovateAccountProfile,
): number | null => {
  const floor = accountRiskFloor(account, profile);
  const equity = account.balance.netLiq ?? account.balance.totalCashValue;
  return floor == null || equity == null ? null : equity - floor;
};

interface FillRole {
  pair: TradovateAccountFillPair;
  role: 'entry' | 'exit';
}

interface ExitClassification {
  semantic: 'exit-fill' | 'stop-loss-fill' | 'take-profit-fill';
  label: string;
  evidence: TradovateLiveActivityEvidence;
  evidenceDetail: string;
}

const orderTypeKey = (order?: TradovateAccountOrder) => (order?.orderType ?? '').toLowerCase();
const bracketLinked = (order?: TradovateAccountOrder) => Boolean(
  order && (order.parentId != null || order.ocoId != null || order.linkedId != null),
);

const classifyExit = (order?: TradovateAccountOrder): ExitClassification => {
  if (!order) return {
    semantic: 'exit-fill',
    label: 'Výstup (důvod neurčen)',
    evidence: 'historical-limited',
    evidenceDetail: 'Closing order není v dostupné historii; z entry/exit ceny nelze poctivě určit SL ani TP.',
  };
  const type = orderTypeKey(order);
  if (type.includes('stop')) return {
    semantic: 'stop-loss-fill',
    label: 'Stop loss',
    evidence: 'broker-confirmed',
    evidenceDetail: `Closing fill patří broker orderu #${order.id} typu ${order.orderType ?? 'Stop'}.`,
  };
  if (type.includes('limit') && bracketLinked(order)) return {
    semantic: 'take-profit-fill',
    label: 'Take profit',
    evidence: 'broker-confirmed',
    evidenceDetail: `Closing fill patří propojenému bracket/OCO orderu #${order.id} typu ${order.orderType ?? 'Limit'}.`,
  };
  if (type.includes('limit')) return {
    semantic: 'exit-fill',
    label: 'Limitní výstup (TP nepotvrzen)',
    evidence: 'fillpair-derived',
    evidenceDetail: `Broker potvrzuje limitní closing order #${order.id}, ale bez parent/OCO vazby nelze potvrdit, že šlo o TP.`,
  };
  return {
    semantic: 'exit-fill',
    label: `${order.orderType ?? 'Jiný'} výstup`,
    evidence: 'fillpair-derived',
    evidenceDetail: `Výstup je spárovaný s broker orderem #${order.id}; jeho záměr (ruční/auto) API nepotvrzuje.`,
  };
};

const fillRoles = (account: TradovateAccountDataAccount): Map<number, FillRole> => {
  const roles = new Map<number, FillRole>();
  for (const pair of account.fillPairs) {
    const side = pair.side?.toLowerCase();
    if (side === 'long') {
      roles.set(pair.buyFillId, { pair, role: 'entry' });
      roles.set(pair.sellFillId, { pair, role: 'exit' });
    } else if (side === 'short') {
      roles.set(pair.sellFillId, { pair, role: 'entry' });
      roles.set(pair.buyFillId, { pair, role: 'exit' });
    }
  }
  return roles;
};

const pairActivity = (
  account: TradovateAccountDataAccount,
  pair: TradovateAccountFillPair,
  fillsById: Map<number, TradovateAccountDataAccount['fills'][number]>,
  ordersById: Map<number, TradovateAccountOrder>,
): TradovateLiveActivity | null => {
  if (!pair.closedAt) return null;
  const isShort = pair.side?.toLowerCase() === 'short';
  const closingFillId = isShort ? pair.buyFillId : pair.sellFillId;
  const closingFill = fillsById.get(closingFillId);
  const closingOrder = closingFill ? ordersById.get(closingFill.orderId) : undefined;
  const exit = classifyExit(closingOrder);
  const quantity = pair.quantity == null ? '' : ` · ${pair.quantity} kontrakt${pair.quantity === 1 ? '' : 'ů'}`;
  const historical = pair.id < 0;
  const evidence = historical ? 'historical-limited' : exit.evidence;
  const evidenceDetail = historical
    ? 'Historický Performance report potvrzuje entry, exit a P&L, ale neobsahuje closing order ani původní SL/TP.'
    : exit.evidenceDetail;
  return {
    id: `trade:${account.id}:${pair.id}`,
    kind: 'trade',
    accountId: account.id,
    accountName: account.name,
    timestamp: pair.closedAt,
    title: `${pair.symbol ?? 'Kontrakt'} ${pair.side?.toUpperCase() ?? 'TRADE'} uzavřen · ${historical ? 'důvod výstupu neurčen' : exit.label}`,
    detail: `Vstup ${isShort ? pair.sellPrice ?? '—' : pair.buyPrice ?? '—'} → výstup ${isShort ? pair.buyPrice ?? '—' : pair.sellPrice ?? '—'}${quantity}`,
    pnl: pair.netPnl ?? pair.grossPnl,
    pnlLabel: pair.netPnl != null ? 'Net P&L' : 'Gross P&L bez známých poplatků',
    semantic: 'trade-closed',
    evidence,
    evidenceDetail,
    symbol: pair.symbol,
    side: pair.side,
    quantity: pair.quantity,
    openedAt: pair.openedAt,
    entryPrice: isShort ? pair.sellPrice : pair.buyPrice,
    exitPrice: isShort ? pair.buyPrice : pair.sellPrice,
    componentCount: 1,
    price: isShort ? pair.buyPrice : pair.sellPrice,
    orderId: closingOrder?.id ?? null,
    linkedTradeId: pair.id,
  };
};

const tradeGroupKey = (event: TradovateLiveActivity): string => [
  event.accountId,
  event.symbol,
  event.side,
  event.openedAt,
  event.timestamp,
  event.entryPrice,
  event.exitPrice,
  event.orderId,
  event.evidence,
  event.pnlLabel,
].join('|');

/**
 * Performance often emits one row per paired fill fragment. Exact fragments
 * with the same lifecycle are one human-readable trade in the overview; the
 * raw split remains available in the source report instead of flooding the UI.
 */
const coalesceClosedTradeFragments = (events: TradovateLiveActivity[]): TradovateLiveActivity[] => {
  const grouped = new Map<string, TradovateLiveActivity>();
  const other: TradovateLiveActivity[] = [];
  for (const event of events) {
    if (event.kind !== 'trade') {
      other.push(event);
      continue;
    }
    const key = tradeGroupKey(event);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, { ...event });
      continue;
    }
    current.quantity = current.quantity == null || event.quantity == null
      ? current.quantity ?? event.quantity
      : current.quantity + event.quantity;
    current.pnl = current.pnl == null || event.pnl == null
      ? current.pnl ?? event.pnl
      : current.pnl + event.pnl;
    current.componentCount += event.componentCount;
    current.detail = `Vstup ${current.entryPrice ?? '—'} → výstup ${current.exitPrice ?? '—'}${current.quantity == null ? '' : ` · ${current.quantity} kontrakt${current.quantity === 1 ? '' : 'ů'}`} · ${current.componentCount} spárovaných částí`;
  }
  return [...grouped.values(), ...other];
};

export const buildTradovateLiveActivity = (
  accounts: TradovateAccountDataAccount[],
  limit = 300,
): TradovateLiveActivity[] => {
  const events: TradovateLiveActivity[] = [];
  for (const account of accounts) {
    const seenSessionLedgerEntries = new Set<string>();
    const fillsById = new Map(account.fills.map(fill => [fill.id, fill]));
    const ordersById = new Map(account.orders.map(order => [order.id, order]));
    const rolesByFillId = fillRoles(account);
    const rolesByOrderId = new Map<number, FillRole>();
    for (const fill of account.fills) {
      const role = rolesByFillId.get(fill.id);
      if (role) rolesByOrderId.set(fill.orderId, role);
    }
    for (const pair of account.fillPairs) {
      const event = pairActivity(account, pair, fillsById, ordersById);
      if (event) events.push(event);
    }
    for (const fill of account.fills) {
      if (!fill.timestamp) continue;
      const role = rolesByFillId.get(fill.id);
      const order = ordersById.get(fill.orderId);
      const exit = role?.role === 'exit' ? classifyExit(order) : null;
      const semantic: TradovateLiveActivitySemantic = role?.role === 'entry'
        ? 'entry-fill'
        : exit?.semantic ?? 'fill';
      const roleLabel = role?.role === 'entry' ? 'Vstup vyplněn' : exit?.label ?? 'Fill bez spárované role';
      events.push({
        id: `fill:${account.id}:${fill.id}`,
        kind: 'fill',
        accountId: account.id,
        accountName: account.name,
        timestamp: fill.timestamp,
        title: `${fill.symbol ?? 'Kontrakt'} · ${roleLabel}`,
        detail: `${fill.action ?? 'Fill'} ${fill.quantity ?? '—'} za ${fill.price ?? '—'} · order #${fill.orderId}${fill.fees ? ` · poplatky ${fill.fees.total.toFixed(2)} USD` : ''}`,
        pnl: null,
        semantic,
        evidence: role?.role === 'entry' ? 'fillpair-derived' : exit?.evidence ?? 'historical-limited',
        evidenceDetail: role?.role === 'entry'
          ? `Broker fill #${fill.id} je opening leg spárovaného obchodu #${role.pair.id}.`
          : exit?.evidenceDetail ?? 'Fill není součástí dostupného fillPair; jeho roli nelze určit.',
        symbol: fill.symbol,
        side: role?.pair.side ?? null,
        quantity: fill.quantity,
        openedAt: role?.pair.openedAt ?? null,
        entryPrice: role ? (role.pair.side?.toLowerCase() === 'short' ? role.pair.sellPrice : role.pair.buyPrice) : null,
        exitPrice: role ? (role.pair.side?.toLowerCase() === 'short' ? role.pair.buyPrice : role.pair.sellPrice) : null,
        componentCount: 1,
        price: fill.price,
        orderId: fill.orderId,
        linkedTradeId: role?.pair.id ?? null,
      });
    }
    for (const order of account.orders) {
      if (!order.timestamp) continue;
      const role = rolesByOrderId.get(order.id);
      const type = orderTypeKey(order);
      const linked = bracketLinked(order);
      const exit = role?.role === 'exit' ? classifyExit(order) : null;
      const semantic: TradovateLiveActivitySemantic = role?.role === 'entry'
        ? 'entry-order'
        : exit ? exit.semantic.replace('-fill', '-order') as TradovateLiveActivitySemantic
          : linked && type.includes('stop') ? 'stop-loss-order'
            : linked && type.includes('limit') ? 'take-profit-order'
              : 'order';
      const roleLabel = role?.role === 'entry'
        ? 'Vstupní příkaz'
        : exit?.label
          ?? (semantic === 'stop-loss-order' ? 'Stop loss příkaz' : semantic === 'take-profit-order' ? 'Take profit příkaz' : 'Příkaz');
      const price = order.stopPrice ?? order.price;
      events.push({
        id: `order:${account.id}:${order.id}`,
        kind: 'order',
        accountId: account.id,
        accountName: account.name,
        timestamp: order.timestamp,
        title: `${order.symbol ?? 'Kontrakt'} · ${roleLabel}`,
        detail: `${order.action ?? '—'} ${order.quantity ?? '—'} · ${order.orderType ?? 'typ neuveden'}${price != null ? ` za ${price}` : ''} · ${order.status ?? 'stav neuveden'} · #${order.id}`,
        pnl: null,
        semantic,
        evidence: semantic === 'stop-loss-order' || semantic === 'take-profit-order' || exit?.evidence === 'broker-confirmed'
          ? 'broker-confirmed'
          : role ? 'fillpair-derived' : 'historical-limited',
        evidenceDetail: semantic === 'stop-loss-order' || semantic === 'take-profit-order'
          ? `Broker order nese bracket vazbu (${[order.parentId != null && `parent ${order.parentId}`, order.ocoId != null && `OCO ${order.ocoId}`, order.linkedId != null && `linked ${order.linkedId}`].filter(Boolean).join(', ')}).`
          : role ? `Order je propojen přes fill se spárovaným obchodem #${role.pair.id}.` : 'Jde o aktuální broker snapshot příkazu; bez fillPair nelze určit jeho roli v obchodu.',
        symbol: order.symbol,
        side: role?.pair.side ?? null,
        quantity: order.quantity,
        openedAt: role?.pair.openedAt ?? null,
        entryPrice: role ? (role.pair.side?.toLowerCase() === 'short' ? role.pair.sellPrice : role.pair.buyPrice) : null,
        exitPrice: role ? (role.pair.side?.toLowerCase() === 'short' ? role.pair.buyPrice : role.pair.sellPrice) : null,
        componentCount: 1,
        price,
        orderId: order.id,
        linkedTradeId: role?.pair.id ?? null,
      });
    }
    for (const entry of account.ledger) {
      if (!entry.timestamp || (!entry.cashChangeType && entry.delta == null)) continue;
      // Tradovate někdy vrátí stejný marker NewSession vícekrát s jiným
      // interním ID. Je to účetní hranice session, ne dvě různé události.
      // Ostatní cash změny dál rozlišujeme podle broker ID, abychom nesloučili
      // legitimní poplatky nebo trade fragments se stejným časem a částkou.
      const normalizedType = entry.cashChangeType?.trim().toLowerCase() ?? '';
      if (normalizedType === 'newsession') {
        const sessionKey = [account.id, entry.timestamp, normalizedType, entry.amount, entry.delta].join('|');
        if (seenSessionLedgerEntries.has(sessionKey)) continue;
        seenSessionLedgerEntries.add(sessionKey);
      }
      events.push({
        id: `cash:${account.id}:${entry.id ?? entry.timestamp}`,
        kind: 'cash',
        accountId: account.id,
        accountName: account.name,
        timestamp: entry.timestamp,
        title: entry.cashChangeType ?? 'Cash balance',
        detail: entry.comment || 'Změna cash balance',
        pnl: entry.delta,
        pnlLabel: 'Cash změna',
        semantic: 'cash',
        evidence: 'broker-confirmed',
        evidenceDetail: 'Položka pochází přímo z Tradovate cash ledgeru.',
        symbol: null,
        side: null,
        quantity: null,
        openedAt: null,
        entryPrice: null,
        exitPrice: null,
        componentCount: 1,
        price: null,
        orderId: null,
        linkedTradeId: entry.fillPairId,
      });
    }
  }
  return coalesceClosedTradeFragments(events)
    .filter(event => Number.isFinite(Date.parse(event.timestamp)))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);
};

export const aggregateTradovateLiveDays = (accounts: TradovateAccountDataAccount[]): TradovateLiveDay[] => {
  const days = new Map<string, TradovateLiveDay & { reportedCount: number }>();
  for (const account of accounts) {
    for (const day of account.daily) {
      const current = days.get(day.tradeDate) ?? {
        tradeDate: day.tradeDate,
        reportedRealizedPnl: 0,
        reportedCount: 0,
        grossTradePnl: 0,
        feeDelta: 0,
        cashDelta: 0,
        fillCount: 0,
        pairedTradeCount: 0,
      };
      if (day.reportedRealizedPnl != null) {
        current.reportedRealizedPnl = (current.reportedRealizedPnl ?? 0) + day.reportedRealizedPnl;
        current.reportedCount += 1;
      }
      current.grossTradePnl += day.grossTradePnl;
      current.feeDelta += day.feeDelta;
      current.cashDelta += day.cashDelta;
      current.fillCount += day.fillCount;
      current.pairedTradeCount += day.pairedTradeCount;
      days.set(day.tradeDate, current);
    }
  }
  return [...days.values()]
    .map(({ reportedCount, ...day }) => ({ ...day, reportedRealizedPnl: reportedCount > 0 ? day.reportedRealizedPnl : null }))
    .sort((a, b) => b.tradeDate.localeCompare(a.tradeDate));
};
