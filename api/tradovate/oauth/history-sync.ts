import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadTradovateAccountIdentity } from '../../../server/tradovateAccountData.js';
import {
  loadTradovateHistorySnapshot,
  runTradovatePerformanceBackfillStep,
} from '../../../server/tradovateHistoricalSync.js';
import { tradovateApiBaseUrl } from '../../../server/tradovateOAuth.js';
import {
  createTradovateAdminClient,
  getValidTradovateAccessToken,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../../../server/tradovateOAuthStore.js';
import { handleNativeCors } from '../../../server/nativeCors.js';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

const accountIdFrom = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('invalid-account-id');
  return parsed;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Capacitor appka vola tyto endpointy z capacitor://localhost — bez CORS
  // preflight odpovedi selze fetch jako 'Load failed'. Web je same-origin.
  if (handleNativeCors(req, res, ['GET', 'POST', 'DELETE'])) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const db = createTradovateAdminClient(config);
    const accountId = accountIdFrom(req.method === 'GET' ? req.query.accountId : req.body?.accountId);

    if (req.method === 'GET') {
      const snapshot = await loadTradovateHistorySnapshot({
        db,
        userId,
        environment: config.environment,
        accountId,
        limit: Number(req.query.limit) || undefined,
      });
      return res.status(200).json(snapshot);
    }

    const connectionId = typeof req.body?.connectionId === 'string' ? req.body.connectionId.trim() : '';
    const startDate = typeof req.body?.startDate === 'string' ? req.body.startDate : undefined;
    const endDate = typeof req.body?.endDate === 'string' ? req.body.endDate : undefined;
    if (!connectionId || (startDate && !datePattern.test(startDate)) || (endDate && !datePattern.test(endDate))) {
      return res.status(400).json({ error: 'invalid-history-sync-request' });
    }

    const { accessToken } = await getValidTradovateAccessToken({
      db,
      config,
      userId,
      connectionId,
    });
    const existing = await loadTradovateHistorySnapshot({
      db,
      userId,
      environment: config.environment,
      accountId,
      limit: 1,
    });
    let accountName = existing.sync?.accountName ?? null;
    let accountCreatedAt = existing.sync?.accountCreatedAt ?? null;
    if (!accountCreatedAt) {
      const identity = await loadTradovateAccountIdentity({
        baseUrl: tradovateApiBaseUrl(config.environment),
        accessToken,
        accountId,
      });
      accountName = identity?.name ?? accountName;
      accountCreatedAt = identity?.createdAt ?? null;
    }
    if (!accountName) return res.status(403).json({ error: 'account-not-owned' });

    const sync = await runTradovatePerformanceBackfillStep({
      db,
      userId,
      connectionId,
      environment: config.environment,
      accessToken,
      accountId,
      accountName,
      accountCreatedAt,
      startDate,
      endDate,
    });
    const snapshot = await loadTradovateHistorySnapshot({
      db,
      userId,
      environment: config.environment,
      accountId,
    });
    return res.status(200).json({ ...snapshot, sync });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') return res.status(401).json({ error: message });
    if (message === 'invalid-account-id' || message.startsWith('history-date')) return res.status(400).json({ error: message });
    if (message === 'tradovate-not-connected' || message === 'tradovate-reauthorization-required') return res.status(409).json({ error: message });
    console.error('[tradovate-history-sync] Read-only historical sync failed:', message);
    return res.status(502).json({ error: 'tradovate-history-sync-failed' });
  }
}
