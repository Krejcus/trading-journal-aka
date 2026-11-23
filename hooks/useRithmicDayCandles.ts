import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createRithmicDayCandleSource, type RithmicDayCandleSnapshot } from '../lib/rithmicDayCandleSource';
import type { LiveCandleFeed } from '../lib/liveCandleFeed';
import { rithmicLocalAuth, rithmicLocalUrl } from '../lib/rithmicLocalLink';

const NOT_CONFIGURED: RithmicDayCandleSnapshot = { status: 'unavailable', candles: [], symbol: null, capturedAt: null };
const noSubscription = () => () => undefined;
const notConfigured = () => NOT_CONFIGURED;

/**
 * Dnešní svíčky grafu deníku z místní služby Rithmicu (jen čtení, jen zobrazení). Bez služby v tomto
 * zařízení (žádný klíč ani spárování) se nic neotevírá a stav je `unavailable`.
 */
export function useRithmicDayCandles(enabled: boolean): RithmicDayCandleSnapshot & { feed: LiveCandleFeed | null } {
  const source = useMemo(() => {
    if (!enabled) return null;
    const url = rithmicLocalUrl();
    return url ? createRithmicDayCandleSource({ url, auth: rithmicLocalAuth() ?? undefined }) : null;
  }, [enabled]);
  useEffect(() => {
    if (!source) return undefined;
    source.start();
    return () => source.stop();
  }, [source]);
  const snapshot = useSyncExternalStore(source ? source.subscribe : noSubscription, source ? source.snapshot : notConfigured);
  // Živá svíčka sama mlčí, když služba neposílá čerstvou cenu tohoto trhu — graf ji smí držet napojenou pořád.
  return useMemo(() => ({ ...snapshot, feed: source?.feed ?? null }), [snapshot, source]);
}
