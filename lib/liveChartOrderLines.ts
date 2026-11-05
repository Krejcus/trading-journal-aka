import type { BacktestChartOrderLine } from '../services/backtestOrderLines';
import { breakEvenStop, tightenBlockReason, type LiveChartPositionSummary } from './liveChartPosition';
import { liveBareLineId } from './liveBareCloseUi';

/**
 * Živá pozice leadera v grafu stejnými štítky jako návrh (Aurora odznaky
 * `BacktestOrderLinesOverlay`). Jen zobrazení a záměr uživatele: tažení SL/TP,
 * BE a × se převedou na `manage-leader-order`, který worker celý ověří u brokera
 * (INV-UI-01..04). Ceny jsou z read modelu brokera, nikdy z TV/IBKR.
 */

export const LIVE_POSITION_OWNER = 'live-position';
/** Čára čekajícího přikoupení do pozice (3. 11. 2026): × = zrušit jen přikoupení, ne pozici. */
export const LIVE_PENDING_ADD_LINE_ID = `${LIVE_POSITION_OWNER}:pending-add`;
const LONG_COLOR = '#2563eb';
const SHORT_COLOR = '#e11d48';
const SL_COLOR = '#ef4444';
const TP_COLOR = '#0f9f8f';
const MUTED_COLOR = '#64748b';

const signedUsd = (value: number) => `${value >= 0 ? '+' : '−'}$${Math.abs(value).toFixed(2)}`;

export interface LivePositionLineControls {
  /** Spravovatelný obchod leadera (vlastní nebo sledovaný) v pohledu skupiny / leadera. */
  manageable: boolean;
  /** Worker umí zavřít obchod (fáze 2d) a kopírka je čerstvě zapnutá — × u pozice. */
  canClose?: boolean;
  /** Průměrný vstup leadera od workeru — podklad pro BE. */
  entryAvg: number | null;
  /** Odeslaný posun čekající na potvrzení: čára drží novou cenu se štítkem „odesílám“. */
  pending?: { stopLoss?: number; takeProfit?: number };
  /** Čekající přikoupení do pozice (worker `leaderPositions`) — vlastní čára s × (zrušit). */
  pendingAdd?: { price: number | null; quantity: number; orderType: string } | null;
  /**
   * C8 (4. 11. 2026): vlastní holý Market bez SL/TP, který worker umí zavřít (`liveBareCloseOffer`
   * s `enabled`). Čára vstupu pak nese id cíle (`liveBareLineId`) a × je VŽDY dvoukrokové.
   */
  bareClose?: { entryOperationId: string } | null;
  pointValue: number;
  /** Živé P&L jen do štítku (`liveDisplayOpenPnl`); null = číslo brokera. Nic nerozhoduje (INV-UI-04). */
  displayOpenPnl?: number | null;
}

/** Proč posun nejde poslat (UI předkontrola; rozhoduje worker a broker). null = smí. */
export function liveLineMoveBlockReason(
  summary: LiveChartPositionSummary,
  kind: 'stopLoss' | 'takeProfit',
  price: number,
): string | null {
  if (summary.kind !== 'position') return 'Posun jde až u vyplněné pozice.';
  if (kind === 'stopLoss') {
    if (summary.stop == null) return 'SL leadera není známý.';
    if (price === summary.stop) return null;
    if (summary.target != null && (summary.side === 'long' ? price >= summary.target : price <= summary.target)) {
      return `SL musí zůstat ${summary.side === 'long' ? 'pod' : 'nad'} TP.`;
    }
    return tightenBlockReason(summary.side, summary.stop, price, summary.mark);
  }
  if (summary.target == null) return 'TP leadera není známý.';
  const toward = summary.side === 'long' ? price < summary.target : price > summary.target;
  return toward ? 'TP jde posunout jen dál od trhu (blíž by se hned vyplnil).' : null;
}

/** Stav tlačítka BE na štítku pozice. */
export function liveBreakEven(summary: LiveChartPositionSummary, entryAvg: number | null): { price: number | null; blocked: string | null } {
  const price = breakEvenStop(summary.side, entryAvg);
  if (summary.kind !== 'position') return { price: null, blocked: 'BE jde až u vyplněné pozice.' };
  // Rozjeté SL nohy (pozice z přikoupení) = žádná jedna cena SL: BE nejde, místo tichého kliknutí důvod.
  if (summary.stop == null) return { price, blocked: 'SL pozice není na jedné ceně (nebo není známý) — BE teď nejde.' };
  if (price == null) return { price, blocked: 'Průměrný vstup leadera není známý.' };
  if (summary.stop != null && price === summary.stop) return { price, blocked: 'SL už je na BE.' };
  return { price, blocked: tightenBlockReason(summary.side, summary.stop, price, summary.mark) };
}

