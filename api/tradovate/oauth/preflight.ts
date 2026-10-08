import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createTradovateAdminClient,
  getValidTradovateAccessToken,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../../../server/tradovateOAuthStore.js';
import { tradovateApiBaseUrl } from '../../../server/tradovateOAuth.js';
import { loadTradovateAccountData, TradovateAccountDataError } from '../../../server/tradovateAccountData.js';
import {
  notCheckedTradovateHistoricalSync,
  probeTradovateHistoricalSync,
  unavailableTradovateHistoricalSync,
} from '../../../server/tradovateHistoricalProbe.js';
import { handleNativeCors } from '../../../server/nativeCors.js';

/**
 * Sdílení preflightu na (uživatel, připojení, režim). Jeden „full" preflight
 * je ~17–30 Tradovate volání na login během sekundy; každé načtení LIVE nebo
 * zapnutí kopírky ho spouští znovu a 18. 9. 2026 každý pád session workeru
 * přišel uprostřed takové dávky. Web, iPhone a companion tak dostanou týž
 * výsledek, dokud není starší než PREFLIGHT_COALESCE_MS.
 */
const PREFLIGHT_COALESCE_MS = 20_000;
const recentPreflights = new Map<string, { at: number; result: Promise<unknown> }>();
function coalescePreflight<T>(key: string, now: number, read: () => Promise<T>): Promise<T> {
  const cached = recentPreflights.get(key);
  if (cached && now - cached.at < PREFLIGHT_COALESCE_MS) return cached.result as Promise<T>;
  const result = read();
  recentPreflights.set(key, { at: now, result });
  result.catch(() => { if (recentPreflights.get(key)?.result === result) recentPreflights.delete(key); });
  if (recentPreflights.size > 200) {
    for (const [candidate, entry] of recentPreflights) if (now - entry.at >= PREFLIGHT_COALESCE_MS) recentPreflights.delete(candidate);
  }
  return result;
}
/** Jen pro testy. */
export function resetTradovatePreflightCoalescingForTests(): void {
  recentPreflights.clear();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Capacitor appka vola tyto endpointy z capacitor://localhost — bez CORS
  // preflight odpovedi selze fetch jako 'Load failed'. Web je same-origin.
  if (handleNativeCors(req, res, ['GET', 'POST', 'DELETE'])) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const connectionId = typeof req.body?.connectionId === 'string' ? req.body.connectionId : '';
    const bootstrap = req.body?.mode === 'bootstrap';
    const probeOnly = req.body?.mode === 'historical-probe';
    // Probe report hostu (timeout až 8 s) nesmí držet první úplná data LIVE.
    // Studený start ho vynechá a zeptá se zvlášť (mode 'historical-probe').
    const skipProbe = req.body?.historicalProbe === false;
    if (!connectionId) return res.status(400).json({ error: 'missing-connection-id' });
    const { accessToken } = await getValidTradovateAccessToken({
      db: createTradovateAdminClient(config),
      config,
      userId,
      connectionId,
    });
    if (probeOnly) {
      const historicalSync = await coalescePreflight(
        `${userId}:${connectionId}:historical-probe`,
        Date.now(),
        () => probeTradovateHistoricalSync({ environment: config.environment, accessToken }),
      );
      return res.status(200).json({ connectionId, environment: config.environment, historicalSync });
    }
    const baseUrl = tradovateApiBaseUrl(config.environment);
    const fullKey = `${userId}:${connectionId}:full`;
    // Úplné čtení s probe je nadmnožina čtení bez něj: běžící nebo čerstvé
    // `full` se sdílí, ať starší klient (iPhone) a nový studený start
    // nepouštějí dvě dávky na stejný login. Opačně ne — starý klient by bez
    // samostatného probe zůstal u „not-checked“.
    const recentFull = skipProbe ? recentPreflights.get(fullKey) : undefined;
    const sharedFull = recentFull && Date.now() - recentFull.at < PREFLIGHT_COALESCE_MS
      ? recentFull.result as ReturnType<typeof readPreflight>
      : null;
    const readPreflight = () => Promise.all([
      loadTradovateAccountData({
        baseUrl,
        accessToken,
        detail: bootstrap ? 'bootstrap' : 'full',
      }),
      bootstrap
        ? Promise.resolve(unavailableTradovateHistoricalSync({ environment: config.environment }))
        : skipProbe
          ? Promise.resolve(notCheckedTradovateHistoricalSync({ environment: config.environment }))
          : probeTradovateHistoricalSync({ environment: config.environment, accessToken }),
    ]);
    const [result, historicalSync] = await (sharedFull ?? coalescePreflight(
      `${userId}:${connectionId}:${bootstrap ? 'bootstrap' : skipProbe ? 'full-no-probe' : 'full'}`,
      Date.now(),
      readPreflight,
    ));
    return res.status(200).json({
      connectionId,
      environment: config.environment,
      historicalSync,
      ...result,
    });
  } catch (error) {
    if (error instanceof TradovateAccountDataError && error.status === 429) {
      const retryAfterMs = Math.max(1_000, error.retryAfterMs ?? 300_000);
      res.setHeader('Retry-After', String(Math.ceil(retryAfterMs / 1_000)));
      return res.status(429).json({ error: 'tradovate-rate-limited', retryAfterMs });
    }
    if (error instanceof TradovateAccountDataError && (error.status === 401 || error.status === 403)) {
      return res.status(error.status).json({ error: 'tradovate-read-denied' });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') {
      return res.status(401).json({ error: message });
    }
    if (message === 'tradovate-not-connected' || message === 'tradovate-reauthorization-required') {
      return res.status(409).json({ error: message });
    }
    console.error('[tradovate-oauth-preflight] Read-only preflight failed:', message);
    return res.status(502).json({ error: 'tradovate-preflight-failed' });
  }
}
