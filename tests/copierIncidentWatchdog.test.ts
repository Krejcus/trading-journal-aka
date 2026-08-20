import { describe, expect, it } from 'vitest';
import {
  planCopyEventNotifications,
  DEFAULT_STALE_AFTER_MS,
  evaluateCopierIncidents,
  type CopierAlertStateRow,
  type CopierRuntimeRow,
} from '../server/copierIncidentWatchdog';

const NOW = Date.parse('2026-08-18T15:00:00Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const runtime = (partial: Partial<CopierRuntimeRow> = {}): CopierRuntimeRow => ({
  device_id: 'dev-1',
  user_id: 'user-1',
  status: { armed: false, shadowMode: true, connected: true, killSwitch: false, stuckOutbox: false, lastError: null },
  last_seen_at: iso(5_000),
  started_at: iso(3_600_000),
  ...partial,
});

const state = (incidentKey: string, active = true): CopierAlertStateRow => ({
  device_id: 'dev-1', user_id: 'user-1', incident_key: incidentKey, active,
});

const evaluate = (runtimes: CopierRuntimeRow[], alertStates: CopierAlertStateRow[] = []) =>
  evaluateCopierIncidents({ runtimes, alertStates, now: NOW });

describe('worker offline', () => {
  it('starý heartbeat otevře incident právě jednou', () => {
    const first = evaluate([runtime({ last_seen_at: iso(DEFAULT_STALE_AFTER_MS + 60_000) })]);
    expect(first.notifications).toHaveLength(1);
    expect(first.notifications[0]).toMatchObject({ incidentKey: 'worker-offline', kind: 'opened' });
    // Druhý průchod se stejným stavem už nic neposílá.
    const second = evaluate(
      [runtime({ last_seen_at: iso(DEFAULT_STALE_AFTER_MS + 120_000) })],
      [state('worker-offline')],
    );
    expect(second.notifications).toHaveLength(0);
  });

  it('návrat heartbeatu pošle zotavení', () => {
    const result = evaluate([runtime()], [state('worker-offline')]);
    expect(result.notifications).toEqual([expect.objectContaining({
      incidentKey: 'worker-offline', kind: 'resolved',
    })]);
  });

  it('offline neresolvuje ostatní incidenty — bez heartbeatu nic nevíme', () => {
    const result = evaluate(
      [runtime({ last_seen_at: iso(DEFAULT_STALE_AFTER_MS + 60_000) })],
      [state('worker-offline'), state('fail-closed')],
    );
    expect(result.notifications).toHaveLength(0);
    expect(result.upserts.filter(item => item.incidentKey === 'fail-closed')).toHaveLength(0);
  });
});

describe('stavové incidenty', () => {
  it('fail-closed nese text chyby a po odeznění se uzavře', () => {
    const opened = evaluate([runtime({
      status: { armed: false, shadowMode: true, connected: true, lastError: 'OSO nebyl bezpečně potvrzen brokerem' },
    })]);
    expect(opened.notifications).toEqual([expect.objectContaining({
      incidentKey: 'fail-closed', kind: 'opened',
      body: 'OSO nebyl bezpečně potvrzen brokerem',
    })]);
    const resolved = evaluate([runtime()], [state('fail-closed')]);
    expect(resolved.notifications).toEqual([expect.objectContaining({
      incidentKey: 'fail-closed', kind: 'resolved',
    })]);
  });

  it('přechodná chyba u běžícího ARMED runtime není fail-closed incident', () => {
    const result = evaluate([runtime({
      status: {
        armed: true, shadowMode: false, connected: true,
        lastError: 'Tradovate WebSocket transport error',
      },
    })]);
    expect(result.notifications.filter(item => item.incidentKey === 'fail-closed')).toHaveLength(0);
  });

  it('kill switch má přednost před fail-closed (jedna zpráva, ne dvě)', () => {
    const result = evaluate([runtime({
      status: { killSwitch: true, lastError: 'Ruční nouzové zastavení', connected: true },
    })]);
    expect(result.notifications.map(item => item.incidentKey)).toEqual(['kill-switch']);
  });

  it('odpojený broker se hlásí až po boot grace', () => {
    const booting = evaluate([runtime({
      status: { connected: false }, started_at: iso(30_000),
    })]);
    expect(booting.notifications).toHaveLength(0);
    const settled = evaluate([runtime({
      status: { connected: false }, started_at: iso(600_000),
    })]);
    expect(settled.notifications).toEqual([expect.objectContaining({
      incidentKey: 'broker-disconnected', kind: 'opened',
    })]);
  });

  it('stuck outbox otevře incident', () => {
    const result = evaluate([runtime({ status: { connected: true, stuckOutbox: true } })]);
    expect(result.notifications).toEqual([expect.objectContaining({ incidentKey: 'stuck-outbox' })]);
  });
});