export function livePositionChartLines(summary: LiveChartPositionSummary, controls: LivePositionLineControls): BacktestChartOrderLine[] {
  const entry = summary.entry;
  if (entry == null || !Number.isFinite(entry)) return [];
  const long = summary.side === 'long';
  const dir = long ? 1 : -1;
  const position = summary.kind === 'position';
  const canMove = controls.manageable && position;
  const scope = summary.scopeLabel ? ` ${summary.scopeLabel}` : '';
  const levelLabel = (kind: 'stopLoss' | 'takeProfit', at: number, note?: string) => {
    const pnl = (at - entry) * dir * summary.quantity * controls.pointValue;
    return `${kind === 'stopLoss' ? 'SL' : 'TP'}  ${signedUsd(pnl)} · ${Math.abs(at - entry).toFixed(2)} b${note ? ` · ${note}` : ''}`;
  };
  const be = controls.manageable ? liveBreakEven(summary, controls.entryAvg) : null;
  const openPnl = controls.displayOpenPnl ?? summary.openPnl;
  const entryLabel = position
    ? `${long ? 'LONG' : 'SHORT'} ${summary.quantity}${scope}  ${entry.toFixed(2)}${openPnl != null ? ` · ${signedUsd(openPnl)}` : ''}`
    : `${long ? 'BUY' : 'SELL'} ${summary.quantity} ${(summary.entryType ?? '').toUpperCase()}${scope}  ${entry.toFixed(2)}`;
  // Holá pozice (C8): × jen s nabídkou workeru, id cíle v id čáry (klíč × i Shift+X), vždy dvoukrokově.
  const bare = position && controls.bareClose ? controls.bareClose : null;
  const lines: BacktestChartOrderLine[] = [{
    id: bare ? liveBareLineId(bare.entryOperationId) : `${LIVE_POSITION_OWNER}:entry`, ownerId: LIVE_POSITION_OWNER, ownerType: position ? 'position' : 'order', kind: 'entry',
    price: entry,
    color: position ? (openPnl == null ? (long ? LONG_COLOR : SHORT_COLOR) : openPnl >= 0 ? '#059669' : SL_COLOR) : (long ? LONG_COLOR : SHORT_COLOR),
    label: entryLabel,
    draggable: false,
    // Čekající vstup: × = zrušit vstup (celé OSO). Pozice: × = zavřít obchod (leader, kopírka zavře kopie).
    cancellable: bare != null || (controls.manageable && (!position || controls.canClose === true)),
    cancelAction: position ? 'close-position' : 'cancel-order',
    // Zavření pozice jedním kliknutím (Filip 30. 10.); zrušení čekajícího vstupu i × holé pozice dvoukrokově.
    confirmCancel: !position || bare != null,
    ...(be && position ? {
      actions: [{
        id: 'break-even', label: 'BE', confirm: true, disabled: be.blocked != null,
        title: be.blocked ?? `SL na BE leadera ${be.price?.toFixed(2)} (bez poplatků)`,
      }],
    } : {}),
  }];
  for (const kind of ['stopLoss', 'takeProfit'] as const) {
    const live = kind === 'stopLoss' ? summary.stop : summary.target;
    const pendingPrice = kind === 'stopLoss' ? controls.pending?.stopLoss : controls.pending?.takeProfit;
    const at = pendingPrice ?? live;
    if (at == null) continue;
    lines.push({
      id: `${LIVE_POSITION_OWNER}:${kind}`, ownerId: LIVE_POSITION_OWNER, ownerType: position ? 'position' : 'order', kind,
      price: at,
      color: pendingPrice != null ? MUTED_COLOR : kind === 'stopLoss' ? SL_COLOR : TP_COLOR,
      label: levelLabel(kind, at, pendingPrice != null ? 'odesílám' : position ? undefined : 'čeká na vstup'),
      labelAt: next => levelLabel(kind, next),
      draggable: canMove && pendingPrice == null,
      // Chvění při kliknutí nesmí poslat skutečný posun.
      dragDeadZonePx: 4,
    });
  }
  const add = controls.pendingAdd;
  if (position && add && add.price != null && Number.isFinite(add.price)) {
    lines.push({
      id: LIVE_PENDING_ADD_LINE_ID, ownerId: LIVE_POSITION_OWNER, ownerType: 'order', kind: 'entry',
      price: add.price, color: long ? LONG_COLOR : SHORT_COLOR,
      label: `PŘIKOUPENÍ ${long ? 'BUY' : 'SELL'} ${add.quantity} ${add.orderType.toUpperCase()}  ${add.price.toFixed(2)} · čeká`,
      draggable: false,
      // × = zrušit jen čekající přikoupení (dvoukrokově, jako čekající vstup).
      cancellable: controls.manageable, cancelAction: 'cancel-order', confirmCancel: true,
    });
  }
  return lines;
}
