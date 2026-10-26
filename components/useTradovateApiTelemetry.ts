import { useEffect, useSyncExternalStore } from 'react';
import {
  getTradovateApiTelemetrySnapshot,
  refreshTradovateApiTelemetry,
  subscribeTradovateApiTelemetry,
} from '../lib/tradovateApiTelemetry';

/**
 * Telemetrie Tradovate API jen pro komponentu, která ji právě zobrazuje.
 * Dřív ji odebíral `useTradovateLiveData` v `App`: začátek i konec každého
 * požadavku pak synchronně překreslil celou appku včetně LIVE (~2 rendery/s,
 * dlouhé snímky po `response.json()`). Jen zobrazení — backoff a pauzy čtou
 * snapshot přímo.
 */
export function useTradovateApiTelemetry() {
  const telemetry = useSyncExternalStore(
    subscribeTradovateApiTelemetry,
    getTradovateApiTelemetrySnapshot,
    getTradovateApiTelemetrySnapshot,
  );
  useEffect(() => {
    // Posouvá klouzavá okna (minuta/hodina/den) i bez nových požadavků.
    refreshTradovateApiTelemetry();
    const timer = window.setInterval(refreshTradovateApiTelemetry, 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return telemetry;
}
