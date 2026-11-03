import type { BacktestChartOrderLine, BacktestChartOrderLineKind } from '../services/backtestOrderLines';
import type { LiveAccount } from '../services/tradecopiaLiveService';
import { isLiveAccountReadVerified } from './liveReadFreshness';

/**
 * Všechny pracující příkazy v LIVE grafu (U5, 3. 11. 2026) — JEN ZOBRAZENÍ.
 *
 * Z read modelu příkazů brokera (REST `LiveOrder`, stejný zdroj jako karta obchodu)
 * vyrobí tlumené tečkované čáry pro to, co `livePositionChartLines` nekreslí:
 * cizí / další pracující Limit, Stop a StopLimit („LMT BUY 1 · Tradovate“) a každou
 * nohu rozjetých SL/TP po cenách („SL 1 ks  27936.50“). Nepodporovaný typ
 * (TrailingStop, MIT, stream `Unsupported`) dostane jen štítek bez čáry.
 *
 * Bezpečnost (INV-UI-01/03/04, INV-MANUAL-01):
 * - čáru nejde táhnout, zrušit ×, nemá tlačítka ani přidání SL/TP — jádro správu cizích
 *   a rozjetých příkazů nemá a blokuje ji (`other-orders`, `position-multi`, `shape`);
 * - neověřené čtení příkazů nebo pohled pozice s `issue` = nic (žádná poslední známá poloha);
 * - ceny jen z read modelu brokera, nikdy z TradingView ani IBKR;
 * - nic tady neodesílá a nic nevrací jako „co jsem viděl“ — `expect` se dál bere ze `summary`;
 * - nikdy nevyhodí výjimku (chyba dat = prázdný pohled).
 */

export const LIVE_WORKING_OWNER = 'live-working';
/** Víc čar se nevykreslí; zbytek se sečte do štítku „+N dalších“. */
export const LIVE_WORKING_MAX_LINES = 12;
/** Víc štítků nepodporovaného typu se nevykreslí; zbytek jde do „+N dalších“. */
export const LIVE_WORKING_MAX_BADGES = 4;
export const LIVE_WORKING_TITLE = 'Spravuj v Tradovate, nebo zavři pozici ×/Flatten';

const STOP_LEG_COLOR = '#c26b6b';
const TARGET_LEG_COLOR = '#4e9a90';
const BUY_COLOR = '#6f86b3';
const SELL_COLOR = '#b5778a';
const BADGE_COLOR = '#a16207';
const NEUTRAL_COLOR = '#7d8aa0';
/** Ceny MNQ jsou na 0.25 — shoda cen bez chyb součtů. */
const PRICE_EPSILON = 1e-6;

/**
 * Typ příkazu, jak ho rozliší čára. Vlastní lokální typ nad surovým řetězcem: REST nese
 * typ brokera (Limit, TrailingStop…), stream `ObservedOrderType` (= OrderType | 'Unsupported').
 */
export type LiveWorkingOrderClass = 'limit' | 'stop' | 'stopLimit' | 'market' | 'unsupported';

/** Stejné rozlišení jako karta obchodu (`liveTradeCard`: stop/stoplimit = SL, limit = TP). */
export function liveWorkingOrderClass(orderType: string | null | undefined): LiveWorkingOrderClass {
  const key = (typeof orderType === 'string' ? orderType : '').trim().toLowerCase().replace(/[^a-z]/g, '');
  if (key === 'limit') return 'limit';
  if (key === 'stop') return 'stop';
  if (key === 'stoplimit') return 'stopLimit';
  if (key === 'market') return 'market';
  return 'unsupported';
}

/** Příkaz z read modelu brokera; `LiveOrder` (`tradovateCopyTradeOrders`) ho splňuje. */
export interface LiveWorkingOrderSource {
  id: number | string;
  accountId: number | null;
  accountName?: string;
  action: string;
  orderType: string;
  /** Surový typ brokera u `Unsupported` ze streamu (jen popisek). */
  brokerOrderType?: string | null;
  quantity: number;
  price: number | null;
  stopPrice: number | null;
  symbol: string;
  working: boolean;
}

