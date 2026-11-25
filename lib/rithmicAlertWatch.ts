// Hlídání upozornění na cenu službou Rithmic — část v appce (24. 11. 2026). JEN OZNÁMENÍ (INV-UI-01):
// appka službě předá klíč a seznam aktivních upozornění a ukazuje, jestli služba hlídá. Čisté funkce.
import type { PriceAlert } from './priceAlerts';

/** Stav hlídání, jak ho posílá služba (zpráva `alerts` a odpověď na `alerts-key` / `alerts-set`). */
export interface RithmicAlertWatchStatus {
  count: number; keyed: boolean; feed: boolean; error: string | null;
  /** Otisk hlídaného seznamu (`id:verze`): appka podle něj pozná, že služba hlídá PŘESNĚ to, co má ona. */
  digest: string;
  /** Otisk uživatele, jehož klíč služba drží; '' = žádný. */
  user: string;
}

/** Krátký otisk textu (FNV-1a, 32 bitů). Není to ochrana — jen porovnání „je to totéž?“ mezi appkou a službou. */
export function shortTag(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
export const alertUserTag = (userId: string | null): string => (userId ? shortTag(`u:${userId.toLowerCase()}`) : '');
export const alertListDigest = (alerts: readonly { id: string; version: number }[]): string =>
  shortTag([...alerts].map((alert) => `${alert.id}:${alert.version}`).sort().join('|'));

export function parseRithmicAlertWatchStatus(raw: unknown): RithmicAlertWatchStatus | null {
  const row = raw as Partial<RithmicAlertWatchStatus> | null;
  if (!row || typeof row !== 'object' || typeof row.count !== 'number' || !Number.isFinite(row.count) || typeof row.keyed !== 'boolean' || typeof row.feed !== 'boolean') return null;
  return { count: Math.max(0, Math.floor(row.count)), keyed: row.keyed, feed: row.feed, error: typeof row.error === 'string' && row.error ? row.error.slice(0, 200) : null,
    digest: typeof row.digest === 'string' ? row.digest.slice(0, 16) : '', user: typeof row.user === 'string' ? row.user.slice(0, 16) : '' };
}

/** Upozornění, která má služba hlídat: jen aktivní a serverem potvrzená (mají verzi). */
export interface RithmicWatchedAlert { id: string; symbol: string; price: number; condition: string; conditionAuto: boolean; frequency: string; version: number; expiresAt: null }

export function rithmicWatchedAlerts(alerts: readonly PriceAlert[]): RithmicWatchedAlert[] {
  return alerts
    .filter((alert) => (alert.status ?? 'active') === 'active' && Number.isSafeInteger(alert.version) && (alert.version as number) >= 1)
    .map((alert) => ({ id: alert.id, symbol: alert.symbol, price: alert.price, condition: alert.condition, conditionAuto: alert.conditionAuto === true, frequency: alert.frequency, version: alert.version as number, expiresAt: null }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, 50);
}

const plural = (n: number) => (n === 1 ? 'upozornění' : 'upozornění');

/**
 * Text „kdo hlídá“ pro seznam upozornění; null = nikdo (UI pak říká, že upozornění teď nikdo nehlídá).
 * Hlídá se jen tehdy, když služba má klíč TOHOTO uživatele, běží jí ceny a drží přesně stejný seznam (otisk
 * `id:verze`), jaký má appka — stejný počet nestačí (INV-UI-03).
 */
export function rithmicAlertWatchLabel(status: RithmicAlertWatchStatus | null, expected: { digest: string; user: string }): string | null {
  if (!status || !status.keyed || !status.feed) return null;
  if (!expected.user || status.user !== expected.user || status.digest !== expected.digest) return null;
  return `Hlídá služba Rithmic na Macu · ${status.count} ${plural(status.count)}${status.error ? ` · poslední ohlášení selhalo (${status.error})` : ''}`;
}

/** Proč se nehlídá — krátká věta pro seznam; null = hlídá se nebo se to neví. */
export function rithmicAlertWatchProblem(status: RithmicAlertWatchStatus | null, linkOpen: boolean, userTag = ''): string | null {
  if (!linkOpen) return 'Služba Rithmic na Macu není připojená — upozornění teď nikdo nehlídá.';
  if (!status) return 'Služba Rithmic na Macu upozornění neumí hlídat (starší verze) — je potřeba ji spustit znovu.';
  if (!status.keyed) return 'Služba Rithmic čeká na klíč od přihlášené appky.';
  if (userTag && status.user !== userTag) return 'Služba Rithmic hlídá upozornění jiného účtu appky — předávám jí klíč tohoto.';
  if (!status.feed) return 'Službě Rithmic teď nejdou ceny z burzy — upozornění se spustí až po obnově.';
  return null;
}
