import { describe, expect, it, vi } from 'vitest';
import { buildApnsPayload } from '../server/apns';
import {
  copierSnapshotCollapseId,
  planCopyEventNotifications,
  type CopierRuntimeRow,
} from '../server/copierIncidentWatchdog';
import {
  findCopierSnapshotPushContent,
  markCopierSnapshotNotificationSent,
  snapshotTestPushContent,
} from '../server/snapshotImagePush';
import type { SupabaseClient } from '@supabase/supabase-js';

const EPISODE = '11111111-1111-4111-8111-111111111111';
const AT = 1_766_436_123_456;
const event = {
  id: 'event-1', episodeId: EPISODE, at: AT, kind: 'entry' as const,
  symbol: 'MNQ', side: 'Long' as const, quantity: 2, followers: 3, price: 24_500,
};

describe('image notification collapse correlation', () => {
  it('is deterministic and identical for text planner and snapshot follow-up', () => {
    const runtime: CopierRuntimeRow = {
      device_id: 'device', user_id: 'user',
      status: { controller: { recentCopyEvents: [event] } },
      last_seen_at: new Date(AT).toISOString(), started_at: new Date(AT - 1_000).toISOString(),
    };
    const planned = planCopyEventNotifications({
      runtimes: [runtime],
      alertStates: [{ device_id: 'device', user_id: 'user', incident_key: 'state:copy-events', active: false, detail: String(AT - 1) }],
      now: AT,
    }).notifications[0];
    const followUp = findCopierSnapshotPushContent({ controller: { recentCopyEvents: [event] } }, {
      episodeId: EPISODE, kind: 'entry', at: AT + 400, symbol: 'MNQ',
    });
    const expected = copierSnapshotCollapseId({ episodeId: EPISODE, kind: 'entry', at: AT });
    expect(copierSnapshotCollapseId({ episodeId: EPISODE.toUpperCase(), kind: 'entry', at: AT + 400 })).toBe(expected);
    expect(planned.collapseId).toBe(expected);
    expect(followUp).toMatchObject({ collapseId: expected, title: planned.title, body: planned.body });
  });

  it('pošle obecný obrázkový follow-up i když už event v runtime historii není', () => {
    expect(findCopierSnapshotPushContent({}, {
      episodeId: EPISODE, kind: 'exit', at: AT, symbol: 'MNQU6',
    })).toEqual({
      title: 'Obchod uzavřen · MNQU6',
      body: 'Výstupní graf byl uložen do journalu.',
      collapseId: copierSnapshotCollapseId({ episodeId: EPISODE, kind: 'exit', at: AT }),
      threadId: 'alphatrade-copier-trades',
    });
  });

  it('builds the iOS-extension-ready mutable payload with top-level imageUrl', () => {
    expect(buildApnsPayload({
      title: 'same', body: 'same', collapseId: 'same-id', mutableContent: true,
      imageUrl: 'https://example.test/signed.png',
    })).toMatchObject({
      aps: { alert: { title: 'same', body: 'same' }, 'mutable-content': 1 },
      imageUrl: 'https://example.test/signed.png',
    });
  });

  it('test snapshot má vlastní collapse/thread a netváří se jako obchod', () => {
    expect(snapshotTestPushContent('44444444-4444-4444-8444-444444444444')).toEqual({
      title: '📸 Test snapshotu',
      body: 'TradingView → AlphaTrade → APNs funguje.',
      collapseId: 'alpha-snapshot-test-44444444-4444-4444-8444-444444444444',
      threadId: 'alphatrade-test',
      category: 'ALPHATRADE_GENERAL',
    });
  });

  it('po přijetí obrázku monotónně posune společný textový marker', async () => {
    const upsert = vi.fn(async () => ({ error: null }));
    const chain: Record<string, any> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: { detail: String(AT - 1) }, error: null }));
    chain.upsert = upsert;
    const db = { from: vi.fn(() => chain) } as unknown as SupabaseClient;

    await markCopierSnapshotNotificationSent({ db, userId: 'user', deviceId: 'device', at: AT });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      user_id: 'user', device_id: 'device', incident_key: 'state:copy-events', detail: String(AT),
    }), { onConflict: 'user_id,device_id,incident_key' });
  });

  it('nikdy neposune marker zpět', async () => {
    const upsert = vi.fn();
    const chain: Record<string, any> = {};
    chain.select = vi.fn(() => chain);
    chain.eq = vi.fn(() => chain);
    chain.maybeSingle = vi.fn(async () => ({ data: { detail: String(AT + 1) }, error: null }));
    chain.upsert = upsert;
    const db = { from: vi.fn(() => chain) } as unknown as SupabaseClient;

    await markCopierSnapshotNotificationSent({ db, userId: 'user', deviceId: 'device', at: AT });
    expect(upsert).not.toHaveBeenCalled();
  });
});
