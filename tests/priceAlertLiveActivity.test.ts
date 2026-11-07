import { describe, expect, it } from 'vitest';
import type { NativeLiveActivityBrokerSnapshot } from '../server/nativeLiveActivityBrokerSnapshot';
import { planNativeLiveActivityUpdate, type NativeLiveActivityRuntimeRow } from '../server/nativeLiveActivityUpdater';

const now = Date.parse('2026-09-07T14:30:00.000Z');
const runtime: NativeLiveActivityRuntimeRow = {
  device_id: 'device', user_id: 'user', connection_id: 'connection',
  last_seen_at: new Date(now).toISOString(), started_at: new Date(now - 3_600_000).toISOString(),
  status: {
    group: { id: 'group', name: 'Hlavní', leaderAccountId: 10, followers: [{ accountId: 11, mode: 'on-fill', multiplier: 1 }] },
    controller: { armed: true, connected: true, armedAt: now - 60_000, dailyStats: { realizedPnlUsd: 0, losingTrades: 0 }, recentCopyEvents: [] },
  },
};
const broker: NativeLiveActivityBrokerSnapshot = {
  accounts: [
    { accountId: 10, accountName: 'Leader', balance: 0, realizedPnl: 0, openPnl: 0, totalPnl: 0, canTrade: true, changesLocked: false },
    { accountId: 11, accountName: 'Follower', balance: 0, realizedPnl: 0, openPnl: 0, totalPnl: 0, canTrade: true, changesLocked: false },
  ],
  positions: [
    { accountId: 10, symbol: 'MNQZ6', side: 'Long', quantity: 1, entryPrice: 23_400, currentPrice: 23_450, stopPrice: 23_350, targetPrice: 23_550 },
    { accountId: 11, symbol: 'MNQZ6', side: 'Long', quantity: 2, entryPrice: 23_400, currentPrice: 23_450, stopPrice: 23_350, targetPrice: 23_550 },
  ],
  pendingOrder: null, workingOrderCount: 4,
  realizedPnl: 0, openPnl: 75.5, totalPnl: 75.5,
  completeOpenPnl: true, completeRealizedPnl: true, accountStatusComplete: true, accountLockStatusComplete: true,
  capturedAt: now,
};

import { buildApnsLiveActivityPayload } from '../server/apns';
import { loadRecentPriceAlert, priceAlertExpandAlert, priceAlertStateFields, withoutPriceAlert } from '../server/priceAlertLiveActivity';

const alert = { symbol: 'MNQ', level: 21482, condition: 'up', note: 'Retest dHigh', at: now - 3_000 };
const runtimeWith = (controller: Record<string, unknown>) => ({ ...runtime, status: { ...(runtime as { status: Record<string, unknown> }).status, controller: { ...((runtime as { status: { controller?: Record<string, unknown> } }).status.controller ?? {}), ...controller } } });

