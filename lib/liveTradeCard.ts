/**
 * Karta aktuálního obchodu skupiny — jen zobrazení.
 *
 * SL a TP se posouvají v Tradovate; tady se z toho, co broker hlásí, počítá,
 * kolik každý účet a celá skupina skončí, když se trefí. Na rozdíl od ostrovu
 * (jen kontrakty leadera, jeho vstup, bez poplatků) bere každý účet s vlastním
 * vstupem, vlastními příkazy a poplatky za vstup i výstup.
 *
 * Nic odsud nesmí autorizovat příkaz (INV-UI-01/03): neověřené čtení dává
 * `null`, nikdy nulu ani poslední známou hodnotu.
 */

import type { LiveAccount, LiveOrder } from '../services/tradecopiaLiveService';
import type { TradovateAccountDataAccount } from './tradovateAccountDataTypes';
import { futuresSymbolRoot, pointValueUsd } from '../services/futuresContractSpecs';
import { isLiveAccountReadVerified } from './liveReadFreshness';

export interface TradeCardRowInput {
  account?: LiveAccount;
  accountId: number | null;
  name: string;
  isLeader: boolean;
}

/** Jedna strana SL nebo TP u účtu. */
export interface TradeCardLevel {
  /** Cena, když je jediná; při víc úrovních (rozdělený TP) null. */
  price: number | null;
  /** Kontrakty, které úroveň kryje. */
  coverage: number;
  /** Kryje přesně celou pozici / celý vstup. */
  exact: boolean;
  /** Body od vstupu účtu ve směru obchodu (SL v plusu = kladné). */
  points: number | null;
  /** Výsledek v USD po poplatcích (když jsou známé), jen při přesném krytí. */
  usd: number | null;
}

export interface TradeCardAccount {
  accountId: number;
  name: string;
  isLeader: boolean;
  quantity: number;
  entry: number | null;
  /** Otevřený P&L po poplatcích; null u neověřeného nebo starého čtení. */
  openPnl: number | null;
  /** Poplatky za vstup i výstup celé pozice; null když je broker neposlal. */
  fees: number | null;
  stop: TradeCardLevel;
  target: TradeCardLevel;
  ordersVerified: boolean;
}

export interface TradeCardModel {
  kind: 'position' | 'pending';
  symbol: string;
  /** 1 = long / buy, −1 = short / sell. */
  direction: 1 | -1;
  /** Typ čekajícího vstupu (Limit, Stop…); u pozice null. */
  entryType: string | null;
  quantity: number;
  /** Vážený průměrný vstup skupiny (u čekajícího vstupu jeho cena). */
  entry: number | null;
  /** Cena odvozená z otevřeného P&L skupiny; jen zobrazení. */
  mark: number | null;
  openPnl: number | null;
  stop: TradeCardLevel;
  target: TradeCardLevel;
  /** Úrovně leadera pro stupnici; null když leader nemá jedinou cenu. */
  ladder: { stop: number | null; target: number | null };
  /** Účty se SL / TP kryjícím celou pozici z účtů v obchodu. */
  stopCovered: number;
  targetCovered: number;
  accounts: TradeCardAccount[];
  /** Všechny částky jsou po poplatcích. */
  feesIncluded: boolean;
  totalFees: number | null;
  verified: boolean;
}

const finite = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const symbolKey = (symbol: string) => symbol.trim().toUpperCase();
const typeKey = (type: string) => type.trim().toLowerCase().replace(/[^a-z]/g, '');
const isStop = (order: LiveOrder) => ['stop', 'stoplimit'].includes(typeKey(order.orderType));
const isLimit = (order: LiveOrder) => typeKey(order.orderType) === 'limit';
const sideOf = (action: string): 1 | -1 | null => {
  const key = action.trim().toLowerCase();
  return key.includes('buy') ? 1 : key.includes('sell') ? -1 : null;
};
const quantityOf = (order: LiveOrder) => finite(order.quantity) ? Math.abs(order.quantity) : 0;
/** Tradovate drží SL/TP nativního bracketu jako Suspended, dokud se vstup nevyplní. */
const isSuspended = (order: LiveOrder) => order.status.trim().toLowerCase() === 'suspended';

/** Klíč sazby poplatku: účet + kořen kontraktu (MNQ, NQ…). */
export const feeRateKey = (accountId: number, symbol: string) => `${accountId}|${futuresSymbolRoot(symbol)}`;

/**
 * Skutečný poplatek za kontrakt a stranu z posledních fillů účtu na stejném
 * kořeni kontraktu. Broker ho posílá u každého fillu, takže nic neodhadujeme;
 * účet bez fillu s poplatky prostě sazbu nemá.
 */
