import { LiveCommandNotSentError } from './liveCommandErrors';
import type { CopierControllerStatus } from './liveCopierTypes';
import type { LiveEntryPreviewDraft } from './leaderEntryPreview';
import { supportsCopierManualEntryScaleIn } from './copierWorkerCapabilities';
import type { LocalCopierAgentStatus } from './liveCopierTypes';

/**
 * Přikoupení do otevřené pozice v UI (3. 11. 2026, docs/reviews/scale-in-design-20261102.md):
 * vstup na stranu otevřené pozice leadera z vlastních lístků dostane záměr pozice
 * (`position`) a společné SL/TP pozice. Jen zobrazení a sestavení příkazu — worker
 * vše ověří znovu (brána přikoupení) a při neshodě nic nepošle (INV-UI-01).
 */
export type LiveLeaderPosition = NonNullable<CopierControllerStatus['leaderPositions']>[number];

/** Pozice z vlastních lístků na symbolu a straně vstupu; jen s capability workeru. */
export function scaleInPositionFor(
  status: Pick<LocalCopierAgentStatus, 'capabilities' | 'controller'> | null | undefined,
  symbol: string,
  side: 'Buy' | 'Sell',
): LiveLeaderPosition | null {
  if (!status || !supportsCopierManualEntryScaleIn(status)) return null;
  return (status.controller.leaderPositions ?? []).find(position => position.symbol === symbol && position.side === side) ?? null;
}

/**
 * Vstup se SL i TP na stranu otevřené pozice = přikoupení: připojí záměr pozice, kterou
 * uživatel viděl. Ceny NIKDY nemění (INV-UI-01, oponentura diffu P1-B): SL/TP návrhu musí
 * už přesně být SL/TP pozice, jinak se nic neodešle (výjimka s důvodem). Holý Market (lišta
 * telefonu) ani opačná strana se nemění — worker je zastaví branou z flat (`account-not-flat`).
 */
export function withScaleInIntent(
  draft: LiveEntryPreviewDraft,
  status: Pick<LocalCopierAgentStatus, 'capabilities' | 'controller'> | null | undefined,
): LiveEntryPreviewDraft {
  if (draft.position || draft.stopLoss === undefined || draft.takeProfit === undefined) return draft;
  const position = scaleInPositionFor(status, draft.symbol, draft.side);
  if (!position) return draft;
  if (position.stopPrice == null || position.targetPrice == null || draft.stopLoss !== position.stopPrice || draft.takeProfit !== position.targetPrice) {
    throw new LiveCommandNotSentError(scaleInBracketsText(position));
  }
  return {
    ...draft,
    position: { mode: 'add', side: position.side, quantity: position.quantity, ticketEntryIds: [...position.ticketEntryIds].sort() },
  };
}

/** Text blokace přikoupení s jinými SL/TP, než má pozice. */
export function scaleInBracketsText(position: Pick<LiveLeaderPosition, 'stopPrice' | 'targetPrice'>): string {
  const price = (value: number | null) => (value == null ? '?' : value.toFixed(2));
  return `Přikoupení musí mít SL a TP pozice (SL ${price(position.stopPrice)}, TP ${price(position.targetPrice)}) — nic se neodeslalo.`;
}

/** Co panel objednávky ukáže a zamkne při přikoupení. */
export interface LiveTicketScaleIn {
  side: 'buy' | 'sell';
  quantity: number;
  stopLoss: number | null;
  targetPrice: number | null;
  canAdd: boolean;
  reason: string | null;
  /**
   * Jeden účet přes Rithmic (26. 11. 2026): další vstup do pozice smí mít JAKÉKOLI SL/TP (oba, jeden, žádný) a smí
   * jich čekat víc. Panel nic nevnucuje ani nezamyká — `stopLoss`/`targetPrice` jsou jen informace o pozici a
   * rozhoduje místní služba.
   */
  free?: boolean;
  /**
   * Jednotné SL/TP (Filip 26. 11. 2026): pozice už SL nebo TP má → další vstup na její stranu je převezme (panel
   * je drží na cenách pozice), takže v grafu zůstává jedna čára SL a jedna TP a jen roste počet kusů. Jen s `free`.
   */
  unify?: boolean;
  /** Čekající přikoupení (čára s × v grafu); null = žádné. */
  pendingAdd: { price: number | null; quantity: number; orderType: string } | null;
}

export function liveTicketScaleIn(position: LiveLeaderPosition): LiveTicketScaleIn {
  return {
    side: position.side === 'Buy' ? 'buy' : 'sell',
    quantity: position.quantity,
    stopLoss: position.stopPrice,
    targetPrice: position.targetPrice,
    canAdd: position.canAdd,
    reason: position.canAdd ? null : position.addBlockedReason ?? 'Přikoupení teď nejde.',
    pendingAdd: position.pendingAdd
      ? { price: position.pendingAdd.price, quantity: position.pendingAdd.quantity, orderType: position.pendingAdd.orderType } : null,
  };
}

/**
 * Jednotné SL/TP při přikoupení: návrh na stranu pozice dostane SL a TP pozice (chybějící noha = bez ní).
 * Jen sestavení návrhu — jestli vstup projde, rozhodne místní služba.
 */
export function liveUnifiedAddDraft<T extends { side: 'buy' | 'sell'; stopLoss: number | null; takeProfit: number | null }>(
  draft: T, scaleIn: Pick<LiveTicketScaleIn, 'side' | 'stopLoss' | 'targetPrice' | 'free' | 'unify'> | null | undefined,
): T {
  if (!scaleIn || scaleIn.free !== true || scaleIn.unify !== true || draft.side !== scaleIn.side) return draft;
  if (draft.stopLoss === scaleIn.stopLoss && draft.takeProfit === scaleIn.targetPrice) return draft;
  return { ...draft, stopLoss: scaleIn.stopLoss, takeProfit: scaleIn.targetPrice };
}
