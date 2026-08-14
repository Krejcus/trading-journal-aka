import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createTradovateAdminClient,
  getValidTradovateAccessToken,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../../../server/tradovateOAuthStore.js';
import { tradovateApiBaseUrl } from '../../../server/tradovateOAuth.js';

interface AccountEntity { id: number; name?: string; active?: boolean; readonly?: boolean }
interface PositionEntity { accountId: number; netPos: number }
interface OrderEntity { accountId: number; ordStatus?: string }

const requestList = async <T>(baseUrl: string, path: string, accessToken: string): Promise<T[]> => {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Tradovate ${path} failed (${response.status})`);
  const value = await response.json() as unknown;
  if (!Array.isArray(value)) throw new Error(`Tradovate ${path} returned an invalid list`);
  return value as T[];
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const { accessToken } = await getValidTradovateAccessToken({
      db: createTradovateAdminClient(config),
      config,
      userId,
    });
    const baseUrl = tradovateApiBaseUrl(config.environment);
    const [accounts, positions, orders] = await Promise.all([
      requestList<AccountEntity>(baseUrl, '/account/list', accessToken),
      requestList<PositionEntity>(baseUrl, '/position/list', accessToken),
      requestList<OrderEntity>(baseUrl, '/order/list', accessToken),
    ]);
    return res.status(200).json({
      environment: config.environment,
      accounts: accounts.map(account => ({
        id: account.id,
        name: account.name ?? String(account.id),
        active: account.active !== false,
        canTrade: account.readonly !== true,
        netPositionCount: positions.filter(position => position.accountId === account.id && position.netPos !== 0).length,
        workingOrderCount: orders.filter(order => account.id === order.accountId && !['Filled', 'Canceled', 'Cancelled', 'Rejected', 'Expired'].includes(order.ordStatus ?? '')).length,
      })),
    });
  } catch (error) {
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
