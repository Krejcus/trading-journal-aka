import { TradovateRequestControlError } from '../../../server/tradovateServerRequestControl.js';
import { readTradovateAccountDisplay } from '../../../server/tradovateAccountDisplayRead.js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createTradovateAdminClient,
  getValidTradovateAccessToken,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../../../server/tradovateOAuthStore.js';
import { tradovateApiBaseUrl } from '../../../server/tradovateOAuth.js';
import {
  loadTradovateLivePnlAnchor,
  TradovateLivePnlError,
} from '../../../server/tradovateLivePnl.js';
import { sharedTradovateRead, TradovateSharedReadDeferred } from '../../../server/tradovateSharedRead.js';
import { readWorkerSharedCash } from '../../../server/tradovateSharedWorkerRead.js';
import { readSharedTradovateTick } from '../../../server/tradovateSharedAccountState.js';
import { handleNativeCors } from '../../../server/nativeCors.js';

/** Compatibility test hook; there is no per-process data cache. */
export function resetTradovateLivePnlCoalescingForTests(): void {}

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
    if (req.body?.mode === 'cash') {
      const accountId = Number(req.body?.accountId);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) return res.status(400).json({ error: 'invalid-account-id' });
      const worker = await readWorkerSharedCash(context, accountId);
      if (worker) return res.status(200).json({ kind: 'account-display-v1', brokerCalls: 0, snapshot: worker });
      const result = await sharedTradovateRead({ context, channel: `cash:${accountId}:v1`, ttlMs: 120_000,
        read: async () => {
          const requestedAt = new Date().toISOString();
          let brokerCalls = 0;
          const fields = await readTradovateAccountDisplay({ baseUrl, accessToken, fetchImpl, accountId,
            signal: AbortSignal.timeout(8_000), onBrokerRequest: () => { brokerCalls += 1; } });
          return { brokerCalls, snapshot: { connectionId, environment: config.environment, accountId,
            requestedAt, confirmedAt: new Date().toISOString(), fields } };
        },
      });
      return res.status(200).json({ kind: 'account-display-v1', brokerCalls: result.shared ? 0 : result.value.brokerCalls,
        snapshot: { ...result.value.snapshot, connectionId } });
    }
    if (req.body?.mode === 'anchor') {
      const accountId = Number(req.body?.accountId);
      const contractId = Number(req.body?.contractId);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) {
        return res.status(400).json({ error: 'invalid-account-id' });
      }
      if (!Number.isSafeInteger(contractId) || contractId <= 0) {
        return res.status(400).json({ error: 'invalid-contract-id' });
      }
      const result = await sharedTradovateRead({ context, channel: `anchor:${accountId}:${contractId}:v1`, ttlMs: 30_000,
        read: () => loadTradovateLivePnlAnchor({ baseUrl, accessToken, fetchImpl, connectionId,
          environment: config.environment, accountId, contractId }),
      });
      return res.status(200).json({ ...result.value, connectionId, brokerCalls: result.shared ? 0 : result.value.brokerCalls });
    }
    const tick = await readSharedTradovateTick({ context, baseUrl, accessToken, fetchImpl, brokerUserId });
    return res.status(200).json(tick);
  } catch (error) {
    if (error instanceof TradovateSharedReadDeferred) return res.status(503).json({ error: error.message, retryAfterMs: error.retryAfterMs, notDispatched: true });
    if (error instanceof TradovateRequestControlError) return res.status(503).json({
      error: error.code, retryAfterMs: error.retryAfterMs, notDispatched: error.notDispatched,
      captchaRequired: error.snapshot?.captchaRequired === true,
    });
    const message = error instanceof Error ? error.message : String(error);
    if (req.body?.mode === 'cash' && error && typeof error === 'object' && 'status' in error && error.status === 429) {
      const retryAfterMs = 'retryAfterMs' in error && typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs)
        ? Math.max(1_000, error.retryAfterMs) : 3_600_000;
      return res.status(429).json({ error: 'tradovate-rate-limited', retryAfterMs });
    }

    if (message === 'missing-auth-token' || message === 'invalid-auth-token') {
      return res.status(401).json({ error: message });
    }
    if (message === 'tradovate-not-connected' || message === 'tradovate-reauthorization-required') {
      return res.status(409).json({ error: message });
    }
    if (error instanceof TradovateLivePnlError && error.status === 429) {
      // Explicit upstream minimum is preserved; raw429 defaults conservatively to one hour.
      return res.status(429).json({ error: 'tradovate-rate-limited', retryAfterMs: Math.max(1_000, error.retryAfterMs ?? 3_600_000) });
    }
    // A slow broker is not a broken route: report it as a timeout so logs
    // and clients can tell Tradovate latency from a real failure.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      console.warn('[tradovate-live-pnl] Tradovate read timed out');
      return res.status(504).json({ error: 'tradovate-timeout', retryAfterMs: 15_000 });
    }
    console.error('[tradovate-live-pnl] Read-only tick failed:', message);
    return res.status(502).json({ error: 'tradovate-live-pnl-failed' });
  }
}
