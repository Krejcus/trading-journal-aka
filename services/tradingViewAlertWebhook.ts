import { apiUrl } from '../utils/runtimeConfig';
import { supabase } from './supabase';

export interface TradingViewAlertWebhookConfig {
  token: string;
  webhookUrl: string;
  createdAt: string;
  lastAlertAt: string | null;
  alertsEnabled: boolean;
  imagesEnabled: boolean;
}

interface TradingViewAlertWebhookRow {
  token: string;
  created_at: string;
  last_alert_at: string | null;
  alerts_enabled?: boolean;
  images_enabled?: boolean;
}

const WEBHOOK_ORIGIN = 'https://alphatrade-mentor-15.vercel.app';

const configFromRow = (row: TradingViewAlertWebhookRow): TradingViewAlertWebhookConfig => ({
  token: row.token,
  webhookUrl: `${WEBHOOK_ORIGIN}/api/tradingview/alert-webhook?token=${row.token}`,
  createdAt: row.created_at,
  lastAlertAt: row.last_alert_at,
  alertsEnabled: row.alerts_enabled !== false,
  imagesEnabled: row.images_enabled !== false,
});

export async function loadTradingViewAlertWebhook(): Promise<TradingViewAlertWebhookConfig | null> {
  const { data, error } = await supabase
    .from('tv_alert_webhooks')
    .select('*')
    .maybeSingle<TradingViewAlertWebhookRow>();
  if (error) throw new Error(`TradingView webhook se nepodařilo načíst: ${error.message}`);
  return data ? configFromRow(data) : null;
}

export async function ensureTradingViewAlertWebhook(): Promise<TradingViewAlertWebhookConfig> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error('Pro správu TradingView webhooku je nutné přihlášení.');
  const response = await fetch(apiUrl('/api/tradingview/alert-webhook'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `TradingView webhook selhal (${response.status}).`);
  return {
    ...(body as TradingViewAlertWebhookConfig),
    alertsEnabled: body.alertsEnabled !== false,
    imagesEnabled: body.imagesEnabled !== false,
  };
}

export async function updateTradingViewAlertWebhookSettings(
  patch: Partial<Pick<TradingViewAlertWebhookConfig, 'alertsEnabled' | 'imagesEnabled'>>,
): Promise<TradingViewAlertWebhookConfig> {
  const update: Record<string, boolean> = {};
  if (patch.alertsEnabled !== undefined) update.alerts_enabled = patch.alertsEnabled;
  if (patch.imagesEnabled !== undefined) update.images_enabled = patch.imagesEnabled;
  const { data, error } = await supabase
    .from('tv_alert_webhooks')
    .update(update)
    .select('*')
    .single<TradingViewAlertWebhookRow>();
  if (error) throw new Error(`Nastavení TradingView alertů se nepodařilo uložit: ${error.message}`);
  return configFromRow(data);
}