describe('hrana armed -> disarmed', () => {
  const armedMarker = (): CopierAlertStateRow => state('state:armed', true);

  it('tichý konec ostrého ARM pošle jednorázovou zprávu', () => {
    const result = evaluate([runtime()], [armedMarker()]);
    expect(result.notifications).toEqual([expect.objectContaining({
      incidentKey: 'arm-ended', title: 'Copier: ARM skončil',
    })]);
    // Marker se přepne, aby další tick nehlásil znovu.
    expect(result.upserts).toContainEqual(expect.objectContaining({
      incidentKey: 'state:armed', active: false, notified: false,
    }));
  });

  it('konec ARM kvůli chybě nehlásí duplicitně — kryje ho fail-closed', () => {
    const result = evaluate([runtime({
      status: { armed: false, lastError: 'Divergence', connected: true },
    })], [armedMarker()]);
    expect(result.notifications.map(item => item.incidentKey)).toEqual(['fail-closed']);
  });

  it('shadow ARM markeru nevzniká a jeho konec nic neposílá', () => {
    const armedShadow = evaluate([runtime({ status: { armed: true, shadowMode: true, connected: true } })]);
    expect(armedShadow.upserts.find(item => item.incidentKey === 'state:armed')?.active ?? false)
      .toBe(false);
  });

  it('ostrý ARM jen zapíše marker bez notifikace', () => {
    const result = evaluate([runtime({ status: { armed: true, shadowMode: false, connected: true } })]);
    expect(result.notifications).toHaveLength(0);
    expect(result.upserts).toContainEqual(expect.objectContaining({
      incidentKey: 'state:armed', active: true, notified: false,
    }));
  });
});

describe('víc zařízení a uživatelů', () => {
  it('incidenty se vyhodnocují nezávisle per zařízení', () => {
    const result = evaluate([
      runtime({ device_id: 'dev-1', status: { connected: true, stuckOutbox: true } }),
      runtime({ device_id: 'dev-2', user_id: 'user-2', last_seen_at: iso(DEFAULT_STALE_AFTER_MS + 60_000) }),
    ]);
    expect(result.notifications).toEqual([
      expect.objectContaining({ deviceId: 'dev-1', incidentKey: 'stuck-outbox' }),
      expect.objectContaining({ deviceId: 'dev-2', userId: 'user-2', incidentKey: 'worker-offline' }),
    ]);
  });
});

describe('trade notifikace (planCopyEventNotifications)', () => {
  const copyEvent = (at: number, id = `${at}-1`) => ({
    id, at, kind: 'entry' as const, symbol: 'MNQU6', side: 'Long' as const, quantity: 4, followers: 5,
  });
  const marker = (detail: string): CopierAlertStateRow => ({
    device_id: 'dev-1', user_id: 'user-1', incident_key: 'state:copy-events', active: false, detail,
  });
  const planEvents = (runtimes: CopierRuntimeRow[], alertStates: CopierAlertStateRow[] = []) =>
    planCopyEventNotifications({ runtimes, alertStates, now: NOW });

  it('první běh historii nepřehrává, jen posune hranici', () => {
    const result = planEvents([runtime({ status: { recentCopyEvents: [copyEvent(NOW - 5_000)] } })]);
    expect(result.notifications).toEqual([]);
    expect(result.markers).toEqual([expect.objectContaining({
      incidentKey: 'state:copy-events', detail: String(NOW - 5_000), notified: false,
    })]);
  });

  it('event za hranicí markeru pošle notifikaci právě jednou', () => {
    const status = { recentCopyEvents: [copyEvent(NOW - 5_000)] };
    const first = planEvents([runtime({ status })], [marker(String(NOW - 60_000))]);
    expect(first.notifications).toEqual([expect.objectContaining({
      title: 'Copier: vstup zkopírován', body: 'Long 4 MNQU6 → 5 followerů.',
    })]);
    const second = planEvents([runtime({ status })], [marker(String(NOW - 5_000))]);
    expect(second.notifications).toEqual([]);
    expect(second.markers).toEqual([]);
  });

  it('offline worker se nevyhodnocuje', () => {
    const result = planEvents([runtime({
      status: { recentCopyEvents: [copyEvent(NOW - 5_000)] },
      last_seen_at: iso(DEFAULT_STALE_AFTER_MS + 60_000),
    })], [marker(String(NOW - 60_000))]);
    expect(result.notifications).toEqual([]);
  });
});

