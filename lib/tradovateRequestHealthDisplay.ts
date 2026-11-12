import type { TradovateRequestHealth } from './tradovateRequestControl';

export interface TradovateRequestHealthDisplayNotice {
  key: string; tone: 'danger' | 'warn'; text: string; title: string;
  /** Presentation only: a previously ready certificate can briefly expire in transit. */
  warnAfter?: number;
  cause?: 'missing-status' | 'stale-observation' | 'control-expired' | 'unavailable';
}
export const CONTROL_REFRESH_NOTICE_GRACE_MS = 2_000;
const unknownNotice = (key: string, cause: TradovateRequestHealthDisplayNotice['cause'] = 'missing-status'): TradovateRequestHealthDisplayNotice => ({ key, tone: 'warn', cause,
  text: 'Stav přístupu k brokerovi není ověřený.', title: 'Chybí čerstvý stav kapacity a penalizace; připojený transport sám nestačí.' });

/** Read-only explanation; it never enables or disables a broker command. */
export function tradovateRequestHealthDisplay(rows: readonly TradovateRequestHealth[] | null | undefined, now: number): TradovateRequestHealthDisplayNotice[] | null {
  if (!rows?.length) return [unknownNotice('unknown')];
  return rows.flatMap<TradovateRequestHealthDisplayNotice>(row => {
    const key = String(row.brokerUserId);
    const staleObservation = !Number.isFinite(row.observedAt) || row.observedAt > now + 1_000 || now - row.observedAt > 8_000;
    // Cached hard-block evidence is not a current worker confirmation after transport loss.
    if (staleObservation) return [unknownNotice(key, 'stale-observation')];
    if (row.state === 'captcha' || row.evidence === 'captcha') return [{ key: String(row.brokerUserId), tone: 'danger' as const,
      text: 'Tradovate vyžaduje ruční ověření captcha. Požadavky k brokerovi jsou blokované.', title: row.reason ?? 'Skutečná odpověď brokera; samo se neobnoví.' }];
    if (row.state === 'cooldown') return [{ key: String(row.brokerUserId), tone: 'danger' as const,
      text: row.evidence === 'raw-429' ? 'Tradovate omezil požadavky (HTTP 429).' : 'Tradovate dočasně blokuje požadavky.',
      title: `${row.reason ?? 'Brokerová penalizace.'}${row.blockedUntil != null ? ` Lokální odhad nejbližšího konce čekání ${new Date(row.blockedUntil).toLocaleTimeString('cs-CZ')}; obnovení vyžaduje čerstvě ověřený stav.` : ''} Není to stav síťového připojení.` }];
    const stale = row.controlFreshUntil == null || !Number.isFinite(row.controlFreshUntil) || row.controlFreshUntil < now;
    if (stale || row.state === 'unavailable') return [{ key: String(row.brokerUserId), tone: 'warn' as const,
      cause: row.state === 'unavailable' ? 'unavailable' : 'control-expired',
      text: unknownNotice(key).text, title: row.reason ?? unknownNotice(key).title,
      // Never renew evidence or delay explicit failures, absent/stale status, or broker penalties.
      // The deadline is tied to the ORIGINAL certificate, not receipt time or React renders.
      ...(row.state === 'ready' && row.reason == null && row.evidence == null && row.blockedUntil == null
        && row.controlFreshUntil != null && Number.isFinite(row.controlFreshUntil)
        ? { warnAfter: row.controlFreshUntil + CONTROL_REFRESH_NOTICE_GRACE_MS } : {}),
    }];
    if (row.state === 'budget-limited') return [{ key: String(row.brokerUserId), tone: 'warn' as const,
      text: 'Lokální rozpočet požadavků je dočasně vyčerpaný.', title: row.reason ?? 'Kapacitní brána aplikace, nikoli penalizace Tradovate.' }];
    return [];
  });
}

/** Lidsky čitelný text místo surového kódu chyby Tradovate čtení (jen zobrazení). */
export function tradovateHumanErrorMessage(message: string): string {
  if (message === 'tradovate-request-identity-unavailable') return 'Jedno připojení nemá ověřenou identitu Tradovate. Zkontroluj jeho přihlášení v Připojení.';
  if (message === 'tradovate-read-pending') return 'Účty se právě aktualizují. Poslední známá data zůstávají zobrazená.';
  if (message === 'tradovate-request-budget') return 'Aplikace teď šetří dotazy na Tradovate (lokální rozpočet požadavků) — data se doplní za chvilku samy.';
  if (/^tradovate-request-/.test(message)) return 'Dotazy na Tradovate jsou dočasně omezené — data se doplní za chvilku samy.';
  return message;
}

/** Hláška o lokálním rozpočtu až po souvislém vyčerpání; po zmizení nejdřív znovu za tolik. */
export const BUDGET_NOTICE_SHOW_AFTER_MS = 5_000;
export const BUDGET_NOTICE_REPEAT_AFTER_MS = 60_000;
export interface BudgetNoticeMemory { since: number | null; shown: boolean; hiddenAt: number | null }
export const BUDGET_NOTICE_INITIAL: BudgetNoticeMemory = { since: null, shown: false, hiddenAt: null };

/**
 * Proti spamu (DEMO 10. 11.: hláška o rozpočtu v grafu se opakovala): `budget-limited`
 * (kapacitní brána aplikace, ne penalizace brokera) se ukáže až po souvislém vyčerpání
 * `BUDGET_NOTICE_SHOW_AFTER_MS` a po zmizení se nevrátí dřív než za `BUDGET_NOTICE_REPEAT_AFTER_MS`.
 * Captcha, penalizace, chybějící/zastaralý status a explicitní chyba jdou hned.
 * Pouze právě prošlý ready certifikát má krátkou rezervu pro doručení obnovy;
 * jeho původní čerstvost ani žádná execution brána se tím nemění. Jen zobrazení.
 */
export function stabilizeTradovateHealthNotices(
  notices: readonly TradovateRequestHealthDisplayNotice[] | null,
  memory: BudgetNoticeMemory,
  now: number,
): { notices: TradovateRequestHealthDisplayNotice[]; memory: BudgetNoticeMemory } {
  const isBudget = (notice: TradovateRequestHealthDisplayNotice) => notice.text === 'Lokální rozpočet požadavků je dočasně vyčerpaný.';
  const all = (notices ?? []).filter(notice => notice.warnAfter == null
    || !Number.isFinite(notice.warnAfter) || now >= notice.warnAfter);
  const budget = all.filter(isBudget);
  const others = all.filter(notice => !isBudget(notice));
  if (budget.length === 0) {
    return { notices: others, memory: { since: null, shown: false, hiddenAt: memory.shown ? now : memory.hiddenAt } };
  }
  const since = memory.since ?? now;
  const show = memory.shown || (now - since >= BUDGET_NOTICE_SHOW_AFTER_MS
    && (memory.hiddenAt == null || now - memory.hiddenAt >= BUDGET_NOTICE_REPEAT_AFTER_MS));
  return { notices: show ? [...others, ...budget] : others, memory: { since, shown: show, hiddenAt: memory.hiddenAt } };
}
