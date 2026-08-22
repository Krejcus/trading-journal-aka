import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createTradovateAdminClient,
  readTradovateServerConfig,
  requireSupabaseUserId,
} from '../../server/tradovateOAuthStore.js';
import {
  listTradovateAccountProfiles,
  saveTradovateAccountProfiles,
} from '../../server/tradovateAccountProfiles.js';
import { handleNativeCors } from '../../server/nativeCors.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Capacitor appka vola tyto endpointy z capacitor://localhost — bez CORS
  // preflight odpovedi selze fetch jako 'Load failed'. Web je same-origin.
  if (handleNativeCors(req, res, ['GET', 'PUT'])) return;
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'PUT') return res.status(405).json({ error: 'method-not-allowed' });
  try {
    const config = readTradovateServerConfig();
    const userId = await requireSupabaseUserId(req.headers.authorization, config);
    const db = createTradovateAdminClient(config);
    const profiles = req.method === 'PUT'
      ? await saveTradovateAccountProfiles({ db, userId, environment: config.environment, profiles: req.body?.profiles })
      : await listTradovateAccountProfiles(db, userId, config.environment);
    return res.status(200).json({ environment: config.environment, profiles });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'missing-auth-token' || message === 'invalid-auth-token') {
      return res.status(401).json({ error: message });
    }
    if (/^(profile|profiles|external-account-id|account-name|display-name|prop-firm|plan-name|account-type|drawdown-type|account-size|max-loss|daily-loss-limit|consistency-pct|profit-target|max-mini|max-micro|mapped-account-id|duplicate)/.test(message)) {
      return res.status(400).json({ error: message });
    }
    console.error('[tradovate-account-profiles] Failed:', message);
    return res.status(503).json({ error: 'tradovate-account-profiles-unavailable' });
  }
}
