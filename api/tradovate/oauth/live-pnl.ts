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
  loadTradovateLivePnlTick,
  TradovateLivePnlError,
} from '../../../server/tradovateLivePnl.js';
import { handleNativeCors } from '../../../server/nativeCors.js';

/**
 * Krátká paměť ticků na připojení. Web, iPhone a companion pollují nezávisle
 * a každý tick stojí 3–4 Tradovate REST volání se stejným tokenem, který drží
 * i copier worker; Tradovate při překročení limitu zavírá jeho socket a
 * penalizuje sync (18. 9. 2026). Souběžné i těsně následující požadavky na
 * stejné připojení dostanou jeden sdílený výsledek; cache žije jen ve warm
 * instanci a nikdy nevrací starší data než TICK_COALESCE_MS.
 */
const TICK_COALESCE_MS = 2_500;
const CASH_COALESCE_MS = 5_000;
const recentTicks = new Map<string, { at: number; result: Promise<unknown> }>();

function coalesce<T>(key: string, ttlMs: number, now: number, read: () => Promise<T>): Promise<T> & { shared?: boolean } {
  const cached = recentTicks.get(key);
  if (cached && now - cached.at < ttlMs) return Object.assign(cached.result.then(value => value) as Promise<T>, { shared: true });
  const result = read();
  recentTicks.set(key, { at: now, result });
  // Selhání se nesdílí: další požadavek zkusí broker znovu.
  result.catch(() => { if (recentTicks.get(key)?.result === result) recentTicks.delete(key); });
  if (recentTicks.size > 500) {
    for (const [candidate, entry] of recentTicks) if (now - entry.at >= Math.max(ttlMs, CASH_COALESCE_MS)) recentTicks.delete(candidate);
  }
  return result;
}

/** Jen pro testy: zapomene sdílené ticky. */
export function resetTradovateLivePnlCoalescingForTests(): void {
  recentTicks.clear();
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
    if (!connectionId) return res.status(400).json({ error: 'missing-connection-id' });
    const contractCursor = typeof req.body?.contractCursor === 'number' ? req.body.contractCursor : 0;
    const { accessToken } = await getValidTradovateAccessToken({
      db: createTradovateAdminClient(config),
      config,
      userId,
      connectionId,
    });
    if (req.body?.mode === 'cash') {
      const accountId = Number(req.body?.accountId);
      if (!Number.isSafeInteger(accountId) || accountId <= 0) return res.status(400).json({ error: 'invalid-account-id' });
      const requestedAt = new Date().toISOString();
      const pending = coalesce(`cash:${userId}:${connectionId}:${accountId}`, CASH_COALESCE_MS, Date.now(), () => readTradovateAccountDisplay({
        baseUrl: tradovateApiBaseUrl(config.environment), accessToken, accountId, signal: AbortSignal.timeout(8_000),
      }));
      const fields = await pending;
      // readTradovateAccountDisplay = 3 Tradovate volání (snapshot, deps, currency/list).
      return res.status(200).json({ kind: 'account-display-v1', brokerCalls: pending.shared ? 0 : 3, snapshot: {
        connectionId, environment: config.environment, accountId, requestedAt, confirmedAt: new Date().toISOString(), fields,
      } });
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
      const anchor = await loadTradovateLivePnlAnchor({
        baseUrl: tradovateApiBaseUrl(config.environment),
        accessToken,
        connectionId,
        environment: config.environment,
        accountId,
        contractId,
      });
      return res.status(200).json(anchor);
    }
    const pendingTick = coalesce(`tick:${userId}:${connectionId}:${contractCursor}`, TICK_COALESCE_MS, Date.now(), () => loadTradovateLivePnlTick({
      baseUrl: tradovateApiBaseUrl(config.environment),
      accessToken,
      connectionId,
      environment: config.environment,
      contractCursor,
    }));
    const tick = await pendingTick;
    return res.status(200).json(pendingTick.shared ? { ...tick, brokerCalls: 0 } : tick);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (req.body?.mode === 'cash' && error && typeof error === 'object' && 'status' in error && error.status === 429) {
      const retryAfterMs = 'retryAfterMs' in error && typeof error.retryAfterMs === 'number' && Number.isFinite(error.retryAfterMs)
        ? Math.max(1_000, error.retryAfterMs) : 60_000;
      return res.status(429).json({ error: 'tradovate-rate-limited', retryAfterMs });
    }

    if (message === 'missing-auth-token' || message === 'invalid-auth-token') {
      return res.status(401).json({ error: message });
    }
    if (message === 'tradovate-not-connected' || message === 'tradovate-reauthorization-required') {
      return res.status(409).json({ error: message });
    }
    if (error instanceof TradovateLivePnlError && error.status === 429) {
      // Tradovate říká přes p-time nebo Retry-After, jak dlouho čekat; bez toho
      // 5 minut. Paušální hodina dřív zamrazila LIVE po jediném 429.
      return res.status(429).json({ error: 'tradovate-rate-limited', retryAfterMs: Math.max(1_000, error.retryAfterMs ?? 300_000) });
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
