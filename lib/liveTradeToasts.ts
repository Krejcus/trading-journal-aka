import type { CopierCopyEvent } from '../services/copierRuntimeController';

/**
 * Notifikace obchodů v LIVE grafu (karta B, vlevo dole). Jen zobrazení
 * událostí kopírky ze statusu workeru. Událost vzniká ze změny leadera,
 * NE z potvrzené kopie: `followers` je počet zapnutých followerů skupiny.
 * Tečky proto nikdy netvrdí „zkopírováno“ — zelené jen za zapnuté kopírky
 * („kopírka je zrcadlí“), jinak šedé.
 */

export const TRADE_TOAST_MS = 2_000;
export const TRADE_TOAST_MAX = 3;

export type TradeToastTone = 'blue' | 'violet' | 'red' | 'teal' | 'green' | 'amber' | 'muted';

export interface TradeToast {
  id: string;
  at: number;
  tone: TradeToastTone;
  badge: string;
  title: string;
  /** Druhý řádek: čísla. */
  line: string;
  pnl: number | null;
  /** Leader + zapnutí followeři skupiny (tečky; ne důkaz kopie). */
  accounts: number;
  /** Problém: nezmizí sám. */
  sticky: boolean;
}

const price = (value: number | undefined) => (value == null ? '—' : value.toFixed(2));

export function copyEventToast(event: CopierCopyEvent): TradeToast | null {
  const base = { id: event.id, at: event.at, accounts: 1 + Math.max(0, event.followers), sticky: false };
  const pos = `${event.side === 'Long' ? 'LONG' : 'SHORT'} ${event.quantity} ${event.symbol}`;
  switch (event.kind) {
    case 'order-placed': {
      const action = `${event.side === 'Long' ? 'BUY' : 'SELL'} ${event.quantity} @ ${price(event.price)}`;
      const levels = [event.stopPrice != null ? `SL ${price(event.stopPrice)}` : null, event.targetPrice != null ? `TP ${price(event.targetPrice)}` : null].filter(Boolean).join(' · ');
      return { ...base, tone: 'blue', badge: 'Zadáno', title: 'Příkaz zadán', line: levels ? `${action} · ${levels}` : action, pnl: null };
    }
    case 'bracket-placed':
      return { ...base, tone: 'teal', badge: 'SL/TP', title: 'SL a TP nastaveny', line: `SL ${price(event.stopPrice)} · TP ${price(event.targetPrice)}`, pnl: null };
    case 'entry':
      return { ...base, tone: 'violet', badge: 'Vyplněno', title: 'Vstup vyplněn', line: pos, pnl: null };
    case 'scale-in':
      return { ...base, tone: 'violet', badge: 'Přidáno', title: 'Přidáno do pozice', line: pos, pnl: null };
    case 'scale-out':
      return { ...base, tone: 'teal', badge: 'Část', title: 'Částečný výstup', line: pos, pnl: event.pnlUsd ?? null };
    case 'flip':
      return { ...base, tone: 'amber', badge: 'Otočeno', title: 'Pozice otočena', line: pos, pnl: null };
    case 'sl-moved': {
      const breakEven = event.levelPnlUsd != null && Math.abs(event.levelPnlUsd) < 0.005;
      return breakEven
        ? { ...base, tone: 'amber', badge: 'BE', title: 'SL na break-even', line: `SL → ${price(event.price)}`, pnl: null }
        : { ...base, tone: 'red', badge: 'SL', title: 'SL posunut', line: `SL → ${price(event.price)}`, pnl: event.levelPnlUsd ?? null };
    }
    case 'tp-moved':
      return { ...base, tone: 'teal', badge: 'TP', title: 'TP posunut', line: `TP → ${price(event.price)}`, pnl: event.levelPnlUsd ?? null };
    case 'exit':
      return event.exitReason === 'tp'
        ? { ...base, tone: 'green', badge: 'TP', title: 'TP zasažen', line: pos, pnl: event.pnlUsd ?? null }
        : event.exitReason === 'sl'
          ? { ...base, tone: 'red', badge: 'SL', title: 'SL zasažen', line: pos, pnl: event.pnlUsd ?? null }
          : { ...base, tone: 'muted', badge: 'Výstup', title: 'Pozice zavřena', line: pos, pnl: event.pnlUsd ?? null };
    case 'order-canceled':
      return { ...base, tone: 'muted', badge: 'Zrušeno', title: 'Příkaz zrušen', line: `${event.side === 'Long' ? 'BUY' : 'SELL'} ${event.quantity} ${event.symbol}`, pnl: null };
    case 'order-moved':
      return { ...base, tone: 'blue', badge: 'Posun', title: 'Příkaz posunut', line: `${event.symbol} → ${price(event.price)}`, pnl: null };
    case 'follower-cut':
      return { ...base, tone: 'amber', badge: 'Pozor', title: 'Follower odpojen (denní limit)', line: event.accountId != null ? `účet …${String(event.accountId).slice(-3)}` : event.symbol, pnl: event.realizedPnlUsd ?? null, sticky: true, accounts: 0 };
    default:
      return null;
  }
}

/** Nové události od posledního zobrazení (první načtení si komponenta jen zapamatuje). */
export function newCopyEvents(events: readonly CopierCopyEvent[] | undefined, seen: ReadonlySet<string>): CopierCopyEvent[] {
  return (events ?? []).filter(event => !seen.has(event.id));
}
