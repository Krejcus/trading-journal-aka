import type { TradovateRequestHealth } from './tradovateRequestControl';

export interface TradovateRequestHealthDisplayNotice { key: string; tone: 'danger' | 'warn'; text: string; title: string }
const unknownNotice = (key: string): TradovateRequestHealthDisplayNotice => ({ key, tone: 'warn',
  text: 'Stav přístupu k brokerovi není ověřený.', title: 'Chybí čerstvý stav kapacity a penalizace; připojený transport sám nestačí.' });

/** Read-only explanation; it never enables or disables a broker command. */
export function tradovateRequestHealthDisplay(rows: readonly TradovateRequestHealth[] | null | undefined, now: number): TradovateRequestHealthDisplayNotice[] | null {
  if (!rows?.length) return [unknownNotice('unknown')];
  return rows.flatMap<TradovateRequestHealthDisplayNotice>(row => {
    const key = String(row.brokerUserId);
    const staleObservation = !Number.isFinite(row.observedAt) || row.observedAt > now + 1_000 || now - row.observedAt > 8_000;
    // Cached hard-block evidence is not a current worker confirmation after transport loss.
    if (staleObservation) return [unknownNotice(key)];
    if (row.state === 'captcha' || row.evidence === 'captcha') return [{ key: String(row.brokerUserId), tone: 'danger' as const,
      text: 'Tradovate vyžaduje ruční ověření captcha. Požadavky k brokerovi jsou blokované.', title: row.reason ?? 'Skutečná odpověď brokera; samo se neobnoví.' }];
    if (row.state === 'cooldown') return [{ key: String(row.brokerUserId), tone: 'danger' as const,
      text: row.evidence === 'raw-429' ? 'Tradovate omezil požadavky (HTTP 429).' : 'Tradovate dočasně blokuje požadavky.',
      title: `${row.reason ?? 'Brokerová penalizace.'}${row.blockedUntil != null ? ` Lokální odhad nejbližšího konce čekání ${new Date(row.blockedUntil).toLocaleTimeString('cs-CZ')}; obnovení vyžaduje čerstvě ověřený stav.` : ''} Není to stav síťového připojení.` }];
    const stale = row.controlFreshUntil == null || row.controlFreshUntil < now;
    if (stale || row.state === 'unavailable') return [{ key: String(row.brokerUserId), tone: 'warn' as const,
      text: unknownNotice(key).text, title: row.reason ?? unknownNotice(key).title }];
    if (row.state === 'budget-limited') return [{ key: String(row.brokerUserId), tone: 'warn' as const,
      text: 'Lokální rozpočet požadavků je dočasně vyčerpaný.', title: row.reason ?? 'Kapacitní brána aplikace, nikoli penalizace Tradovate.' }];
    return [];
  });
}
