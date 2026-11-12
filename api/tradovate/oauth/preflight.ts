import { TradovateRequestControlError } from '../../../server/tradovateServerRequestControl.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createTradovateAdminClient,
  getValidTradovateAccessToken,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../../../server/tradovateOAuthStore.js';
import { tradovateApiBaseUrl } from '../../../server/tradovateOAuth.js';
import { TradovateAccountDataError } from '../../../server/tradovateAccountData.js';
import {
  notCheckedTradovateHistoricalSync,
  probeTradovateHistoricalSync,
  unavailableTradovateHistoricalSync,
} from '../../../server/tradovateHistoricalProbe.js';
import { peekTradovateSharedRead, sharedTradovateRead, TradovateSharedReadDeferred } from '../../../server/tradovateSharedRead.js';
import { readSharedTradovateAccounts } from '../../../server/tradovateSharedAccountState.js';
import { handleNativeCors } from '../../../server/nativeCors.js';

/** Compatibility test hook: shared state now lives in Postgres, not process memory. */
export function resetTradovatePreflightCoalescingForTests(): void {}

/**
 * Kolik dotazů u brokera stojí čtení účtů (viz `loadTradovateAccountData`): společné seznamy
 * a čtení na každý účet. Jen pro poradní kontrolu kapacity; skutečné jednotky si bere každý dotaz.
 */
export function preflightReadCost(detail: 'bootstrap' | 'full', withHistoricalProbe = false): { base: number; perAccount: number } {
  if (detail === 'bootstrap') return { base: 4, perAccount: 1 };
  // 8 seznamů + čtení kontraktů (běží v každém dni s obchodem nebo příkazem) + případný probe
  // historických reportů. Raději o jednotku víc: podhodnocená cena vrací plýtvání.
  return { base: 8 + 1 + (withHistoricalProbe ? 1 : 0), perAccount: 4 };
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
    const skipProbe = !bootstrap && req.body?.historicalProbe === false;
    if (!connectionId) return res.status(400).json({ error: 'missing-connection-id' });
    const db = createTradovateAdminClient(config);
    const { accessToken, apiHosts, fetchImpl, brokerUserId } = await getValidTradovateAccessToken({
      db,
      config,
      userId,
      connectionId,
    });
    const baseUrl = tradovateApiBaseUrl(config.environment, apiHosts);
    const context = { db, userId, connectionId, environment: config.environment, route: JSON.stringify([baseUrl, apiHosts ?? null]) };
    const probe = async () => (await sharedTradovateRead({ context, channel: 'history:capability:v1', ttlMs: 600_000,
      read: () => probeTradovateHistoricalSync({ environment: config.environment, accessToken, apiHosts, fetchImpl }),
      cacheable: value => value.status === 'available',
    })).value;
    if (probeOnly) {
      return res.status(200).json({ connectionId, environment: config.environment, historicalSync: await probe() });
    }
    const [result, historicalSync] = await Promise.all([
      readSharedTradovateAccounts({ context, baseUrl, accessToken, fetchImpl, brokerUserId, detail: bootstrap ? 'bootstrap' : 'full' }),
      bootstrap ? unavailableTradovateHistoricalSync({ environment: config.environment })
        : skipProbe ? peekTradovateSharedRead(context, 'history:capability:v1').then(cached => cached ?? notCheckedTradovateHistoricalSync({ environment: config.environment })) : probe(),
    ]);
    return res.status(200).json({
      connectionId,
      environment: config.environment,
      historicalSync,
      ...result,
    });
  } catch (error) {
    if (error instanceof TradovateSharedReadDeferred) return res.status(503).json({ error: error.message, retryAfterMs: error.retryAfterMs, notDispatched: true });
    if (error instanceof TradovateRequestControlError) return res.status(503).json({
      error: error.code, retryAfterMs: error.retryAfterMs, notDispatched: error.notDispatched,
      captchaRequired: error.snapshot?.captchaRequired === true,
      // Bezplatné předběžné odmítnutí: klient smí zkoušet stálým tempem, nic se tím nespotřebuje.
      ...(error.precheck ? { precheck: true } : {}),
    });
    if (error instanceof TradovateAccountDataError && error.status === 429) {
      const retryAfterMs = Math.max(1_000, error.retryAfterMs ?? 3_600_000);
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