export function tradeCardFeeRates(accounts: readonly TradovateAccountDataAccount[], sample = 20): Map<string, number> {
  const rates = new Map<string, number>();
  for (const account of accounts) {
    const byRoot = new Map<string, { fees: number; quantity: number; count: number }>();
    const fills = [...account.fills]
      .filter(fill => fill.symbol && fill.fees && finite(fill.quantity) && fill.quantity > 0)
      .sort((a, b) => Date.parse(b.timestamp ?? '') - Date.parse(a.timestamp ?? ''));
    for (const fill of fills) {
      const root = futuresSymbolRoot(fill.symbol!);
      const entry = byRoot.get(root) ?? { fees: 0, quantity: 0, count: 0 };
      if (entry.count >= sample) continue;
      entry.fees += fill.fees!.total;
      entry.quantity += fill.quantity!;
      entry.count += 1;
      byRoot.set(root, entry);
    }
    for (const [root, entry] of byRoot) {
      if (entry.quantity > 0) rates.set(`${account.id}|${root}`, entry.fees / entry.quantity);
    }
  }
  return rates;
}

/**
 * Úroveň SL nebo TP z příkazů jednoho účtu. USD jen při přesném krytí —
 * neúplná nebo přebytečná ochrana se nikdy nepromítne jako výsledek celé
 * pozice (stejně jako mobilní přehled pozice).
 */
const levelFrom = (legs: LiveOrder[], stop: boolean, entry: number | null, direction: 1 | -1,
  quantity: number, value: number | null, fees: number | null): TradeCardLevel => {
  const matching = legs.filter(stop ? isStop : isLimit);
  const coverage = matching.reduce((sum, order) => sum + quantityOf(order), 0);
  const prices = matching.map(order => stop ? order.stopPrice : order.price);
  const known = matching.length > 0 && prices.every(finite) && matching.every(order => quantityOf(order) > 0);
  const exact = known && coverage === quantity;
  const price = known && prices.every(p => p === prices[0]) ? prices[0]! : null;
  const gross = exact && entry != null && value != null
    ? matching.reduce((sum, order, index) => sum + (prices[index]! - entry) * direction * quantityOf(order) * value, 0)
    : null;
  return {
    price,
    coverage,
    exact,
    points: price != null && entry != null ? (price - entry) * direction : null,
    usd: gross == null ? null : gross - (fees ?? 0),
  };
};

const sumOrNull = (values: Array<number | null>): number | null =>
  values.length > 0 && values.every(finite) ? values.reduce((a, b) => a + b, 0) : null;

const groupLevel = (accounts: TradeCardAccount[], key: 'stop' | 'target', quantity: number): TradeCardLevel => {
  const levels = accounts.map(account => account[key]);
  const usd = sumOrNull(levels.map(level => level.usd));
  const weighted = levels.every(level => level.points != null)
    ? accounts.reduce((sum, account) => sum + account[key].points! * account.quantity, 0) / quantity
    : null;
  const prices = levels.map(level => level.price);
  return {
    price: prices.every(p => p != null && p === prices[0]) ? prices[0] : null,
    coverage: levels.reduce((sum, level) => sum + level.coverage, 0),
    exact: levels.every(level => level.exact),
    points: weighted,
    usd,
  };
};

