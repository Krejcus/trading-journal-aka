import type { Trade } from '../types';

type CopierSnapshot = NonNullable<Trade['copierSnapshots']>[number];
type Signer = (snapshots: CopierSnapshot[]) => Promise<Array<CopierSnapshot & { url: string }>>;

// Podepsaná URL platí 3600 s (viz storageService.createCopierSnapshotSignedUrls);
// cache ji necháme žít kratší dobu, aby <img> nedostal skoro prošlý odkaz.
const THUMB_TTL_MS = 50 * 60 * 1000;

interface CachedThumb { url: string; path: string; expiresAt: number }

// Module-level cache: přežije přepínání záložek (TradeHistory se odmountuje),
// ale ne reload stránky — signed URL do localStorage záměrně neukládáme.
const cache = new Map<string, CachedThumb>();
const inFlight = new Map<string, Promise<string | null>>();

/**
 * Náhled na kartě: preferujeme snapshot po uzavření (`exit`), protože ukazuje celý
 * obchod. Bez něj bereme nejnovější podle `at`. Při více exitech opět nejnovější.
 */
export function pickCopierThumbSnapshot(snapshots: CopierSnapshot[] | undefined | null): CopierSnapshot | undefined {
  if (!snapshots || snapshots.length === 0) return undefined;
  const byNewest = (a: CopierSnapshot, b: CopierSnapshot) => b.at - a.at;
  const exits = snapshots.filter(s => s.kind === 'exit').sort(byNewest);
  if (exits.length > 0) return exits[0];
  return [...snapshots].sort(byNewest)[0];
}

/** Platné (neprošlé) náhledy z cache — pro init stavu při mountu seznamu. */
export function getCachedCopierThumbs(now = Date.now()): Map<string, string> {
  const result = new Map<string, string>();
  cache.forEach((entry, tradeId) => {
    if (entry.expiresAt > now) result.set(tradeId, entry.url);
    else cache.delete(tradeId);
  });
  return result;
}

/** Zahodí náhled (např. po chybě načtení <img>), další volání podepíše znovu. */
export function invalidateCopierThumb(tradeId: string): void {
  cache.delete(tradeId);
}

/**
 * Vrátí podepsanou URL vybraného snapshotu; sdílí rozběhnuté požadavky a cachuje
 * výsledek. `sign` je storageService.createCopierSnapshotSignedUrls (injektováno
 * kvůli testům). Vrací null, když obchod nemá snapshot nebo podpis selhal.
 */
export async function getCopierThumbUrl(
  tradeId: string,
  snapshots: CopierSnapshot[] | undefined | null,
  sign: Signer,
  now = Date.now(),
): Promise<string | null> {
  const picked = pickCopierThumbSnapshot(snapshots);
  if (!picked) return null;
  const cached = cache.get(tradeId);
  if (cached && cached.path === picked.path && cached.expiresAt > now) return cached.url;
  const pending = inFlight.get(tradeId);
  if (pending) return pending;
  const request = (async () => {
    try {
      const [signed] = await sign([picked]);
      if (!signed?.url) return null;
      cache.set(tradeId, { url: signed.url, path: picked.path, expiresAt: now + THUMB_TTL_MS });
      return signed.url;
    } catch (error) {
      console.warn('[SNAPSHOT] thumb sign failed', error);
      return null;
    } finally {
      inFlight.delete(tradeId);
    }
  })();
  inFlight.set(tradeId, request);
  return request;
}

/** Jen pro testy — vyprázdní module-level cache. */
export function __resetCopierThumbCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}
