/** Nejdelší čekání kostry na zbylá připojení po prvních datech (studený start). */
export const LIVE_COLD_REVEAL_CAP_MS = 2_500;

/**
 * Drží studený start v kostře, dokud běží první úplné čtení některého
 * připojeného připojení. Jen zobrazení: nic neautorizuje a po prvním odkrytí
 * (nebo stropu) už přehled nikdy znovu neschová.
 */
export const liveColdReadsPending = (
  alreadyRevealed: boolean,
  hasData: boolean,
  connectedIds: readonly string[],
  enrichment: Readonly<Record<string, { pending?: boolean } | undefined>> | undefined,
): boolean => !alreadyRevealed && hasData
  && connectedIds.some(id => enrichment?.[id]?.pending === true);