describe('day-lock notifikace', () => {
  const until = NOW + 3_600_000;
  const locked = runtime({
    status: {
      armed: false, shadowMode: false, connected: true, killSwitch: false,
      stuckOutbox: false, lastError: null,
      dayLockUntil: until, dayLockReason: 'auto day-lock: denní ztráta 120 USD dosáhla limitu 100 USD',
    },
  });

  it('aktivní day-lock ohlásí právě jednou a nese důvod', () => {
    const first = evaluate([locked]);
    const dayLock = first.notifications.filter(item => item.incidentKey === 'day-lock');
    expect(dayLock).toHaveLength(1);
    expect(dayLock[0].body).toContain('denní ztráta 120 USD');
    const marker = first.upserts.find(item => item.incidentKey === 'state:day-lock');
    expect(marker).toMatchObject({ detail: String(until), notified: true });

    const second = evaluate([locked], [{ ...state('state:day-lock', false), detail: String(until) }]);
    expect(second.notifications.filter(item => item.incidentKey === 'day-lock')).toHaveLength(0);
  });

  it('nový zámek (jiné dayLockUntil) notifikuje znovu; prošlý zámek mlčí', () => {
    const relocked = evaluate([locked], [{ ...state('state:day-lock', false), detail: String(until - 1) }]);
    expect(relocked.notifications.filter(item => item.incidentKey === 'day-lock')).toHaveLength(1);

    const expired = runtime({
      status: { ...locked.status, dayLockUntil: NOW - 1_000 },
    });
    const silent = evaluate([expired]);
    expect(silent.notifications.filter(item => item.incidentKey === 'day-lock')).toHaveLength(0);
  });
});

describe('auto-flatten po expiraci ARM', () => {
  const closeStatus = (close: Record<string, unknown>) => runtime({
    status: {
      armed: false, shadowMode: false, connected: true, killSwitch: false,
      stuckOutbox: false, lastError: null, armExpiryClose: close,
    },
  });

  it('úspěšné zavření ohlásí souhrn právě jednou per operationId', () => {
    const status = closeStatus({
      operationId: 'arm-expiry:500', flat: true, canceledOrders: 1, submittedClosures: 2,
    });
    const first = evaluate([status]);
    const close = first.notifications.filter(item => item.incidentKey === 'arm-expiry-close');
    expect(close).toHaveLength(1);
    expect(close[0].title).toContain('kopie zavřeny');
    expect(close[0].body).toContain('zavřeno 2 pozic');
    expect(first.upserts.find(item => item.incidentKey === 'state:arm-expiry-close'))
      .toMatchObject({ detail: 'arm-expiry:500' });

    const second = evaluate([status], [{ ...state('state:arm-expiry-close', false), detail: 'arm-expiry:500' }]);
    expect(second.notifications.filter(item => item.incidentKey === 'arm-expiry-close')).toHaveLength(0);
  });

  it('selhané zavření křičí SELHAL s chybou', () => {
    const result = evaluate([closeStatus({
      operationId: 'arm-expiry:600', flat: false, canceledOrders: 0, submittedClosures: 0,
      error: 'Flatten nelze spustit bez broker spojení',
    })]);
    const close = result.notifications.filter(item => item.incidentKey === 'arm-expiry-close');
    expect(close).toHaveLength(1);
    expect(close[0].title).toContain('SELHAL');
    expect(close[0].body).toContain('bez broker spojení');
  });
});