/**
 * Co už kreslí `livePositionChartLines` — `LiveChartPositionSummary` to splňuje.
 * Podle toho se vynechá, co by se kreslilo dvakrát, a rozliší nohy SL/TP od jiných příkazů.
 */
export interface LiveWorkingDrawnPosition {
  kind: 'position' | 'pending';
  side: 'long' | 'short';
  /** Bez vstupu `livePositionChartLines` nekreslí nic — pak se nic nevynechává. */
  entry: number | null;
  entryType?: string | null;
  /** Jediná cena SL (null = rozjeté nebo neznámé → nohy kreslí tento modul). */
  stop: number | null;
  target: number | null;
  /** Účet a vstup leadera pohledu — jen pro $ u nohy toho účtu. */
  leader?: { accountId: number; entry: number | null } | null;
}

export interface LiveWorkingDrawn {
  /** `LiveChartPosition.summary`; null = pozice ani čekající vstup se nekreslí. */
  position: LiveWorkingDrawnPosition | null;
  /** `LiveChartPosition.symbol`; jiný kontrakt než graf = pozice na tomto grafu nic nekreslí. */
  symbol?: string | null;
  /** `LivePositionLineControls.pendingAdd` — čekající přikoupení má vlastní čáru s ×. */
  pendingAdd?: { price: number | null; orderType?: string | null } | null;
}

export interface LiveWorkingOrdersInput {
  orders: readonly LiveWorkingOrderSource[];
  /** Účty pohledu: skupina = [leader], jeden účet = [ten účet] (`liveWorkingAccountIds`). */
  accountIds: readonly number[];
  /**
   * Ověřené čtení příkazů všech účtů pohledu A pohled pozice bez `issue`
   * (`liveWorkingOrdersVerified`). false = žádné čáry ani štítky.
   */
  verified: boolean;
  /** Konkrétní kontrakt grafu (MNQZ6); null = neznámý → nic. */
  contract: string | null;
  drawn: LiveWorkingDrawn;
  /** Hodnota bodu (MNQ = 2) pro $ u nohy; bez ní jen cena a body. */
  pointValue?: number | null;
}

export type LiveWorkingLineRole = 'stop-leg' | 'target-leg' | 'order';

/** Čára jen pro zobrazení — strukturálně `BacktestChartOrderLine`, jde rovnou do overlaye. */
export interface LiveWorkingOrderLine extends BacktestChartOrderLine {
  ownerId: typeof LIVE_WORKING_OWNER;
  ownerType: 'order';
  draggable: false;
  cancellable: false;
  /** Značka pro handlery grafu: nikdy nic neposílat ani neměnit návrh (`isLiveDisplayOnlyLine`). */
  displayOnly: true;
  /** Tlumená tečkovaná čára (overlay dnes kreslí čárkovaně — styl doplní integrace). */
  lineStyle: 'dotted';
  /** Tooltip štítku. */
  title: string;
  role: LiveWorkingLineRole;
  side: 'buy' | 'sell';
  orderClass: Exclude<LiveWorkingOrderClass, 'market' | 'unsupported'>;
  quantity: number;
  accountId: number;
  orderIds: Array<number | string>;
}

/** Štítek bez čáry: nepodporovaný typ / neznámá strana, nebo „+N dalších“. */
export interface LiveWorkingOrderBadge {
  id: string;
  kind: 'unsupported' | 'overflow';
  text: string;
  /** Konečná cena příkazu, jinak null (u „+N dalších“ vždy null). */
  price: number | null;
  color: string;
  title: string;
  /** `unsupported` = kontrakty (součet qty), `overflow` = skryté čáry a štítky. */
  count: number;
}

export interface LiveWorkingOrdersView {
  lines: LiveWorkingOrderLine[];
  badges: LiveWorkingOrderBadge[];
  /** Obsahový klíč — graf se překreslí jen při změně. */
  key: string;
}

