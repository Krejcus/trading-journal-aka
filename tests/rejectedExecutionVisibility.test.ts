import { describe, expect, it, beforeEach } from 'vitest';
import {
  rejectedExecutionVisibility,
  rejectedExecutionDismissKey,
  dismissRejection,
  getDismissedRejections,
  __resetDismissedRejectionsForTests,
} from '../services/rejectedExecutionVisibility';
import { sameTradovateSession, tradovateSessionEndAt } from '../services/copierArmSession';

// 8. 9. 2026 14:00 UTC = 09:00 Chicago (CDT), session končí 17:00 CDT = 22:00 UTC.
const now = Date.UTC(2026, 8, 8, 14, 0, 0);
const yesterday = Date.UTC(2026, 8, 7, 14, 0, 0);
const execution = { at: now - 3_600_000, brokerOrderId: 'o-1' };

describe('sameTradovateSession', () => {
  it('hranice je 17:00 Chicago', () => {
    expect(tradovateSessionEndAt(now)).toBe(Date.UTC(2026, 8, 8, 22, 0, 0));
    expect(sameTradovateSession(now, now + 7 * 3_600_000)).toBe(true);
    expect(sameTradovateSession(now, now + 9 * 3_600_000)).toBe(false);
    expect(sameTradovateSession(yesterday, now)).toBe(false);
  });
});

describe('rejectedExecutionVisibility', () => {
  it('nevyřešené odmítnutí je vidět vždy, i staré a i „zavřené"', () => {
    const dismissed = new Set([rejectedExecutionDismissKey(200, { ...execution, at: yesterday })]);
    expect(rejectedExecutionVisibility({
      accountId: 200, execution: { ...execution, at: yesterday }, accountAuthoritativelyFlat: false, dismissed, now,
    })).toBe('visible');
    expect(rejectedExecutionVisibility({
      accountId: 200, execution: { ...execution, at: yesterday, resolution: { kind: 'unresolved', at: yesterday } }, accountAuthoritativelyFlat: false, dismissed: new Set(), now,
    })).toBe('visible');
  });

  it('vyřešené odmítnutí z dnešní session je vidět, ze včerejší už ne', () => {
    const resolvedToday = { ...execution, resolution: { kind: 'follower-flat' as const, at: now - 1_800_000 } };
    expect(rejectedExecutionVisibility({ accountId: 200, execution: resolvedToday, accountAuthoritativelyFlat: false, dismissed: new Set(), now })).toBe('visible');
    const resolvedYesterday = { ...execution, at: yesterday, resolution: { kind: 'follower-flat' as const, at: yesterday + 60_000 } };
    expect(rejectedExecutionVisibility({ accountId: 200, execution: resolvedYesterday, accountAuthoritativelyFlat: false, dismissed: new Set(), now })).toBe('expired');
    // starý snapshot bez resolution, ale účet je dnes autoritativně flat → vyřešené, rozhoduje čas odmítnutí
    expect(rejectedExecutionVisibility({ accountId: 200, execution: { ...execution, at: yesterday }, accountAuthoritativelyFlat: true, dismissed: new Set(), now })).toBe('expired');
  });

  it('křížek schová jen vyřešené', () => {
    const resolved = { ...execution, resolution: { kind: 'guard-flattened' as const, at: now - 60_000 } };
    const dismissed = new Set([rejectedExecutionDismissKey(200, resolved)]);
    expect(rejectedExecutionVisibility({ accountId: 200, execution: resolved, accountAuthoritativelyFlat: false, dismissed, now })).toBe('dismissed');
    expect(rejectedExecutionVisibility({ accountId: 201, execution: resolved, accountAuthoritativelyFlat: false, dismissed, now })).toBe('visible');
  });
});

describe('úložiště zavřených odmítnutí', () => {
  const storage = () => {
    const map = new Map<string, string>();
    return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, map };
  };
  beforeEach(() => __resetDismissedRejectionsForTests(null));

  it('zavření platí do konce session a přežije reload, po session se zahodí', () => {
    const store = storage();
    __resetDismissedRejectionsForTests(store);
    dismissRejection('200:o-1:1', now);
    expect(getDismissedRejections().has('200:o-1:1')).toBe(true);
    expect(JSON.parse(store.map.get('at:live:rejection-dismissed')!)).toEqual({ '200:o-1:1': Date.UTC(2026, 8, 8, 22, 0, 0) });
    // „reload" v téže session
    __resetDismissedRejectionsForTests(store);
    dismissRejection('200:o-2:1', now + 60_000);
    expect([...getDismissedRejections()]).toEqual(['200:o-1:1', '200:o-2:1']);
    // další session: staré záznamy se při dalším zápisu vyčistí
    __resetDismissedRejectionsForTests(store);
    dismissRejection('200:o-3:1', now + 10 * 3_600_000);
    expect([...getDismissedRejections()]).toEqual(['200:o-3:1']);
  });

  it('bez localStorage funguje v paměti', () => {
    dismissRejection('x', now);
    expect(getDismissedRejections().has('x')).toBe(true);
  });
});
