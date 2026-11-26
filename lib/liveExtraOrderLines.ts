import type { BacktestChartOrderLine } from '../services/backtestOrderLines';
import { LIVE_POSITION_OWNER } from './liveChartOrderLines';

/**
 * Další vlastní příkazy v LIVE grafu vedle „hlavní“ skupiny čar (26. 11. 2026, víc čekajících vstupů najednou):
 * každý další čekající vstup má vlastní čáru vstupu a plánovaného SL/TP, každá noha pozice s JINOU cenou, než
 * ukazuje hlavní čára SL/TP, má vlastní čáru. Čára nese id příkazu u brokera — tažení i × míří přesně na něj
 * (ne na cenu; dva příkazy na stejné ceně se nesmí splést). Jen zobrazení a záměr: příkaz ověří místní služba.
 */
export const LIVE_ORDER_OWNER_PREFIX = 'live-order:';
export const LIVE_LEG_OWNER_PREFIX = 'live-leg:';

const LONG_COLOR = '#2563eb';
const SHORT_COLOR = '#e11d48';
const SL_COLOR = '#ef4444';
const TP_COLOR = '#0f9f8f';

export interface LiveExtraEntry {
  orderId: string;
  side: 'Buy' | 'Sell';
  quantity: number;
  price: number;
  entryType: 'Limit' | 'Stop';
  plannedStop?: number;
  plannedTarget?: number;
  /** Zadaný při otevřené pozici: služba ho po zavření pozice sama zruší. */
  add: boolean;
}

export interface LiveExtraLeg {
  orderId: string;
  role: 'stop' | 'target';
  price: number;
  quantity: number;
}

export interface LiveExtraOrders {
  entries: readonly LiveExtraEntry[];
  legs: readonly LiveExtraLeg[];
}

export interface LiveExtraLineOptions {
  pointValue: number;
  /** Graf smí příkazy měnit (služba je dostupná, ne jen pro čtení, ne přehrávání). */
  manageable: boolean;
  /** Otevřená pozice (průměr a směr) — podklad pro výsledek u nohou pozice. Bez ní se výsledek neuvádí. */
  position?: { entry: number; long: boolean } | null;
  /** Čáry, jejichž změna právě čeká na potvrzení služby (id čáry) — netáhnou se a mají štítek „mění se“. */
  pending?: ReadonlySet<string>;
}

