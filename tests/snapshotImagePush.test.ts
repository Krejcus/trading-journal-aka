import { describe, expect, it } from 'vitest';
import { buildApnsPayload } from '../server/apns';
import {
  copierSnapshotCollapseId,
  planCopyEventNotifications,
  type CopierRuntimeRow,
} from '../server/copierIncidentWatchdog';
import { findCopierSnapshotPushContent } from '../server/snapshotImagePush';

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
      episodeId: EPISODE, kind: 'entry', at: AT + 400,
    });
    const expected = copierSnapshotCollapseId({ episodeId: EPISODE, kind: 'entry', at: AT });
    expect(copierSnapshotCollapseId({ episodeId: EPISODE.toUpperCase(), kind: 'entry', at: AT + 400 })).toBe(expected);
    expect(planned.collapseId).toBe(expected);
    expect(followUp).toMatchObject({ collapseId: expected, title: planned.title, body: planned.body });
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
});
