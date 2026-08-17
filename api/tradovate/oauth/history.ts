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

const datePattern = /^\d{2}\/\d{2}\/\d{4}$/;

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
    const { accessToken } = await getValidTradovateAccessToken({
      db: createTradovateAdminClient(config),
      config,
      userId,
      connectionId,
    });
    const accounts = await loadTradovateAccountData({
      baseUrl: tradovateApiBaseUrl(config.environment),
      accessToken,
    });
    const account = accounts.accounts.find(candidate => candidate.id === accountId);
    if (!account) {
      return res.status(403).json({ error: 'account-not-owned' });
    }
    const result = await requestTradovatePerformanceReport({
      environment: config.environment,
      accessToken,
      accountId,
      accountSpec: account.name,
      startDate,
      endDate,
    });
    return res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') return res.status(401).json({ error: message });
    if (message === 'tradovate-not-connected' || message === 'tradovate-reauthorization-required') return res.status(409).json({ error: message });
    console.error('[tradovate-oauth-history] Read-only history request failed:', message);
    return res.status(502).json({ error: 'tradovate-history-failed' });
  }
}
