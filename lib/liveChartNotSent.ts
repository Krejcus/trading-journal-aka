/**
 * Příkaz z grafu, který z téhle instance neodešel (brána, chybějící relay, odmítnutá
 * admission). Typ nese kód — záměr se z něj pozná podle pole, ne podle textu hlášky.
 * Relay admission (HTTP 400/409) má kód v `TradovateRequestError.message`; to je kód
 * serveru, ne věta pro uživatele.
 */

export const LIVE_CHART_NOT_SENT_CODE = 'live-chart-not-sent' as const;

const RELAY_NOT_SENT_CODES = new Set([
  'copier-relay-entry-busy',
  'copier-relay-preview-busy',
  'copier-relay-entry-superseded',
  'copier-relay-entry-daily-cap',
  'copier-relay-entry-conflict',
  'copier-relay-worker-disconnected',
  'copier-relay-runtime-not-found',
  'copier-relay-arm-config-conflict',
  'tighten-only',
]);

export class LiveChartNotSentError extends Error {
  readonly code = LIVE_CHART_NOT_SENT_CODE;
  readonly notSent = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'LiveChartNotSentError';
  }
}

export function liveChartNotSent(message: string): LiveChartNotSentError {
  return new LiveChartNotSentError(message);
}

/** Admission kód z `TradovateRequestError` (status 400/409). Jiná chyba → null. */
function relayRefusalCode(reason: unknown): string | null {
  if (!reason || typeof reason !== 'object') return null;
  const row = reason as { name?: unknown; status?: unknown; message?: unknown };
  if (row.name !== 'TradovateRequestError' || (row.status !== 400 && row.status !== 409)) return null;
  return typeof row.message === 'string' && row.message.length > 0 ? row.message : null;
}

export function isLiveChartNotSent(reason: unknown): boolean {
  if (reason instanceof LiveChartNotSentError) return true;
  if (reason && typeof reason === 'object') {
    const row = reason as { notSent?: unknown; code?: unknown };
    if (row.notSent === true && row.code === LIVE_CHART_NOT_SENT_CODE) return true;
  }
  const code = relayRefusalCode(reason);
  if (!code) return false;
  if (RELAY_NOT_SENT_CODES.has(code)) return true;
  return code.startsWith('copier-relay-entry-not-admitted:');
}
