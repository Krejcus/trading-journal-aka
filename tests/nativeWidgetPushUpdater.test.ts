import { describe, expect, it } from 'vitest';

import { planNativeWidgetPush } from '../server/nativeWidgetPushUpdater';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('native WidgetKit push planner', () => {
  it('sends the initial registration immediately', () => {
    expect(planNativeWidgetPush({
      payloadHash: HASH_A,
      urgentState: { status: 'ARM LIVE' },
      lastPayloadHash: null,
      lastUrgentHash: null,
      lastSentAt: null,
      now: 1_000,
    })).toMatchObject({ shouldSend: true, reason: 'initial' });
  });

  it('sends structural safety changes without waiting for the P&L throttle', () => {
    const initial = planNativeWidgetPush({
      payloadHash: HASH_A,
      urgentState: { status: 'ARM LIVE', positions: 0 },
      lastPayloadHash: null,
      lastUrgentHash: null,
      lastSentAt: null,
      now: 1_000,
    });
    expect(planNativeWidgetPush({
      payloadHash: HASH_B,
      urgentState: { status: 'DAY-LOCK', positions: 0 },
      lastPayloadHash: HASH_A,
      lastUrgentHash: initial.urgentHash,
      lastSentAt: new Date(1_000).toISOString(),
      now: 2_000,
    })).toMatchObject({ shouldSend: true, reason: 'urgent-change' });
  });

  it('throttles only-P&L changes to one request per five minutes', () => {
    const initial = planNativeWidgetPush({
      payloadHash: HASH_A,
      urgentState: { status: 'ARM LIVE', positions: 1 },
      lastPayloadHash: null,
      lastUrgentHash: null,
      lastSentAt: null,
      now: 1_000,
    });
    expect(planNativeWidgetPush({
      payloadHash: HASH_B,
      urgentState: { status: 'ARM LIVE', positions: 1 },
      lastPayloadHash: HASH_A,
      lastUrgentHash: initial.urgentHash,
      lastSentAt: new Date(1_000).toISOString(),
      now: 4 * 60_000,
    })).toMatchObject({ shouldSend: false, reason: 'throttled' });
    expect(planNativeWidgetPush({
      payloadHash: HASH_B,
      urgentState: { status: 'ARM LIVE', positions: 1 },
      lastPayloadHash: HASH_A,
      lastUrgentHash: initial.urgentHash,
      lastSentAt: new Date(1_000).toISOString(),
      now: 6 * 60_000,
    })).toMatchObject({ shouldSend: true, reason: 'pnl-refresh' });
  });

  it('skips an unchanged payload', () => {
    const initial = planNativeWidgetPush({
      payloadHash: HASH_A,
      urgentState: { status: 'DISARMED' },
      lastPayloadHash: null,
      lastUrgentHash: null,
      lastSentAt: null,
      now: 1_000,
    });
    expect(planNativeWidgetPush({
      payloadHash: HASH_A,
      urgentState: { status: 'DISARMED' },
      lastPayloadHash: HASH_A,
      lastUrgentHash: initial.urgentHash,
      lastSentAt: new Date(1_000).toISOString(),
      now: 60 * 60_000,
    })).toMatchObject({ shouldSend: false, reason: 'unchanged' });
  });
});
