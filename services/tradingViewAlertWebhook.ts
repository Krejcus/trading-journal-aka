import { apiUrl } from '../utils/runtimeConfig';
import { supabase } from './supabase';

export interface TradingViewAlertWebhookConfig {
  token: string;
  webhookUrl: string;
  createdAt: string;
  lastAlertAt: string | null;
}

async function request(method: 'GET' | 'POST'): Promise<TradingViewAlertWebhookConfig | null> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Pro správu TradingView webhooku je nutné přihlášení.');
  const response = await fetch(apiUrl('/api/tradingview/alert-webhook'), {
    method,
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (response.status === 404 && method === 'GET') return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `TradingView webhook selhal (${response.status}).`);
  return body as TradingViewAlertWebhookConfig;
}

export const loadTradingViewAlertWebhook = () => request('GET');
export const ensureTradingViewAlertWebhook = () => request('POST') as Promise<TradingViewAlertWebhookConfig>;
