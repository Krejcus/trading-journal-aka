import { describe, expect, it } from 'vitest';
import {
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
