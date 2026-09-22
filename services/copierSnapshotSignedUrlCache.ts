import type { Trade } from '../types';

type Snapshot = NonNullable<Trade['copierSnapshots']>[number];
type SignedSnapshot = Snapshot & { url: string };
type BatchSignedUrl = { error?: string | null; path: string | null; signedUrl: string | null };

const SIGNED_URL_CACHE_TTL_MS = 50 * 60 * 1000;
const SIGNED_URL_CACHE_MAX_ENTRIES = 128;
const cache = new Map<string, { expiresAt: number; url: string }>();

const cacheKey = (scope: string, path: string) => JSON.stringify([scope, path]);

/** Signs only missing paths in one Storage request and returns results in the
 * original snapshot order. The cache is memory-only and auth-scoped. */
export async function getCachedCopierSnapshotSignedUrls(
  scope: string,
  snapshots: readonly Snapshot[],
  signBatch: (paths: string[]) => Promise<readonly BatchSignedUrl[]>,
  now = Date.now(),
): Promise<SignedSnapshot[]> {
  for (const [key, cached] of cache) {
    if (cached.expiresAt <= now) cache.delete(key);
  }

  const urls = new Map<string, string>();
  const missing: string[] = [];
  for (const snapshot of snapshots) {
    const cached = cache.get(cacheKey(scope, snapshot.path));
    if (cached && cached.expiresAt > now) urls.set(snapshot.path, cached.url);
    else if (!missing.includes(snapshot.path)) missing.push(snapshot.path);
  }

  if (missing.length > 0) {
    const signed = await signBatch(missing);
    for (const item of signed) {
      if (item.error || !item.path || !item.signedUrl || !missing.includes(item.path)) continue;
      const key = cacheKey(scope, item.path);
      if (cache.size >= SIGNED_URL_CACHE_MAX_ENTRIES && !cache.has(key)) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      cache.set(key, { expiresAt: now + SIGNED_URL_CACHE_TTL_MS, url: item.signedUrl });
      urls.set(item.path, item.signedUrl);
    }
  }

  return snapshots.flatMap(snapshot => {
    const url = urls.get(snapshot.path);
    return url ? [{ ...snapshot, url }] : [];
  });
}

export function __resetCopierSnapshotSignedUrlCacheForTests(): void {
  cache.clear();
}
