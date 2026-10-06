import type { Trade } from '../types';

/*
 * Data pro sdílecí kartu obchodu. Čistě výpočty bez Reactu, aby šly testovat:
 * částky se znaménkem (i ztráta má mínus), R, časy, kontrakty a úrovně pro
 * cenovou dráhu, když obchod nemá screenshot.
 */

const whole = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
const price = new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Celé dolary se znaménkem — karta se posílá dál, ne se z ní účtuje. */
export const shareMoney = (value: number): string =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}$${whole.format(Math.abs(Math.round(value)))}`;

export const shareR = (value: number): string =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(2).replace('.', ',')}R`;

export const sharePrice = (value: number | null | undefined): string =>
  value != null && Number.isFinite(value) && value > 0 ? price.format(value) : '—';

const finitePositive = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** R násobek jen ze zadaného rizika — bez něj se nic nedopočítává. */
export const tradeShareR = (trade: Pick<Trade, 'pnl' | 'riskAmount'>): number | null => {
  const risk = finitePositive(trade.riskAmount);
  return risk ? Number(trade.pnl || 0) / risk : null;
};

export const contractsLabel = (count: number): string =>
  `${count} ${count === 1 ? 'kontrakt' : count >= 2 && count <= 4 ? 'kontrakty' : 'kontraktů'}`;

export const exitReasonLabel = (reason: Trade['exitReason']): string | null =>
  reason === 'tp' ? 'TP' : reason === 'sl' ? 'SL' : reason === 'manual' ? 'ruční výstup' : null;

const entryMoment = (trade: Pick<Trade, 'entryTime' | 'timestamp' | 'date'>): Date | null => {
  const candidates = [trade.entryTime, trade.timestamp, trade.date];
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    const parsed = new Date(candidate);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
};

const hhmm = (date: Date): string =>
  date.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' });

/** „02. 10. 2026 · 09:47“ — stejný zápis data jako Karta dne. */
export const tradeShareStamp = (trade: Pick<Trade, 'entryTime' | 'timestamp' | 'date'>): string => {
  const at = entryMoment(trade);
  if (!at) return '—';
  const day = new Intl.DateTimeFormat('cs-CZ', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(at);
  return `${day} · ${hhmm(at)}`;
};

/** „09:47 → 09:59“, když je známý vstup i délka držení. */
export const tradeShareWindow = (trade: Pick<Trade, 'entryTime' | 'durationMinutes'>): string | null => {
  if (trade.entryTime == null) return null;
  const at = new Date(trade.entryTime);
  const minutes = Number(trade.durationMinutes);
  if (Number.isNaN(at.getTime()) || !Number.isFinite(minutes) || minutes < 0) return null;
  return `${hhmm(at)} → ${hhmm(new Date(at.getTime() + minutes * 60_000))}`;
};

export const tradeShareHold = (trade: Pick<Trade, 'duration' | 'durationMinutes'>): string => {
  const minutes = Number(trade.durationMinutes);
  if (Number.isFinite(minutes) && minutes > 0) {
    const m = Math.round(minutes);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  return trade.duration?.trim() || '—';
};

export type PriceLevelKind = 'tp' | 'sl' | 'entry' | 'exit';
export interface PriceLevel { kind: PriceLevelKind; price: number }
export interface PricePath {
  levels: PriceLevel[];
  entry: number;
  exit: number;
  low: number;
  high: number;
}

/**
 * Úrovně pro cenovou dráhu: vstup a výstup musí být, SL/TP jen když jsou
 * zadané (plánované mají přednost — u importů z brokera je skutečný příkaz
 * často jen ochranný). Výstup na stejné ceně jako SL/TP se nekreslí dvakrát.
 */
export const tradePricePath = (trade: Trade): PricePath | null => {
  const entry = finitePositive(trade.entryPrice);
  const exit = finitePositive(trade.exitPrice);
  if (entry == null || exit == null) return null;
  const sl = finitePositive(trade.plannedStopLoss) ?? finitePositive(trade.stopLoss);
  const tp = finitePositive(trade.plannedTakeProfit) ?? finitePositive(trade.takeProfit);
  const levels: PriceLevel[] = [];
  if (tp != null) levels.push({ kind: 'tp', price: tp });
  if (sl != null) levels.push({ kind: 'sl', price: sl });
  levels.push({ kind: 'entry', price: entry });
  if (!levels.some(level => level.kind !== 'entry' && level.price === exit)) levels.push({ kind: 'exit', price: exit });
  const prices = levels.map(level => level.price).concat(exit);
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  // Okraj, aby krajní čára neležela na hraně panelu; plochý obchod dostane rozpětí.
  const pad = Math.max((high - low) * 0.08, entry * 0.0002);
  return { levels, entry, exit, low: low - pad, high: high + pad };
};

/** Jméno na kartě: bez zavináče a e-mailové domény. */
export const tradeShareOwnerName = (user: { name?: string | null; email?: string | null } | null | undefined): string => {
  const name = user?.name?.trim();
  if (name) return name;
  const email = user?.email?.trim();
  if (email) return email.split('@')[0];
  return 'Trader';
};
