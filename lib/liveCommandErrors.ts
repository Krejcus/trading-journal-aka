/**
 * Chyba „příkaz prokazatelně neodešel“ (10. 11. 2026): pozná se TYPEM / kódem, ne textem.
 * Hází ji desk před relay požadavkem (např. brána neověřené projekce grafu). Text zůstává
 * pro člověka; rozhodování (čekající čára, neznámý výsledek) bere jen `code`.
 */
export class LiveCommandNotSentError extends Error {
  readonly code = 'not-sent' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LiveCommandNotSentError';
  }
}

export const isLiveCommandNotSent = (reason: unknown): boolean => reason instanceof LiveCommandNotSentError
  || (typeof reason === 'object' && reason != null && (reason as { code?: unknown }).code === 'not-sent');
