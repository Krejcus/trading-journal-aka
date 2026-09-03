import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_LOCK_MARKER_KEY,
  CLOSED_TRADE_MARKER_KEY,
  planBrokerAccountLockNotifications,
  planClosedTradePnlNotifications,
  type NativeClosedTradeAlertRow,
  type NativeFinancialAlertStateRow,
} from '../server/nativeFinancialAlertPlanner';

const NOW = Date.parse('2026-08-20T18:00:00Z');

const trade = (partial: Partial<NativeClosedTradeAlertRow> = {}): NativeClosedTradeAlertRow => ({
  user_id: 'user-1',
  device_id: 'device-1',
  trade_id: 'trade-1',
  symbol: 'MNQU6',
  side: 'Long',
  quantity: 1,
  realized_pnl_usd: 42.5,
  follower_count: 5,
  closed_at: new Date(NOW - 5_000).toISOString(),
  created_at: new Date(NOW - 4_000).toISOString(),
  ...partial,
});

const marker = (incidentKey: string, detail: string): NativeFinancialAlertStateRow => ({
  user_id: 'user-1',
  device_id: 'device-1',
  incident_key: incidentKey,
  active: false,
  detail,
});

describe('remote closed-trade P&L alerts', () => {
  it('prázdný runtime založí marker, aby se první budoucí obchod neztratil', () => {
    const result = planClosedTradePnlNotifications({
      trades: [],
      alertStates: [],
      runtimes: [{ user_id: 'user-1', device_id: 'device-1' }],
      now: NOW,
    });
    expect(result.notifications).toEqual([]);
    expect(result.markers).toEqual([expect.objectContaining({
      incidentKey: CLOSED_TRADE_MARKER_KEY,
      detail: '[]',
      notified: false,
    })]);
  });

  it('nový broker-confirmed close pošle přesné P&L právě jednou', () => {
    const first = planClosedTradePnlNotifications({
      trades: [trade()],
      alertStates: [marker(CLOSED_TRADE_MARKER_KEY, '[]')],
      now: NOW,
    });
    expect(first.notifications).toEqual([expect.objectContaining({
      key: 'closed-pnl:trade-1',
      title: 'MNQU6 Long: +$42.50',
      body: 'Broker potvrdil uzavření 1 kontr. · 5 followerů.',
      kind: 'trade',
    })]);
    const seen = first.markers[0].detail;
    const second = planClosedTradePnlNotifications({
      trades: [trade()],
      alertStates: [marker(CLOSED_TRADE_MARKER_KEY, seen)],
      now: NOW + 60_000,
    });
    expect(second.notifications).toEqual([]);
    expect(second.markers).toEqual([]);
  });

  it('bootstrap nereplayuje starou historii, ale neztratí čerstvý první close', () => {
    const old = trade({
      trade_id: 'old',
      created_at: new Date(NOW - 3_600_000).toISOString(),
      closed_at: new Date(NOW - 3_600_000).toISOString(),
    });
    const result = planClosedTradePnlNotifications({
      trades: [old, trade()],
      alertStates: [],
      now: NOW,
    });
    expect(result.notifications.map(item => item.key)).toEqual(['closed-pnl:trade-1']);
    expect(JSON.parse(result.markers[0].detail)).toEqual(['old', 'trade-1']);
  });

  it('neznámé P&L nikdy nevydává za nulu, ale trade označí jako zpracovaný', () => {
    const result = planClosedTradePnlNotifications({
      trades: [trade({ realized_pnl_usd: null })],
      alertStates: [marker(CLOSED_TRADE_MARKER_KEY, '[]')],
      now: NOW,
    });
    expect(result.notifications).toEqual([]);
    expect(JSON.parse(result.markers[0].detail)).toEqual(['trade-1']);
  });

  it('incident 2.–3. 9.: obchody vypadlé z okna 40 ID se nikdy neoznamují znovu, čerstvý close ano', () => {
    // 45 obchodů uzavřených během včerejšího odpoledne; marker zná jen 40 nejnovějších.
    const history = Array.from({ length: 45 }, (_, index) => trade({
      trade_id: `old-${index}`,
      closed_at: new Date(NOW - 20 * 3_600_000 + index * 60_000).toISOString(),
      created_at: new Date(NOW - 20 * 3_600_000 + index * 60_000 + 500).toISOString(),
    }));
    const newest40 = history.slice(-40).map(item => item.trade_id);
    const replay = planClosedTradePnlNotifications({
      trades: history,
      alertStates: [marker(CLOSED_TRADE_MARKER_KEY, JSON.stringify(newest40))],
      now: NOW,
    });
    expect(replay.notifications).toEqual([]);
    expect(replay.markers).toEqual([]);

    // Skutečně nový close (před 5 s) projde právě jednou a zůstane v markeru.
    const fresh = trade({ trade_id: 'fresh-1' });
    const first = planClosedTradePnlNotifications({
      trades: [...history, fresh],
      alertStates: [marker(CLOSED_TRADE_MARKER_KEY, JSON.stringify(newest40))],
      now: NOW,
    });
    expect(first.notifications.map(item => item.key)).toEqual(['closed-pnl:fresh-1']);
    const seen = JSON.parse(first.markers[0].detail) as string[];
    expect(seen).toContain('fresh-1');
    expect(seen.length).toBeLessThanOrEqual(40);
    const second = planClosedTradePnlNotifications({
      trades: [...history, fresh],
      alertStates: [marker(CLOSED_TRADE_MARKER_KEY, first.markers[0].detail)],
      now: NOW + 60_000,
    });
    expect(second.notifications).toEqual([]);
  });

  it('close starší než 30 minut se neoznámí, ani když ho marker nezná', () => {
    const stale = trade({
      trade_id: 'stale-1',
      closed_at: new Date(NOW - 45 * 60_000).toISOString(),
      created_at: new Date(NOW - 44 * 60_000).toISOString(),
    });
    const withMarker = planClosedTradePnlNotifications({
      trades: [stale],
      alertStates: [marker(CLOSED_TRADE_MARKER_KEY, '["other"]')],
      now: NOW,
    });
    expect(withMarker.notifications).toEqual([]);
    expect(JSON.parse(withMarker.markers[0].detail)).toContain('stale-1');
  });
});

