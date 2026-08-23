import type { VercelRequest, VercelResponse } from '@vercel/node';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const supabaseMock = vi.hoisted(() => ({ createClient: vi.fn() }));
const notificationsMock = vi.hoisted(() => ({ sendTvAlertTextPush: vi.fn() }));

vi.mock('@supabase/supabase-js', () => ({ createClient: supabaseMock.createClient }));
vi.mock('../server/tvAlertNotifications', async importOriginal => {
  const actual = await importOriginal<typeof import('../server/tvAlertNotifications')>();
  return { ...actual, sendTvAlertTextPush: notificationsMock.sendTvAlertTextPush };
});

import handler from '../api/tradingview/alert-webhook';

function responseHarness() {
  let statusCode = 200;
  let responseBody: any;
  const res = {
    setHeader: vi.fn(),
    status: vi.fn((code: number) => { statusCode = code; return res; }),
    json: vi.fn((value: unknown) => { responseBody = value; return res; }),
  } as unknown as VercelResponse;
  return { res, status: () => statusCode, body: () => responseBody };
}

const request = (token: string) => ({
  method: 'POST',
  headers: {},
  query: { token },
  body: { symbol: 'MNQ1!', price: '23800', tf: '5', name: 'OTE long' },
} as unknown as VercelRequest);

function webhookDb(row: { id: string; user_id: string; alerts_enabled?: boolean; images_enabled?: boolean }) {
  const inserted: Record<string, unknown>[] = [];
  const db = {
    rpc: vi.fn(async () => ({ data: true, error: null })),
    from: vi.fn((table: string) => {
      if (table === 'tv_alert_webhooks') return {
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      if (table === 'tv_alerts') return {
        insert: async (value: Record<string, unknown>) => { inserted.push(value); return { error: null }; },
      };
      throw new Error(`Unexpected table ${table}`);
    }),
  };
  return { db, inserted };
}

describe('TradingView alert webhook switches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_ANON_KEY = 'anon-key';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
    notificationsMock.sendTvAlertTextPush.mockResolvedValue({ devices: 1, sent: 1 });
  });

  it('returns 200 without storing or notifying when alerts are disabled', async () => {
    const { db, inserted } = webhookDb({ id: 'webhook-1', user_id: 'user-1', alerts_enabled: false });
    supabaseMock.createClient.mockReturnValue(db);
    const harness = responseHarness();
    await handler(request('a'.repeat(64)), harness.res);
    expect(harness.status()).toBe(200);
    expect(harness.body()).toEqual({ accepted: false, reason: 'alerts-disabled' });
    expect(inserted).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(notificationsMock.sendTvAlertTextPush).not.toHaveBeenCalled();
  });

  it('sends text but permanently skips snapshot work when images are disabled', async () => {
    const { db, inserted } = webhookDb({ id: 'webhook-2', user_id: 'user-1', images_enabled: false });
    supabaseMock.createClient.mockReturnValue(db);
    const harness = responseHarness();
    await handler(request('b'.repeat(64)), harness.res);
    expect(harness.status()).toBe(202);
    expect(harness.body()).toMatchObject({ accepted: true, snapshotPending: false });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ user_id: 'user-1', snapshot_path: '' });
    expect(notificationsMock.sendTvAlertTextPush).toHaveBeenCalledOnce();
    expect(db.from).not.toHaveBeenCalledWith('tradovate_copier_devices');
  });
});
