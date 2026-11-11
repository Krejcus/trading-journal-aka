import { assertTradovateBackgroundCapacity, TradovateRequestControlError } from '../../../server/tradovateServerRequestControl.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createTradovateAdminClient,
  getValidTradovateAccessToken,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../../../server/tradovateOAuthStore.js';
import { tradovateApiBaseUrl } from '../../../server/tradovateOAuth.js';
import { loadTradovateAccountData } from '../../../server/tradovateAccountData.js';
import { requestTradovatePerformanceReport } from '../../../server/tradovateHistoricalReport.js';
import { handleNativeCors } from '../../../server/nativeCors.js';

const datePattern = /^\d{2}\/\d{2}\/\d{4}$/;

/** Odhad ceny jednoho čtení historie pro poradní kontrolu: krátké čtení účtů (4 + až 6 účtů) a report. */
const HISTORY_READ_COST = 12;

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
    const accountId = Number(req.body?.accountId);
    const startDate = typeof req.body?.startDate === 'string' ? req.body.startDate : '';
    const endDate = typeof req.body?.endDate === 'string' ? req.body.endDate : '';
    if (!connectionId || !Number.isSafeInteger(accountId) || !datePattern.test(startDate) || !datePattern.test(endDate)) {
      return res.status(400).json({ error: 'invalid-history-request' });
    }
    const db = createTradovateAdminClient(config);
    const { accessToken, apiHosts, fetchImpl, brokerUserId } = await getValidTradovateAccessToken({
      db,
      config,
      userId,
      connectionId,
    });
    // Poradní kontrola kapacity před čtením (11. 11. 2026): krátké čtení účtů + report.
    await assertTradovateBackgroundCapacity({ db, userId, connectionId, brokerUserId }, HISTORY_READ_COST);
    // Vlastnictví účtu stačí ověřit krátkým čtením (4 + počet účtů dotazů); plné čtení
    // (9 + 4× počet účtů) tu jen zbytečně ubíralo z rozpočtu sdíleného s kopírkou.
    const accounts = await loadTradovateAccountData({
      baseUrl: tradovateApiBaseUrl(config.environment, apiHosts),
      accessToken,
      fetchImpl,
      detail: 'bootstrap',
    });
    const account = accounts.accounts.find(candidate => candidate.id === accountId);
    if (!account) {
      return res.status(403).json({ error: 'account-not-owned' });
    }
    const result = await requestTradovatePerformanceReport({
      environment: config.environment,
      apiHosts,
      accessToken,
      fetchImpl,
      accountId,
      accountSpec: account.name,
      startDate,
      endDate,
    });
    return res.status(200).json(result);
  } catch (error) {
    if (error instanceof TradovateRequestControlError) return res.status(503).json({
      error: error.code, retryAfterMs: error.retryAfterMs, notDispatched: error.notDispatched,
      captchaRequired: error.snapshot?.captchaRequired === true,
      ...(error.precheck ? { precheck: true } : {}),
    });
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') return res.status(401).json({ error: message });
    if (message === 'tradovate-not-connected' || message === 'tradovate-reauthorization-required') return res.status(409).json({ error: message });
    console.error('[tradovate-oauth-history] Read-only history request failed:', message);
    return res.status(502).json({ error: 'tradovate-history-failed' });
  }
}