describe('remote broker account lock alerts', () => {
  const account = (locked: boolean) => ({
    accountId: 42,
    accountName: 'Alpha 50K',
    locked,
    reason: locked ? 'Změny účtu jsou zamčené brokerem.' : null,
  });

  it('první úplný snapshot pouze založí marker bez replaye', () => {
    const result = planBrokerAccountLockNotifications({
      userId: 'user-1', deviceId: 'device-1', accounts: [account(false)], alertStates: [],
    });
    expect(result.notifications).toEqual([]);
    expect(result.marker).toMatchObject({ incidentKey: ACCOUNT_LOCK_MARKER_KEY, notified: false });
  });

  it('lock i unlock ohlásí jednou a nový ARM nikdy nezapíná', () => {
    const unlockedMarker = marker(ACCOUNT_LOCK_MARKER_KEY, JSON.stringify({ 42: false }));
    const locked = planBrokerAccountLockNotifications({
      userId: 'user-1', deviceId: 'device-1', accounts: [account(true)], alertStates: [unlockedMarker],
    });
    expect(locked.notifications).toEqual([expect.objectContaining({
      key: 'account-locked:42', title: 'Účet zamčen: Alpha 50K', kind: 'risk',
    })]);

    const lockedMarker = marker(ACCOUNT_LOCK_MARKER_KEY, locked.marker!.detail);
    const unlocked = planBrokerAccountLockNotifications({
      userId: 'user-1', deviceId: 'device-1', accounts: [account(false)], alertStates: [lockedMarker],
    });
    expect(unlocked.notifications[0].body).toContain('ARM zůstává ruční');
  });

  it('účty chybějící v částečném seznamu nemaže z markeru', () => {
    const previous = marker(ACCOUNT_LOCK_MARKER_KEY, JSON.stringify({ 42: true, 43: false }));
    const result = planBrokerAccountLockNotifications({
      userId: 'user-1', deviceId: 'device-1', accounts: [account(true)], alertStates: [previous],
    });
    expect(JSON.parse(result.marker?.detail ?? previous.detail!)).toEqual({ 42: true, 43: false });
    expect(result.notifications).toEqual([]);
  });
});