const signedUsd = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toFixed(2)}`;

export const liveExtraEntryLineId = (orderId: string, kind: 'entry' | 'stopLoss' | 'takeProfit') => `${LIVE_POSITION_OWNER}:order:${orderId}:${kind}`;
export const liveExtraLegLineId = (orderId: string) => `${LIVE_POSITION_OWNER}:leg:${orderId}`;

/** Na který příkaz čára míří: další čekající vstup (a jeho plánované nohy), nebo noha pozice. Jiné čáry → null. */
export function liveExtraLineTarget(line: Pick<BacktestChartOrderLine, 'ownerId'>): { type: 'order' | 'leg'; orderId: string } | null {
  if (line.ownerId.startsWith(LIVE_ORDER_OWNER_PREFIX)) return { type: 'order', orderId: line.ownerId.slice(LIVE_ORDER_OWNER_PREFIX.length) };
  if (line.ownerId.startsWith(LIVE_LEG_OWNER_PREFIX)) return { type: 'leg', orderId: line.ownerId.slice(LIVE_LEG_OWNER_PREFIX.length) };
  return null;
}

export function liveExtraOrderLines(extra: LiveExtraOrders | null | undefined, options: LiveExtraLineOptions): BacktestChartOrderLine[] {
  if (!extra) return [];
  const lines: BacktestChartOrderLine[] = [];
  const changing = (id: string) => options.pending?.has(id) === true;
  for (const entry of extra.entries) {
    if (!Number.isFinite(entry.price) || !(entry.quantity > 0)) continue;
    const long = entry.side === 'Buy';
    const dir = long ? 1 : -1;
    const ownerId = `${LIVE_ORDER_OWNER_PREFIX}${entry.orderId}`;
    const entryId = liveExtraEntryLineId(entry.orderId, 'entry');
    const legLabel = (kind: 'stopLoss' | 'takeProfit', at: number, note: string, from: number = entry.price) => {
      const pnl = (at - from) * dir * entry.quantity * options.pointValue;
      return `${kind === 'stopLoss' ? 'SL' : 'TP'} ${entry.quantity}  ${signedUsd(pnl)} · ${Math.abs(at - from).toFixed(2)} b · ${note}`;
    };
    lines.push({
      id: entryId, ownerId, ownerType: 'order', kind: 'entry', price: entry.price,
      color: long ? LONG_COLOR : SHORT_COLOR,
      label: `${entry.add ? 'PŘIKOUPENÍ ' : ''}${long ? 'BUY' : 'SELL'} ${entry.quantity} ${entry.entryType.toUpperCase()}  ${entry.price.toFixed(2)} · ${changing(entryId) ? 'mění se' : 'čeká na vyplnění'}`,
      draggable: options.manageable && !changing(entryId),
      dragDeadZonePx: 4,
      cancellable: options.manageable, cancelAction: 'cancel-order',
    });
    for (const kind of ['stopLoss', 'takeProfit'] as const) {
      const at = kind === 'stopLoss' ? entry.plannedStop : entry.plannedTarget;
      if (at === undefined || !Number.isFinite(at)) continue;
      const id = liveExtraEntryLineId(entry.orderId, kind);
      lines.push({
        id, ownerId, ownerType: 'order', kind, price: at,
        color: kind === 'stopLoss' ? SL_COLOR : TP_COLOR,
        label: legLabel(kind, at, changing(id) ? 'mění se' : 'čeká na vstup'),
        labelAt: next => legLabel(kind, next, 'čeká na vstup'),
        labelForEntry: (nextEntry: number) => legLabel(kind, at, 'čeká na vstup', nextEntry),
        draggable: options.manageable && !changing(id) && !changing(entryId),
        dragDeadZonePx: 4,
      });
    }
  }
  for (const leg of extra.legs) {
    if (!Number.isFinite(leg.price) || !(leg.quantity > 0)) continue;
    const kind = leg.role === 'stop' ? 'stopLoss' as const : 'takeProfit' as const;
    const id = liveExtraLegLineId(leg.orderId);
    const label = (at: number, note?: string) => {
      const name = `${leg.role === 'stop' ? 'SL' : 'TP'} ${leg.quantity}`;
      const position = options.position;
      if (!position) return `${name}  ${at.toFixed(2)}${note ? ` · ${note}` : ''}`;
      const pnl = (at - position.entry) * (position.long ? 1 : -1) * leg.quantity * options.pointValue;
      return `${name}  ${signedUsd(pnl)} · ${Math.abs(at - position.entry).toFixed(2)} b${note ? ` · ${note}` : ''}`;
    };
    lines.push({
      id, ownerId: `${LIVE_LEG_OWNER_PREFIX}${leg.orderId}`, ownerType: 'position', kind, price: leg.price,
      color: leg.role === 'stop' ? SL_COLOR : TP_COLOR,
      label: label(leg.price, changing(id) ? 'mění se' : 'část pozice'),
      labelAt: next => label(next),
      draggable: options.manageable && !changing(id),
      dragDeadZonePx: 4,
    });
  }
  return lines;
}

/** Klíč pro překreslení grafu: změna kteréhokoli dalšího příkazu. */
export const liveExtraOrdersKey = (extra: LiveExtraOrders | null | undefined): string => (extra
  ? [...extra.entries.map(entry => `e${entry.orderId}@${entry.price}x${entry.quantity}/${entry.plannedStop ?? ''}/${entry.plannedTarget ?? ''}`),
    ...extra.legs.map(leg => `l${leg.orderId}@${leg.price}x${leg.quantity}`)].join('|')
  : '');