describe('upozornění na cenu v Live Activity', () => {
  it('běžná aktualizace nese úroveň uživatele jako plochá pole a mění hash, pozici nemění', () => {
    const before = planNativeLiveActivityUpdate({ runtime, broker, now });
    const after = planNativeLiveActivityUpdate({ runtime, broker, now, priceAlert: alert });
    expect(after.priceAlertShown).toBe(true);
    expect(after.update.state).toMatchObject({ priceAlertSymbol: 'MNQ', priceAlertDirection: 'Nahoru přes', priceAlertNote: 'Retest dHigh' });
    expect(after.update.state.priceAlertLevelText?.replace(/\s/g, ' ')).toBe('21 482,00');
    expect(after.payloadHash).not.toBe(before.payloadHash);
    const { priceAlertSymbol, priceAlertLevelText, priceAlertDirection, priceAlertNote, priceAlertAt, ...rest } = after.update.state;
    expect(rest).toEqual(before.update.state);
    expect(after.update.staleAt).toBe(before.update.staleAt);
  });

  it('rizikový a offline stav alert přebijí, shrnutí (end) ho nenese', () => {
    const killed = planNativeLiveActivityUpdate({ runtime: runtimeWith({ killSwitch: true }), broker, now, priceAlert: alert });
    expect(killed.priceAlertShown).toBe(false);
    expect(killed.update.state.priceAlertLevelText).toBeUndefined();
    const offline = planNativeLiveActivityUpdate({ runtime: { ...runtime, last_seen_at: new Date(now - 200_000).toISOString() }, broker, now, priceAlert: alert });
    expect(offline.update.state.status).toBe('WORKER OFFLINE');
    expect(offline.priceAlertShown).toBe(false);
    const ended = planNativeLiveActivityUpdate({ runtime: runtimeWith({ armed: false, dayLockUntil: 0, entryCooldownUntil: 0 }), broker: { ...broker, positions: [], workingOrderCount: 0 }, now, priceAlert: alert });
    expect(ended.shouldEnd).toBe(true);
    expect(ended.priceAlertShown).toBe(false);
    expect(ended.update.state.priceAlertLevelText).toBeUndefined();
    for (const controller of [{ connected: false }]) {
      const brokerOffline = planNativeLiveActivityUpdate({ runtime: runtimeWith(controller), broker, now, priceAlert: alert });
      expect(brokerOffline.update.state.status).toBe('BROKER OFFLINE');
      expect(brokerOffline.priceAlertShown).toBe(false);
    }
    // Bez snapshotu brokera: žádný alert nad starým P&L.
    expect(planNativeLiveActivityUpdate({ runtime, broker: null, now, priceAlert: alert }).priceAlertShown).toBe(false);
  });

  it('Island se rozbalí jen při prvním odeslání po spuštění a bez zvuku; end alert nenese', () => {
    expect(priceAlertExpandAlert(alert, now - 10_000, now)?.title.replace(/\s/g, ' ')).toBe('🚨 MNQ 21 482,00');
    expect(priceAlertExpandAlert(alert, now - 1_000, now)).toBeUndefined();
    expect(priceAlertExpandAlert(null, 0, now)).toBeUndefined();
    // Událost novější než čas tiku se rozbalí až příště, stará vůbec.
    expect(priceAlertExpandAlert({ ...alert, at: now + 500 }, now - 5_000, now)).toBeUndefined();
    expect(priceAlertExpandAlert({ ...alert, at: now - 31_000 }, 0, now)).toBeUndefined();
    expect(withoutPriceAlert({ status: 'x', priceAlertAt: 1, priceAlertLevelText: 'a' })).toEqual({ status: 'x' });
    const state = planNativeLiveActivityUpdate({ runtime, broker, now }).update.state;
    const payload = buildApnsLiveActivityPayload({ state, alert: { title: 'a', body: 'b' } }) as { aps: { alert?: Record<string, unknown> } };
    expect(payload.aps.alert).toEqual({ title: 'a', body: 'b' });
    expect(payload.aps.alert).not.toHaveProperty('sound');
    const end = buildApnsLiveActivityPayload({ state, event: 'end', alert: { title: 'a', body: 'b' } }) as { aps: { alert?: unknown } };
    expect(end.aps.alert).toBeUndefined();
  });

  it('zpráva je zkrácená; čtení nikdy nevyhodí a respektuje vypnutý iPhone', async () => {
    expect(priceAlertStateFields({ ...alert, note: 'x'.repeat(80) }).priceAlertNote).toHaveLength(40);
    expect(priceAlertStateFields({ ...alert, note: '' })).not.toHaveProperty('priceAlertNote');
    // Emoji na hranici: nesmí zůstat osamělá polovina znaku.
    const cut = priceAlertStateFields({ ...alert, note: `${'x'.repeat(39)}🚀🚀` }).priceAlertNote!;
    expect(cut).toBe(`${'x'.repeat(39)}🚀`);
    expect(() => encodeURIComponent(cut)).not.toThrow();
    await expect(loadRecentPriceAlert({ from: () => { throw new Error('boom'); } } as never, 'u', now)).resolves.toBeNull();
    const chain = (data: unknown) => {
      const api: Record<string, unknown> = {};
      for (const key of ['select', 'eq', 'is', 'gte', 'order', 'limit', 'abortSignal']) api[key] = () => api;
      api.maybeSingle = async () => ({ data, error: null });
      return api;
    };
    const db = (channels: unknown, level: unknown = '21482.00') => ({ from: (table: string) => chain(table === 'price_alert_events'
      ? { alert_id: 'pa-1', symbol: 'MNQ', level, condition: 'up', triggered_at: new Date(now - 1_000).toISOString() }
      : { note: ' VWAP ', channels }) }) as never;
    await expect(loadRecentPriceAlert(db({ phone: true }), 'u', now)).resolves.toMatchObject({ level: 21482, note: 'VWAP', symbol: 'MNQ' });
    await expect(loadRecentPriceAlert(db({ phone: false }), 'u', now)).resolves.toBeNull();
    await expect(loadRecentPriceAlert(db({}, 'nesmysl'), 'u', now)).resolves.toBeNull();
  });
});