export function buildTradeCard(rows: readonly TradeCardRowInput[], orders: readonly LiveOrder[],
  feeRates: ReadonlyMap<string, number>, now = Date.now()): TradeCardModel | null {
  const members = rows.filter((row): row is TradeCardRowInput & { account: LiveAccount; accountId: number } =>
    row.account != null && row.accountId != null);
  if (members.length === 0) return null;

  const holding = members.flatMap(row => row.account.positions
    .filter(position => position.netPosition !== 0)
    .map(position => ({ row, position })));

  if (holding.length > 0) {
    // Karta tvrdí „jeden obchod skupiny“ jen pro stejný kontrakt a směr.
    // Jinak je to rozjezd, který hlásí řádky účtů, ne souhrn.
    const first = holding[0].position;
    if (holding.some(({ position }) => symbolKey(position.symbol) !== symbolKey(first.symbol)
      || Math.sign(position.netPosition) !== Math.sign(first.netPosition))) return null;
    if (new Set(holding.map(({ row }) => row.accountId)).size !== holding.length) return null;
    const symbol = first.symbol;
    const direction = (first.netPosition > 0 ? 1 : -1) as 1 | -1;
    const value = pointValueUsd(symbol);
    // Poplatky buď u všech účtů, nebo u žádného — smíchat čisté a hrubé
    // částky do jednoho součtu by bylo horší než ukázat hrubé.
    const feesKnown = holding.every(({ row }) => finite(feeRates.get(feeRateKey(row.accountId, symbol))));
    const accounts = holding.map(({ row, position }): TradeCardAccount => {
      const quantity = Math.abs(position.netPosition);
      const entry = finite(position.netPrice) ? position.netPrice : null;
      const positionsVerified = isLiveAccountReadVerified(row.account, 'positions', now);
      const ordersVerified = positionsVerified && isLiveAccountReadVerified(row.account, 'orders', now);
      const fees = feesKnown ? feeRates.get(feeRateKey(row.accountId, symbol))! * quantity * 2 : null;
      // Otevřená pozice uznává jen Working ochranu (Suspended noha nic nekryje).
      const legs = ordersVerified ? orders.filter(order => order.working
        && order.accountId === row.accountId
        && symbolKey(order.symbol) === symbolKey(symbol)
        && sideOf(order.action) === -direction) : [];
      const soleOpen = row.account.positions.filter(p => p.netPosition !== 0).length === 1;
      const gross = positionsVerified && soleOpen && row.account.unrealizedPnlSource !== 'stale'
        && finite(row.account.unrealizedPnl) ? row.account.unrealizedPnl : null;
      return {
        accountId: row.accountId,
        name: row.name,
        isLeader: row.isLeader,
        quantity,
        entry,
        openPnl: gross == null ? null : gross - (fees ?? 0),
        fees,
        stop: ordersVerified ? levelFrom(legs, true, entry, direction, quantity, value, fees) : unverifiedLevel,
        target: ordersVerified ? levelFrom(legs, false, entry, direction, quantity, value, fees) : unverifiedLevel,
        ordersVerified,
      };
    }).sort((a, b) => Number(b.isLeader) - Number(a.isLeader));
    return summarize('position', symbol, direction, null, accounts, value);
  }

  // Čekající vstup: leaderův working Limit/Stop a u followerů jejich kopie
  // (stejný kontrakt, stejná strana). SL/TP bracketu jsou do fillu Suspended.
  const leader = members.find(row => row.isLeader);
  const entries = (row: typeof members[number]) => orders.filter(order => order.working
    && order.accountId === row.accountId && (isLimit(order) || isStop(order)));
  const leaderEntry = leader ? entries(leader)[0] : undefined;
  if (!leader || !leaderEntry) return null;
  const direction = sideOf(leaderEntry.action);
  if (direction == null) return null;
  const symbol = leaderEntry.symbol;
  const value = pointValueUsd(symbol);
  const pendingRows = members.flatMap(row => {
    const entry = row === leader ? leaderEntry : entries(row).find(order =>
      symbolKey(order.symbol) === symbolKey(symbol) && sideOf(order.action) === direction);
    return entry ? [{ row, entry }] : [];
  });
  const feesKnown = pendingRows.every(({ row }) => finite(feeRates.get(feeRateKey(row.accountId, symbol))));
  const accounts = pendingRows.map(({ row, entry }): TradeCardAccount => {
    const quantity = quantityOf(entry);
    const price = isStop(entry) ? entry.stopPrice ?? entry.price : entry.price;
    const ordersVerified = isLiveAccountReadVerified(row.account, 'orders', now);
    const fees = feesKnown ? feeRates.get(feeRateKey(row.accountId, symbol))! * quantity * 2 : null;
    const legs = ordersVerified ? orders.filter(order => order.id !== entry.id
      && order.accountId === row.accountId
      && (order.working || isSuspended(order))
      && symbolKey(order.symbol) === symbolKey(symbol)
      && sideOf(order.action) === -direction) : [];
    return {
      accountId: row.accountId,
      name: row.name,
      isLeader: row.isLeader,
      quantity,
      entry: finite(price) ? price : null,
      openPnl: null,
      fees,
      stop: ordersVerified ? levelFrom(legs, true, finite(price) ? price : null, direction, quantity, value, fees) : unverifiedLevel,
      target: ordersVerified ? levelFrom(legs, false, finite(price) ? price : null, direction, quantity, value, fees) : unverifiedLevel,
      ordersVerified,
    };
  }).sort((a, b) => Number(b.isLeader) - Number(a.isLeader));
  return summarize('pending', symbol, direction, leaderEntry.orderType, accounts, value);
}

const unverifiedLevel: TradeCardLevel = { price: null, coverage: 0, exact: false, points: null, usd: null };

function summarize(kind: TradeCardModel['kind'], symbol: string, direction: 1 | -1, entryType: string | null,
  accounts: TradeCardAccount[], value: number | null): TradeCardModel {
  const quantity = accounts.reduce((sum, account) => sum + account.quantity, 0);
  const entry = accounts.every(account => account.entry != null) && quantity > 0
    ? accounts.reduce((sum, account) => sum + account.entry! * account.quantity, 0) / quantity
    : null;
  const totalFees = sumOrNull(accounts.map(account => account.fees));
  const openPnl = kind === 'position' ? sumOrNull(accounts.map(account => account.openPnl)) : null;
  // Cena z P&L: Σ(cena − vstupᵢ)·qᵢ·hodnota = (cena − vážený vstup)·Q·hodnota.
  const grossPnl = openPnl != null ? openPnl + (totalFees ?? 0) : null;
  const mark = grossPnl != null && entry != null && value != null && quantity > 0
    ? entry + grossPnl / (quantity * value * direction)
    : null;
  const leader = accounts.find(account => account.isLeader) ?? accounts[0];
  return {
    kind,
    symbol,
    direction,
    entryType,
    quantity,
    entry,
    mark,
    openPnl,
    stop: groupLevel(accounts, 'stop', quantity),
    target: groupLevel(accounts, 'target', quantity),
    ladder: { stop: leader?.stop.price ?? null, target: leader?.target.price ?? null },
    stopCovered: accounts.filter(account => account.stop.exact).length,
    targetCovered: accounts.filter(account => account.target.exact).length,
    accounts,
    feesIncluded: totalFees != null,
    totalFees,
    verified: accounts.every(account => account.ordersVerified),
  };
}
