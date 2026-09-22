import type { Trade } from '../types';

type CopierSnapshot = NonNullable<Trade['copierSnapshots']>[number];
type Signer = (snapshots: CopierSnapshot[]) => Promise<Array<CopierSnapshot & { url: string }>>;

// Podepsaná URL platí 3600 s (viz storageService.createCopierSnapshotSignedUrls);
// cache ji necháme žít kratší dobu, aby <img> nedostal skoro prošlý odkaz.
const THUMB_TTL_MS = 50 * 60 * 1000;

interface CachedThumb { url: string; path: string; expiresAt: number }
export interface CopierThumbCandidate {
  tradeId: string;
  snapshots: Trade['copierSnapshots'];
}

// Module-level cache: přežije přepínání záložek (TradeHistory se odmountuje),
// ale ne reload stránky — signed URL do localStorage záměrně neukládáme.
const cache = new Map<string, CachedThumb>();
const inFlight = new Map<string, Promise<string | null>>();
const latestPath = new Map<string, string>();
const cacheKey = (scope: string, tradeId: string) => JSON.stringify([scope, tradeId]);
const requestKey = (scope: string, tradeId: string, path: string) => JSON.stringify([scope, tradeId, path]);

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
export function getCachedCopierThumbs(scope: string, now = Date.now()): Map<string, string> {
  const result = new Map<string, string>();
  cache.forEach((entry, key) => {
    const [entryScope, tradeId] = JSON.parse(key) as [string, string];
    if (entry.expiresAt <= now) cache.delete(key);
    else if (entryScope === scope) result.set(tradeId, entry.url);
  });
  return result;
}

/** Zahodí náhled (např. po chybě načtení <img>), další volání podepíše znovu. */
export function invalidateCopierThumb(scope: string, tradeId: string): void {
  cache.delete(cacheKey(scope, tradeId));
}

export function hasCurrentCopierThumb(scope: string, tradeId: string, snapshots: Trade['copierSnapshots'], now = Date.now()): boolean {
  const picked = pickCopierThumbSnapshot(snapshots);
  const cached = cache.get(cacheKey(scope, tradeId));
  return Boolean(picked && cached && cached.path === picked.path && cached.expiresAt > now);
}

/** Podepíše všechny chybějící miniatury jedním Storage požadavkem. Cache i
 * rozběhnuté požadavky jsou oddělené podle přihlášeného vlastníka. */
export async function prefetchCopierThumbUrls(
  scope: string,
  candidates: readonly CopierThumbCandidate[],
  sign: Signer,
  now = Date.now(),
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const pending: Array<{ tradeId: string; promise: Promise<string | null> }> = [];
  const missing: Array<{ tradeId: string; key: string; pendingKey: string; snapshot: CopierSnapshot }> = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const tradeId = String(candidate.tradeId);
    if (seen.has(tradeId)) continue;
    seen.add(tradeId);
    const snapshot = pickCopierThumbSnapshot(candidate.snapshots);
    if (!snapshot) continue;
    const key = cacheKey(scope, tradeId);
    const pendingKey = requestKey(scope, tradeId, snapshot.path);
    latestPath.set(key, snapshot.path);
    const cached = cache.get(key);
    if (cached && cached.path === snapshot.path && cached.expiresAt > now) {
      result.set(tradeId, cached.url);
      continue;
    }
    const existing = inFlight.get(pendingKey);
    if (existing) pending.push({ tradeId, promise: existing });
    else missing.push({ tradeId, key, pendingKey, snapshot });
  }

  if (missing.length > 0) {
    const batch = (async () => {
      try {
        const signed = await sign(missing.map(item => item.snapshot));
        const byPath = new Map(signed.filter(item => item?.url).map(item => [item.path, item.url]));
        return new Map(missing.map(item => {
          const url = byPath.get(item.snapshot.path) ?? null;
          if (url && latestPath.get(item.key) === item.snapshot.path) {
            cache.set(item.key, { url, path: item.snapshot.path, expiresAt: now + THUMB_TTL_MS });
          }
          return [item.pendingKey, url] as const;
        }));
      } catch (error) {
        console.warn('[SNAPSHOT] thumb sign failed', error);
        return new Map(missing.map(item => [item.pendingKey, null] as const));
      }
    })();

    for (const item of missing) {
      const promise = batch.then(urls => urls.get(item.pendingKey) ?? null).finally(() => {
        if (inFlight.get(item.pendingKey) === promise) inFlight.delete(item.pendingKey);
      });
      inFlight.set(item.pendingKey, promise);
      pending.push({ tradeId: item.tradeId, promise });
    }
  }

  const resolved = await Promise.all(pending.map(async item => [item.tradeId, await item.promise] as const));
  resolved.forEach(([tradeId, url]) => { if (url) result.set(tradeId, url); });
  return result;
}

/**
 * Vrátí podepsanou URL vybraného snapshotu; sdílí rozběhnuté požadavky a cachuje
 * výsledek. `sign` je storageService.createCopierSnapshotSignedUrls (injektováno
 * kvůli testům). Vrací null, když obchod nemá snapshot nebo podpis selhal.
 */
export async function getCopierThumbUrl(
  scope: string,
  tradeId: string,
  snapshots: CopierSnapshot[] | undefined | null,
  sign: Signer,
  now = Date.now(),
): Promise<string | null> {
  return (await prefetchCopierThumbUrls(scope, [{ tradeId, snapshots }], sign, now)).get(tradeId) ?? null;
}

/** Jen pro testy — vyprázdní module-level cache. */
export function __resetCopierThumbCacheForTests(): void {
  cache.clear();
  inFlight.clear();
  latestPath.clear();
}
