/**
 * „Příkaz prokazatelně neodešel“ v LIVE UI (10. 11. 2026, review Codexu): rozhoduje TYP chyby
 * a strojový KÓD, nikdy text. Dvě zdroje:
 *
 * 1. Klient (desk, továrny odeslání, sestavení příkazu) před relay požadavkem hází
 *    `LiveCommandNotSentError` (kód `not-sent` + důvod).
 * 2. Relay server odmítl požadavek PŘED zařazením do fronty workeru: HTTP 400/409 s přesným
 *    kódem v těle (`TradovateRequestError.code`, `server/tradovateCopierCommandRelay.ts`
 *    `copierRelayValidationErrorStatus`), nebo 405 read-only localhostu. Porovnává se přesná
 *    shoda kódu, ne hledání v textu.
 *
 * Cokoli jiného (timeout, ztracený výsledek, chyba po převzetí workerem) je NEZNÁMÝ výsledek —
 * nikdy „neodesláno“ a nikdy důvod k opakování.
 */

export type LiveCommandNotSentReason =
  | 'client-check' | 'busy' | 'invalid-payload' | 'unsupported'
  | 'entry-busy' | 'entry-daily-cap' | 'entry-superseded' | 'entry-not-admitted'
  | 'preview-busy' | 'worker-disconnected' | 'read-only';

export class LiveCommandNotSentError extends Error {
  readonly code = 'not-sent' as const;
  constructor(message: string, readonly reason: LiveCommandNotSentReason = 'client-check') {
    super(message);
    this.name = 'LiveCommandNotSentError';
  }
}

/** Kódy relay serveru, se kterými požadavek do fronty workeru NEVSTOUPIL. */
const RELAY_NOT_ADMITTED: ReadonlyMap<string, LiveCommandNotSentReason> = new Map([
  ['copier-relay-entry-busy', 'entry-busy'],
  ['copier-relay-entry-daily-cap', 'entry-daily-cap'],
  ['copier-relay-entry-superseded', 'entry-superseded'],
  // `entry-conflict` (stejné operationId, jiný payload už ve frontě) a `idempotency-conflict`
  // záměrně NE: starší příkaz se stejným id může letět → výsledek neznámý.
  ['copier-relay-preview-busy', 'preview-busy'],
  ['copier-relay-worker-disconnected', 'worker-disconnected'],
  ['invalid-relay-command-payload', 'invalid-payload'],
  ['unsupported-relay-command', 'unsupported'],
  ['unsupported-remote-copy-command', 'unsupported'],
  ['unsupported-command', 'unsupported'],
] as const);
const RELAY_NOT_ADMITTED_PREFIX = 'copier-relay-entry-not-admitted:';
/** Pro test souladu se serverem (`copierRelayValidationErrorStatus`). */
export const LIVE_RELAY_NOT_ADMITTED_CODES: readonly string[] = [...RELAY_NOT_ADMITTED.keys()];

/**
 * Fáze relay požadavku, ve které chyba vznikla (relay klient v `services/tradovateOAuthConnection.ts`):
 * `submit` = samotný POST odeslání (server ho mohl odmítnout PŘED zařazením do fronty),
 * `accepted` = POST server přijal a chyba přišla až potom (poll výsledku, výsledek workeru,
 * timeout). Po přijetí NIKDY „neodesláno“ — příkaz mohl proběhnout (review Codexu, P2).
 */
export type LiveRelayPhase = 'submit' | 'accepted';

/** Označí chybu fází relay požadavku (vlastnost `relayPhase`); vrací tutéž chybu. */
export function withLiveRelayPhase<T>(reason: T, phase: LiveRelayPhase): T {
  if (typeof reason === 'object' && reason != null && Object.isExtensible(reason)) {
    try { Object.defineProperty(reason, 'relayPhase', { value: phase, configurable: true, enumerable: false }); } catch { /* jen značka */ }
  }
  return reason;
}

export const liveRelayPhase = (reason: unknown): LiveRelayPhase | null => {
  const phase = typeof reason === 'object' && reason != null ? (reason as { relayPhase?: unknown }).relayPhase : null;
  return phase === 'submit' || phase === 'accepted' ? phase : null;
};

/** Důvod, proč příkaz prokazatelně neodešel; null = mohl odejít (výsledek neznámý). */
export function liveCommandNotSentReason(reason: unknown): LiveCommandNotSentReason | null {
  if (reason instanceof LiveCommandNotSentError) return reason.reason;
  if (typeof reason !== 'object' || reason == null) return null;
  const phase = liveRelayPhase(reason);
  // Po přijetí relay POSTu nic není „neodesláno“, ať je kód/stav jakýkoli.
  if (phase === 'accepted') return null;
  const { code, status } = reason as { code?: unknown; status?: unknown };
  if (code === 'not-sent') {
    const own = (reason as { reason?: unknown }).reason;
    return typeof own === 'string' ? own as LiveCommandNotSentReason : 'client-check';
  }
  // HTTP stav / kód serveru rozhoduje JEN u chyby samotného odeslání (POST, fáze `submit`).
  if (phase !== 'submit') return null;
  // Read-only localhost: proxy odmítne zápis 405 ještě před jakýmkoli voláním (bez fronty).
  if (status === 405) return 'read-only';
  if ((status === 400 || status === 409) && typeof code === 'string') {
    const known = RELAY_NOT_ADMITTED.get(code);
    if (known) return known;
    if (code.startsWith(RELAY_NOT_ADMITTED_PREFIX)) return 'entry-not-admitted';
  }
  return null;
}

export const isLiveCommandNotSent = (reason: unknown): boolean => liveCommandNotSentReason(reason) != null;

const MESSAGE = (reason: unknown) => (reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : 'chyba');

/** Text pro člověka k prokazatelně neodeslanému příkazu (jen zobrazení); `texts` = vlastní znění podle důvodu. */
export function liveCommandNotSentText(reason: unknown, maxLength = 160, texts: Partial<Record<LiveCommandNotSentReason, string>> = {}): string {
  const code = liveCommandNotSentReason(reason);
  if (code && texts[code]) return texts[code]!;
  switch (code) {
    case 'entry-busy': return 'Neodesláno: jiná změna se právě zpracovává.';
    case 'entry-daily-cap': return 'Neodesláno: dosažen denní strop ručních příkazů.';
    case 'entry-superseded': return 'Neodesláno: tento pokus zastavila brzda (vypnutí kopírky).';
    case 'entry-not-admitted': return 'Neodesláno: tento pokus server nepřijal.';
    case 'read-only': return 'Neodesláno: z localhostu se k brokerovi nezapisuje (jen na produkci).';
    case 'worker-disconnected': return 'Neodesláno: worker není připojený.';
    default: return `Neodesláno: ${MESSAGE(reason).slice(0, maxLength)}`;
  }
}

/** Text k neznámému výsledku (mohlo odejít) — nikdy „neodesláno“, nic se neopakuje. */
export function liveCommandUnknownText(reason: unknown, suffix = 'zkontroluj leadera v Tradovate.'): string {
  return `Výsledek neznámý (${(reason instanceof Error ? reason.message : 'chyba').slice(0, 120)}) — ${suffix}`;
}
