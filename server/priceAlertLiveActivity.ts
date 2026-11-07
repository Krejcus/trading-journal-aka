import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Upozornění na cenu v Live Activity (7. 11. 2026, oponentura návrhu). Jede JEN v běžné aktualizaci
 * ze skutečného plánu (tik, cron): žádné přehrávání uloženého stavu a žádná vlastní aktivita, takže
 * nemůže oživit starou pozici ani přebít rizikový stav. Jen zobrazení, úroveň uživatele, nikdy cena
 * trhu (INV-UI-04). Okamžitá je běžná notifikace, tady je zpoždění ≤ 5 s při ARM a ≤ 60 s jinak.
 */

/** Jak dlouho alert po spuštění zůstane v aktualizacích (cron běží po minutě). */
export const PRICE_ALERT_LIVE_ACTIVITY_WINDOW_MS = 90_000;
const NOTE_MAX = 40;
const READ_TIMEOUT_MS = 300;
/** Starší spuštění Island nerozbalí, řádek na kartě ale zůstane. */
const EXPAND_MAX_AGE_MS = 30_000;
/** Bez rozseknutí emoji: osamělá polovina znaku by v iOS mohla shodit celou aktualizaci. */
const shortNote = (note: string) => Array.from(note).slice(0, NOTE_MAX).join('');

export interface LiveActivityPriceAlert {
  symbol: string;
  level: number;
  condition: string;
  note: string;
  /** Spuštění v ms. */
  at: number;
}

const levelText = (level: number) => new Intl.NumberFormat('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(level);
const directionText = (condition: string) => (condition === 'up' ? 'Nahoru přes' : condition === 'down' ? 'Dolů přes' : 'Překročí');

/** Plochá pole stavu: špatný typ ve vnořeném objektu by v iOS zahodil celý rizikový stav. */
export function priceAlertStateFields(alert: LiveActivityPriceAlert) {
  return {
    priceAlertSymbol: alert.symbol,
    priceAlertLevelText: levelText(alert.level),
    priceAlertDirection: directionText(alert.condition),
    ...(alert.note ? { priceAlertNote: shortNote(alert.note) } : {}),
    priceAlertAt: alert.at / 1_000,
  };
}

/** Stav bez alertu: `end` ho nikdy nenese. */
export function withoutPriceAlert<T extends object>(state: T): T {
  const { priceAlertSymbol: _s, priceAlertLevelText: _l, priceAlertDirection: _d, priceAlertNote: _n, priceAlertAt: _a, ...rest } = state as T & Record<string, unknown>;
  return rest as unknown as T;
}

/** Rozbalení Islandu: jen první aktualizace po spuštění; bez zvuku, ten má běžná notifikace. */
export function priceAlertExpandAlert(alert: LiveActivityPriceAlert | null | undefined, lastPayloadAtMs: number, now: number): { title: string; body: string } | undefined {
  // `last_payload_at` se zapisuje jako `now` z tiku, takže pozdější spuštění se porovná až příště.
  if (!alert || alert.at <= lastPayloadAtMs || alert.at > now || now - alert.at > EXPAND_MAX_AGE_MS) return undefined;
  return { title: `🚨 ${alert.symbol} ${levelText(alert.level)}`, body: alert.note ? `${directionText(alert.condition)} · ${shortNote(alert.note)}` : directionText(alert.condition) };
}

/**
 * Poslední spuštění uživatele. Nikdy nevyhodí a má tvrdý strop: běží vedle snapshotu v tiku
 * uvnitř relay pollu. Potlačené (rozpočet) a vypnutý kanál iPhonu se nehlásí.
 */
export async function loadRecentPriceAlert(db: SupabaseClient, userId: string, now: number, timeoutMs = READ_TIMEOUT_MS): Promise<LiveActivityPriceAlert | null> {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const event = await db.from('price_alert_events').select('alert_id,symbol,level,condition,triggered_at')
      .eq('user_id', userId).is('suppressed_reason', null)
      .gte('triggered_at', new Date(now - PRICE_ALERT_LIVE_ACTIVITY_WINDOW_MS).toISOString())
      .order('triggered_at', { ascending: false }).limit(1).abortSignal(signal).maybeSingle();
    if (event.error || !event.data) return null;
    const row = event.data as { alert_id: string; symbol: string; level: number | string; condition: string; triggered_at: string };
    const level = Number(row.level);
    const at = Date.parse(row.triggered_at);
    if (!Number.isFinite(level) || !Number.isFinite(at)) return null;
    const alert = await db.from('price_alerts').select('note,channels')
      .eq('user_id', userId).eq('id', row.alert_id).abortSignal(signal).maybeSingle();
    if (alert.error) return null;
    const channels = (alert.data as { channels?: { phone?: unknown } | null } | null)?.channels;
    if (channels?.phone === false) return null;
    const note = (alert.data as { note?: string | null } | null)?.note;
    return { symbol: row.symbol, level, condition: row.condition, note: typeof note === 'string' ? note.trim() : '', at };
  } catch {
    return null;
  }
}