/** Klíč prázdného pohledu (nic se nekreslí). */
export const EMPTY_LIVE_WORKING_KEY = 'none';
/** Pokaždé nové pole — volající je smí předat dál bez sdíleného stavu. */
const emptyView = (): LiveWorkingOrdersView => ({ lines: [], badges: [], key: EMPTY_LIVE_WORKING_KEY });

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const symbolKey = (symbol: unknown) => (typeof symbol === 'string' ? symbol.trim().toUpperCase() : '');
const samePrice = (a: number, b: number) => Math.abs(a - b) < PRICE_EPSILON;
const sideOf = (action: unknown): 'buy' | 'sell' | null => {
  const key = typeof action === 'string' ? action.trim().toLowerCase() : '';
  return key.includes('buy') ? 'buy' : key.includes('sell') ? 'sell' : null;
};
const signedUsd = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toFixed(2)}`;
const TYPE_LABEL: Record<LiveWorkingOrderLine['orderClass'], string> = { limit: 'LMT', stop: 'STP', stopLimit: 'STP LMT' };
const TYPE_NAME: Record<LiveWorkingOrderLine['orderClass'], string> = { limit: 'Limit', stop: 'Stop', stopLimit: 'StopLimit' };
/** Id čáry = klíč seskupení (účet, typ nebo role nohy, strana, cena). */
const lineId = (accountId: number, what: string, side: 'buy' | 'sell', price: number) =>
  `${LIVE_WORKING_OWNER}:${accountId}:${what}:${side}:${price.toFixed(2)}`;
/** Cena, na které kreslí čekající vstup karta obchodu (`buildTradeCard`): Stop = stopPrice ?? price. */
const cardEntryPrice = (order: LiveWorkingOrderSource, cls: LiveWorkingOrderClass) =>
  (cls === 'stop' || cls === 'stopLimit' ? (finite(order.stopPrice) ? order.stopPrice : order.price) : order.price);

/**
 * Čtení příkazů ověřené pro všechny účty pohledu a pohled pozice bez `issue`
 * (neověřené pozice, dobíhající kopie, rozjetí). Fail-closed: chybějící účet = false.
 */
export function liveWorkingOrdersVerified(input: {
  accounts: readonly LiveAccount[];
  accountIds: readonly number[];
  positionIssue: string | null;
  now: number;
}): boolean {
  try {
    if (input.positionIssue != null || input.accountIds.length === 0) return false;
    return input.accountIds.every(accountId => {
      const account = input.accounts.find(candidate => candidate.id === accountId);
      return account != null && isLiveAccountReadVerified(account, 'orders', input.now);
    });
  } catch {
    return false;
  }
}

/** Účty pohledu: skupina = jen leader (příkazy leadera), jeden účet = ten účet. */
export function liveWorkingAccountIds(
  target: { kind: 'group' } | { kind: 'account'; accountId: string | number },
  leaderAccountId: number | null | undefined,
): number[] {
  if (target.kind === 'group') return leaderAccountId != null && Number.isSafeInteger(leaderAccountId) ? [leaderAccountId] : [];
  const accountId = Number(target.accountId);
  return Number.isSafeInteger(accountId) ? [accountId] : [];
}

/** Handlery grafu (PC i telefon) mají takovou čáru hned na začátku ignorovat. */
export function isLiveDisplayOnlyLine(line: Pick<BacktestChartOrderLine, 'ownerId'> & { displayOnly?: unknown }): boolean {
  return line.ownerId === LIVE_WORKING_OWNER || line.displayOnly === true;
}

interface Group {
  key: string;
  role: LiveWorkingLineRole;
  side: 'buy' | 'sell';
  orderClass: LiveWorkingOrderLine['orderClass'];
  price: number;
  accountId: number;
  accountName: string;
  quantity: number;
  orderIds: Array<number | string>;
  limitPrices: number[];
}

interface BadgeGroup {
  key: string;
  text: string;
  price: number | null;
  count: number;
}

/** Pohled pracujících příkazů: čáry + štítky. Nikdy nevyhodí výjimku. */
export function liveWorkingOrderView(input: LiveWorkingOrdersInput): LiveWorkingOrdersView {
  try {
    return buildView(input);
  } catch {
    return emptyView();
  }
}

/** Jen čáry (podpis z návrhu U5); štítky bez čáry jsou v `liveWorkingOrderView`. */
export function liveWorkingOrderLines(input: LiveWorkingOrdersInput): LiveWorkingOrderLine[] {
  return liveWorkingOrderView(input).lines;
}

function buildView(input: LiveWorkingOrdersInput): LiveWorkingOrdersView {
  // INV-UI-01: neověřené = nic, ne poslední známá poloha.
  if (!input || input.verified !== true) return emptyView();
  const contract = symbolKey(input.contract);
  if (!contract) return emptyView();
  const accounts = new Set((input.accountIds ?? []).filter(id => Number.isSafeInteger(id)));
  if (accounts.size === 0) return emptyView();
  const multi = accounts.size > 1;

  // Pozice na TOMTO grafu (jiný kontrakt = nic z ní tu neleží).
  const drawnSymbol = input.drawn?.symbol;
  const sameContract = drawnSymbol == null || symbolKey(drawnSymbol) === contract;
  const summary = sameContract ? input.drawn?.position ?? null : null;
  // Nohy SL/TP rozlišuje otevřená pozice (i bez známého vstupu): výstupní strana Stop = SL, Limit = TP.
  const legsApply = summary?.kind === 'position';
  const exitSide = summary ? (summary.side === 'long' ? 'sell' : 'buy') : null;
  const entrySide = summary ? (summary.side === 'long' ? 'buy' : 'sell') : null;
  // Vynechává se jen to, co `livePositionChartLines` opravdu kreslí — bez vstupu nekreslí nic.
  const drawn = summary && finite(summary.entry) ? summary : null;
  const drawnStop = drawn && finite(drawn.stop) ? drawn.stop : null;
  const drawnTarget = drawn && finite(drawn.target) ? drawn.target : null;
  // Čekající vstup kreslí karta z PRVNÍHO pracujícího Limit/Stop leadera — vynechat jen jeden.
  let pendingEntry = drawn?.kind === 'pending'
    ? { price: drawn.entry as number, orderClass: drawn.entryType ? liveWorkingOrderClass(drawn.entryType) : null }
    : null;
  const add = input.drawn?.pendingAdd;
  let pendingAdd = drawn?.kind === 'position' && add && finite(add.price)
    ? { price: add.price, orderClass: add.orderType ? liveWorkingOrderClass(add.orderType) : null }
    : null;
  const leader = summary?.leader && finite(summary.leader.entry) ? summary.leader : null;
  const pointValue = finite(input.pointValue) && input.pointValue > 0 ? input.pointValue : null;

  const groups = new Map<string, Group>();
  const badgeGroups = new Map<string, BadgeGroup>();
  for (const order of input.orders ?? []) {
    if (!order || order.working !== true) continue;
    const accountId = order.accountId;
    if (accountId == null || !accounts.has(accountId)) continue;
    if (symbolKey(order.symbol) !== contract) continue;
    const quantity = finite(order.quantity) ? Math.abs(order.quantity) : 0;
    if (quantity <= 0) continue;
    const accountName = typeof order.accountName === 'string' && order.accountName.trim() ? order.accountName.trim() : String(accountId);
    const side = sideOf(order.action);
    const orderClass = liveWorkingOrderClass(order.orderType);
    // Market čeká jen chvíli a nemá cenu — žádná čára ani štítek.
    if (orderClass === 'market') continue;
    if (orderClass === 'unsupported' || side == null) {
      // Nepodporovaný typ / neznámá strana: jen štítek (s cenou, když je konečná), nikdy čára.
      const raw = (orderClass === 'unsupported'
        ? (order.orderType === 'Unsupported' && typeof order.brokerOrderType === 'string' && order.brokerOrderType.trim() ? order.brokerOrderType : order.orderType)
        : order.orderType);
      // Zástupný „—“ z mostu (typ chybí) = neznámý typ „?“.
      const cleaned = typeof raw === 'string' ? raw.trim() : '';
      const typeText = cleaned && !/^[—–-]+$/.test(cleaned) ? cleaned.slice(0, 16).toUpperCase() : '?';
      const price = finite(order.stopPrice) ? order.stopPrice : finite(order.price) ? order.price : null;
      const reason = orderClass === 'unsupported' ? 'nepodporovaný typ' : 'neznámá strana';
      const sideText = side ? side.toUpperCase() : '?';
      const key = `${accountId}|${typeText}|${sideText}|${price ?? 'none'}|${reason}`;
      const existing = badgeGroups.get(key);
      if (existing) existing.count += quantity;
      else badgeGroups.set(key, { key, text: '', price, count: quantity });
      const group = badgeGroups.get(key)!;
      group.text = `${typeText} ${sideText} ${group.count} · ${reason}${price != null ? ` · ${price.toFixed(2)}` : ''}${multi ? ` · ${accountName}` : ''}`;
      continue;
    }
    const stopType = orderClass === 'stop' || orderClass === 'stopLimit';
    // Stop/StopLimit leží na spouštěcí ceně; bez ní příkaz nemá kde ležet → vynechat.
    const price = stopType ? order.stopPrice : order.price;
    if (!finite(price)) continue;
    // Jedna cena SL / TP už má čáru pozice (všechny nohy jsou na ní) — nekreslit dvakrát.
    if (exitSide && side === exitSide) {
      if (stopType && drawnStop != null && samePrice(price, drawnStop)) continue;
      if (orderClass === 'limit' && drawnTarget != null && samePrice(price, drawnTarget)) continue;
    }
    if (entrySide && side === entrySide) {
      const entryPrice = cardEntryPrice(order, orderClass);
      if (pendingEntry && finite(entryPrice) && samePrice(entryPrice, pendingEntry.price)
        && (pendingEntry.orderClass == null || pendingEntry.orderClass === orderClass)) {
        pendingEntry = null;
        continue;
      }
      if (pendingAdd && finite(entryPrice) && samePrice(entryPrice, pendingAdd.price)
        && (pendingAdd.orderClass == null || pendingAdd.orderClass === orderClass)) {
        pendingAdd = null;
        continue;
      }
    }
    const role: LiveWorkingLineRole = legsApply && side === exitSide ? (orderClass === 'limit' ? 'target-leg' : 'stop-leg') : 'order';
    // Seskupení podle účtu, typu (u nohou role), strany a ceny — klíč = id čáry, žádná duplicita.
    const key = lineId(accountId, role === 'order' ? orderClass : role, side, price);
    const group: Group = groups.get(key) ?? {
      key, role, side, orderClass, price, accountId, accountName, quantity: 0, orderIds: [], limitPrices: [],
    };
    group.quantity += quantity;
    group.orderIds.push(order.id);
    if (orderClass === 'stopLimit' && finite(order.price) && !group.limitPrices.includes(order.price)) group.limitPrices.push(order.price);
    groups.set(key, group);
  }

  // Nohy SL/TP (riziko pozice) mají přednost, pak blíž ke vstupu; zbytek do „+N dalších“.
  const reference = drawn ? drawn.entry as number : null;
  const rank = (group: Group) => (group.role === 'order' ? 1 : 0);
  const ordered = [...groups.values()].sort((a, b) => rank(a) - rank(b)
    || (reference != null ? Math.abs(a.price - reference) - Math.abs(b.price - reference) : 0)
    || b.price - a.price
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const shown = ordered.slice(0, LIVE_WORKING_MAX_LINES);
  const hidden = ordered.slice(LIVE_WORKING_MAX_LINES);

  const lines = shown.map(group => toLine(group, { multi, leader, pointValue, side: summary?.side ?? null }))
    .sort((a, b) => b.price - a.price || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const unsupported = [...badgeGroups.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const badges: LiveWorkingOrderBadge[] = unsupported.slice(0, LIVE_WORKING_MAX_BADGES).map((group): LiveWorkingOrderBadge => ({
    id: `${LIVE_WORKING_OWNER}:unsupported:${group.key}`,
    kind: 'unsupported',
    text: group.text,
    price: group.price,
    color: BADGE_COLOR,
    title: `Typ příkazu, který appka neumí kreslit ani spravovat. ${LIVE_WORKING_TITLE}.`,
    count: group.count,
  }));
  const hiddenBadges = unsupported.slice(LIVE_WORKING_MAX_BADGES);
  const overflow = hidden.length + hiddenBadges.length;
  if (overflow > 0) {
    const names = [
      ...hidden.map(group => `${lineKey(group)} ${group.price.toFixed(2)}`),
      ...hiddenBadges.map(group => group.text),
    ];
    badges.push({
      id: `${LIVE_WORKING_OWNER}:overflow`,
      kind: 'overflow',
      text: `+${overflow} dalších`,
      price: null,
      color: NEUTRAL_COLOR,
      title: `Další pracující příkazy: ${names.join(', ')}. ${LIVE_WORKING_TITLE}.`,
      count: overflow,
    });
  }
  if (lines.length === 0 && badges.length === 0) return emptyView();
  const key = JSON.stringify([lines.map(line => [line.id, line.label]), badges.map(badge => [badge.id, badge.text])]);
  return { lines, badges, key };
}

/** „SL 2 ks“ / „LMT BUY 1“ — klíč štítku (před dvojmezerou, viz `orderLineLabelParts`). */
function lineKey(group: Group): string {
  if (group.role === 'stop-leg') return `SL ${group.quantity} ks`;
  if (group.role === 'target-leg') return `TP ${group.quantity} ks`;
  return `${TYPE_LABEL[group.orderClass]} ${group.side.toUpperCase()} ${group.quantity}`;
}

function toLine(group: Group, context: {
  multi: boolean;
  leader: { accountId: number; entry: number | null } | null;
  pointValue: number | null;
  side: 'long' | 'short' | null;
}): LiveWorkingOrderLine {
  const leg = group.role !== 'order';
  const pieces = [group.price.toFixed(2)];
  // $ a body nohy jen proti vstupu TÉHOŽ účtu (leader pohledu) — jinak nic, nikdy odhad.
  const entry = leg && context.leader && context.leader.accountId === group.accountId ? context.leader.entry : null;
  if (leg && entry != null && context.side) {
    const dir = context.side === 'long' ? 1 : -1;
    if (context.pointValue != null) pieces.push(signedUsd((group.price - entry) * dir * group.quantity * context.pointValue));
    pieces.push(`${Math.abs(group.price - entry).toFixed(2)} b`);
  }
  // Jediná poznámka štítku (orderLineLabelParts bere poslední): účet, nebo „Tradovate“ u cizích příkazů.
  if (context.multi) pieces.push(group.accountName);
  else if (!leg) pieces.push('Tradovate');
  const kind: BacktestChartOrderLineKind = group.role === 'stop-leg' ? 'stopLoss' : group.role === 'target-leg' ? 'takeProfit' : 'entry';
  const color = group.role === 'stop-leg' ? STOP_LEG_COLOR : group.role === 'target-leg' ? TARGET_LEG_COLOR : group.side === 'buy' ? BUY_COLOR : SELL_COLOR;
  const limits = group.limitPrices.length ? ` (limit ${group.limitPrices.map(value => value.toFixed(2)).join(', ')})` : '';
  const what = leg
    ? `${group.role === 'stop-leg' ? 'SL' : 'TP'} noha ${group.quantity} ks na ${group.price.toFixed(2)} — SL/TP pozice není na jedné ceně`
    : `${TYPE_NAME[group.orderClass]} ${group.side.toUpperCase()} ${group.quantity} na ${group.price.toFixed(2)}${limits}`;
  return {
    id: group.key,
    ownerId: LIVE_WORKING_OWNER,
    ownerType: 'order',
    kind,
    price: group.price,
    color,
    label: `${lineKey(group)}  ${pieces.join(' · ')}`,
    draggable: false,
    cancellable: false,
    displayOnly: true,
    lineStyle: 'dotted',
    title: `${what}${context.multi ? ` (${group.accountName})` : ''}. ${LIVE_WORKING_TITLE}.`,
    role: group.role,
    side: group.side,
    orderClass: group.orderClass,
    quantity: group.quantity,
    accountId: group.accountId,
    orderIds: [...group.orderIds],
  };
}
