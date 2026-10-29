import { describe, expect, it } from 'vitest';
import {
  copyEventNotification,
  COPY_EVENT_IMAGE_GRACE_MS,
  planCopyEventNotifications,
  DEFAULT_STALE_AFTER_MS,
  evaluateCopierIncidents,
  RELAY_STUCK_BRAKE_AFTER_MS,
  RELAY_STUCK_CLAIMED_WINDOW_MS,
  RELAY_STUCK_COMMAND_AFTER_MS,
  RELAY_STUCK_HEARTBEAT_FRESH_MS,
  RELAY_STUCK_LONG_COMMAND_AFTER_MS,
  RELAY_STUCK_PENDING_BOOT_GRACE_MS,
  reportedRelayCommandIds,
  type CopierAlertStateRow,
  type CopierRelayCommandRow,
  type CopierRuntimeRow,
} from '../server/copierIncidentWatchdog';
import { incidentDeliveryKey, type VersionedAlertState } from '../server/notificationDelivery';

const NOW = Date.parse('2026-08-18T15:00:00Z');
const NOW_ISO = new Date(NOW).toISOString();
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

  it('divergence účtů otevře lock incident a shoda ho uzavře', () => {
    const opened = evaluate([runtime({
      status: { connected: true, divergentAccounts: [10, 11], reconciliationRequired: true },
    })]);
    expect(opened.notifications).toEqual([expect.objectContaining({
      incidentKey: 'position-divergence', title: 'Copier: ÚČTY NESOUHLASÍ',
    })]);
    const resolved = evaluate([runtime()], [state('position-divergence')]);
    expect(resolved.notifications).toEqual([expect.objectContaining({
      incidentKey: 'position-divergence', kind: 'resolved',
    })]);
  });
});

describe('hrany DISARMED <-> ARMED', () => {
  const armedMarker = (): CopierAlertStateRow => state('state:armed', true);

  it('první běh ostrý ARM nereplayuje, jen založí marker', () => {
    const result = evaluate([runtime({ status: { armed: true, shadowMode: false, connected: true } })]);
    expect(result.notifications).toHaveLength(0);
    expect(result.upserts).toContainEqual(expect.objectContaining({
      incidentKey: 'state:armed', active: true, notified: false,
    }));
  });

  it('ARM bez připravených snímků nese varování ze snapshotHealth mimo controller část', () => {
    const result = evaluate([
      runtime({ status: {
        controller: { armed: true, shadowMode: false, connected: true },
        snapshotHealth: { enabled: true, state: 'cdp-offline', layoutName: 'AlphaTrade Snapshoty' },
      } }),
    ], [state('state:armed', false)]);
    expect(result.notifications).toEqual([expect.objectContaining({
      incidentKey: 'arm-started',
      title: 'Copier: ARM aktivní bez snímků',
      body: expect.stringContaining('TradingView běží bez CDP'),
    })]);
  });

  it('produkční nested stav po hraně DISARMED -> ARM pošle zprávu právě jednou', () => {
    const first = evaluate([
      runtime({ status: { controller: { armed: true, shadowMode: false, connected: true } } }),
    ], [state('state:armed', false)]);
    expect(first.notifications).toEqual([expect.objectContaining({
      incidentKey: 'arm-started', title: 'Copier: ARM aktivní',
    })]);
    expect(first.upserts).toContainEqual(expect.objectContaining({
      incidentKey: 'state:armed', active: true, notified: true,
    }));

    const second = evaluate([
      runtime({ status: { controller: { armed: true, shadowMode: false, connected: true } } }),
    ], [armedMarker()]);
    expect(second.notifications).toHaveLength(0);
  });

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

  it('scale-in a scale-out mají vlastní srozumitelné zprávy', () => {
    const events = [
      { ...copyEvent(NOW - 6_000, 'scale-in'), kind: 'scale-in' as const, quantity: 2 },
      { ...copyEvent(NOW - 5_000, 'scale-out'), kind: 'scale-out' as const, quantity: 1 },
    ];
    const result = planEvents([runtime({ status: { recentCopyEvents: events } })], [marker(String(NOW - 60_000))]);
    expect(result.notifications.map(item => item.title)).toEqual([
      'Copier: pozice navýšena',
      'Copier: částečný výstup',
    ]);
  });

  it('čerstvý ENTRY s aktivními snapshoty počká na obrázek a po grace odejde textem', () => {
    const entry = {
      ...copyEvent(NOW - 500),
      episodeId: '11111111-1111-4111-8111-111111111111',
    };
    const waitingRuntime = runtime({
      status: {
        snapshotHealth: { enabled: true },
        controller: { recentCopyEvents: [entry] },
      },
    });
    const waiting = planEvents([waitingRuntime], [marker(String(NOW - 60_000))]);
    expect(waiting.notifications).toEqual([]);
    expect(waiting.markers).toEqual([]);

    const afterGrace = planCopyEventNotifications({
      runtimes: [waitingRuntime],
      alertStates: [marker(String(NOW - 60_000))],
      now: entry.at + COPY_EVENT_IMAGE_GRACE_MS,
    });
    expect(afterGrace.notifications).toEqual([expect.objectContaining({
      eventId: entry.id,
      title: 'Copier: vstup zkopírován',
    })]);
    expect(afterGrace.markers).toEqual([expect.objectContaining({
      detail: String(entry.at), notified: true,
    })]);
  });

  it('první živý ENTRY se neztratí ani když serverový marker ještě neexistuje', () => {
    const entry = {
      ...copyEvent(NOW - 500, 'first-entry'),
      episodeId: '11111111-1111-4111-8111-111111111111',
    };
    const firstRuntime = runtime({
      status: {
        snapshotHealth: { enabled: true },
        controller: { recentCopyEvents: [entry] },
      },
    });
    const waiting = planEvents([firstRuntime]);
    expect(waiting.notifications).toEqual([]);
    expect(waiting.markers).toEqual([expect.objectContaining({ detail: '0', notified: false })]);

    const fallback = planCopyEventNotifications({
      runtimes: [firstRuntime],
      alertStates: [marker('0')],
      now: entry.at + COPY_EVENT_IMAGE_GRACE_MS,
    });
    expect(fallback.notifications).toEqual([expect.objectContaining({ eventId: 'first-entry' })]);
  });

  it('pozdější event nepřeskočí ENTRY čekající na obrázek', () => {
    const entry = {
      ...copyEvent(NOW - 500, 'entry-with-image'),
      episodeId: '11111111-1111-4111-8111-111111111111',
    };
    const moved = { ...copyEvent(NOW - 200, 'sl-move'), kind: 'sl-moved' as const };
    const result = planEvents([runtime({
      status: {
        snapshotHealth: { enabled: true },
        controller: { recentCopyEvents: [entry, moved] },
      },
    })], [marker(String(NOW - 60_000))]);
    expect(result.notifications).toEqual([]);
    expect(result.markers).toEqual([]);
  });

  it('vypnutá snapshot pipeline ENTRY nezdržuje', () => {
    const entry = {
      ...copyEvent(NOW - 500),
      episodeId: '11111111-1111-4111-8111-111111111111',
    };
    const result = planEvents([runtime({
      status: {
        snapshotHealth: { enabled: false },
        controller: { recentCopyEvents: [entry] },
      },
    })], [marker(String(NOW - 60_000))]);
    expect(result.notifications).toHaveLength(1);
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
    expect(dayLock[0].body).toContain('Leader · jen obchody přes kopírku · bez poplatků');
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

describe('cooldown notifikace', () => {
  const until = NOW + 600_000;

  it('vznik cooldownu a jeho konec oznámí právě jednou', () => {
    const opened = evaluate([runtime({ status: { connected: true, entryCooldownUntil: until } })]);
    expect(opened.notifications).toContainEqual(expect.objectContaining({
      incidentKey: 'cooldown', kind: 'opened',
    }));
    const cooldownState: CopierAlertStateRow = {
      ...state('state:cooldown'), detail: String(until),
    };
    const steady = evaluate([runtime({ status: { connected: true, entryCooldownUntil: until } })], [cooldownState]);
    expect(steady.notifications).toHaveLength(0);
    const ended = evaluate([runtime({ status: { connected: true, entryCooldownUntil: NOW - 1 } })], [cooldownState]);
    expect(ended.notifications).toContainEqual(expect.objectContaining({
      incidentKey: 'cooldown-ended', kind: 'resolved',
    }));
  });
});

describe('auto-flatten po expiraci ARM', () => {
  const closeStatus = (close: Record<string, unknown>) => runtime({
    status: {
      armed: false, shadowMode: false, connected: true, killSwitch: false,
      stuckOutbox: false, lastError: null, autoClose: close,
    },
  });

  it('úspěšné zavření ohlásí souhrn právě jednou per operationId', () => {
    const status = closeStatus({
      operationId: 'arm-expiry:500', flat: true, canceledOrders: 1, submittedClosures: 2,
    });
    const first = evaluate([status]);
    const close = first.notifications.filter(item => item.incidentKey === 'auto-close');
    expect(close).toHaveLength(1);
    expect(close[0].title).toContain('kopie zavřeny');
    expect(close[0].body).toContain('zavřeno 2 pozic');
    expect(first.upserts.find(item => item.incidentKey === 'state:auto-close'))
      .toMatchObject({ detail: 'arm-expiry:500' });

    const second = evaluate([status], [{ ...state('state:auto-close', false), detail: 'arm-expiry:500' }]);
    expect(second.notifications.filter(item => item.incidentKey === 'auto-close')).toHaveLength(0);
  });

  it('selhané zavření křičí SELHAL s chybou', () => {
    const result = evaluate([closeStatus({
      operationId: 'arm-expiry:600', flat: false, canceledOrders: 0, submittedClosures: 0,
      error: 'Flatten nelze spustit bez broker spojení',
    })]);
    const close = result.notifications.filter(item => item.incidentKey === 'auto-close');
    expect(close).toHaveLength(1);
    expect(close[0].title).toContain('SELHAL');
    expect(close[0].body).toContain('bez broker spojení');
  });
});

describe('resume nabídka po výpadku', () => {
  const offered = runtime({
    status: {
      armed: false, shadowMode: false, connected: true, killSwitch: false,
      stuckOutbox: false, lastError: null, resumeOffer: { at: 777 },
    },
  });

  it('držené kopie se ohlásí právě jednou per nabídku', () => {
    const first = evaluate([offered]);
    const offers = first.notifications.filter(item => item.incidentKey === 'resume-offer');
    expect(offers).toHaveLength(1);
    expect(offers[0].body).toContain('ARM');
    expect(first.upserts.find(item => item.incidentKey === 'state:resume-offer'))
      .toMatchObject({ detail: '777' });

    const second = evaluate([offered], [{ ...state('state:resume-offer', false), detail: '777' }]);
    expect(second.notifications.filter(item => item.incidentKey === 'resume-offer')).toHaveLength(0);
  });
});

describe('texty lifecycle notifikací', () => {
  const base = { id: 'e1', at: 1, symbol: 'MNQU6', side: 'Long' as const, quantity: 2, followers: 5 };

  it('order-placed nese cenu a SL/TP', () => {
    const content = copyEventNotification({
      ...base, kind: 'order-placed', price: 29_500, stopPrice: 29_400, targetPrice: 29_700,
    });
    expect(content.title).toBe('Copier: obchod zadán');
    expect(content.body).toContain('@ 29500');
    expect(content.body).toContain('SL 29400');
    expect(content.body).toContain('TP 29700');
  });

  it('SL hit má vlastní titulek s P&L', () => {
    const content = copyEventNotification({ ...base, kind: 'exit', exitReason: 'sl', pnlUsd: -400 });
    expect(content.title).toBe('Copier: SL HIT −400 USD');
    expect(content.body).toContain('P&L −400 USD');
    expect(content.body).toContain('Leader · jen obchody přes kopírku · bez poplatků');
  });

  it('TP hit má vlastní titulek s P&L', () => {
    const content = copyEventNotification({ ...base, kind: 'exit', exitReason: 'tp', pnlUsd: 240 });
    expect(content.title).toBe('Copier: TP HIT +240 USD');
  });

  it('ruční exit zůstává u původního titulku', () => {
    const content = copyEventNotification({ ...base, kind: 'exit', exitReason: 'manual' });
    expect(content.title).toBe('Copier: výstup zkopírován');
  });
});

describe('potenciální P&L v textech', () => {
  const base = { id: 'e2', at: 1, symbol: 'MNQU6', side: 'Long' as const, quantity: 2, followers: 5 };

  it('order-placed nese risk/reward u SL a TP', () => {
    const content = copyEventNotification({
      ...base, kind: 'order-placed', price: 29_500,
      stopPrice: 29_400, targetPrice: 29_700, stopPnlUsd: -400, targetPnlUsd: 800,
    });
    expect(content.body).toContain('SL 29400 (−400 USD)');
    expect(content.body).toContain('TP 29700 (+800 USD)');
  });

  it('SL posunutý na break-even ukazuje (BE)', () => {
    const content = copyEventNotification({
      ...base, kind: 'sl-moved', price: 29_500, levelPnlUsd: 0,
    });
    expect(content.body).toContain('@ 29500 (BE)');
  });
});

it('durable callers rediscover another event arriving in a later heartbeat at the same millisecond', () => {
  const at = NOW - 5_000;
  const events = [{ id: 'evt-1', at, kind: 'sl-moved', episodeId: 'episode', symbol: 'NQ', side: 'long', qty: 1 },
    { id: 'evt-2', at, kind: 'sl-moved', episodeId: 'episode', symbol: 'NQ', side: 'long', qty: 1 }];
  const result = planCopyEventNotifications({
    runtimes: [runtime({ status: { recentCopyEvents: events } })],
    alertStates: [{ ...state('state:copy-events', false), detail: String(at) }],
    now: NOW, replayBoundary: true,
  });
  expect(result.notifications.map(event => event.eventId)).toEqual(['evt-1', 'evt-2']);
});
it('durable boundary replay preserves silence for a historical bootstrap baseline', () => {
  const at = NOW - 3_600_000;
  const result = planCopyEventNotifications({
    runtimes: [runtime({ status: { recentCopyEvents: [{ id: 'old', at, kind: 'entry' }] } })],
    alertStates: [{ ...state('state:copy-events'), detail: String(at) }],
    now: NOW, replayBoundary: true,
  });
  expect(result.notifications).toEqual([]);
});

describe('účet mimo synchron (etapa 2, bod 5d)', () => {
  const armedWith = (accountSyncPauses: unknown[]) => runtime({ status: {
    armed: true, shadowMode: false, connected: true, killSwitch: false, stuckOutbox: false, lastError: null,
    accountSyncPauses,
  } });
  const pause = { accountId: 68356280, symbol: 'MNQZ6', reasonCode: 'protective-filled-early', reason: 'x', pausedAt: NOW - 1_000 };
  const pausedState = (detail: string): CopierAlertStateRow => ({ ...state('account-sync:68356280'), detail });

  it('nová pauza pošle jednu zprávu a podruhé už nic', () => {
    const first = evaluate([armedWith([pause])], [state('state:armed', true)]);
    const opened = first.notifications.filter(item => item.incidentKey === 'account-sync:68356280');
    expect(opened).toEqual([expect.objectContaining({
      kind: 'opened', title: 'Účet 68356280 mimo synchron (MNQZ6)',
      body: 'Stop nebo target se vyplnil dřív než u leadera. Vynechá zbytek obchodu, ostatní kopírují dál.',
    })]);
    expect(first.upserts).toContainEqual(expect.objectContaining({
      incidentKey: 'account-sync:68356280', active: true, detail: String(pause.pausedAt),
    }));
    const second = evaluate([armedWith([pause])], [state('state:armed', true), pausedState(String(pause.pausedAt))]);
    expect(second.notifications.filter(item => item.incidentKey.startsWith('account-sync:'))).toHaveLength(0);
  });

  it('odmítnutý vstup má vlastní důvod', () => {
    const result = evaluate([armedWith([{ ...pause, reasonCode: 'entry-rejected' }])], [state('state:armed', true)]);
    const body = result.notifications.find(item => item.incidentKey === 'account-sync:68356280')?.body;
    expect(body).toContain('Broker odmítl vstup');
  });

  it('při vypnuté kopírce pauzu neohlásí — „ostatní kopírují“ by nebyla pravda', () => {
    const result = evaluate([runtime({ status: {
      armed: false, shadowMode: false, connected: true, killSwitch: false, stuckOutbox: false, lastError: null, accountSyncPauses: [pause],
    } })]);
    expect(result.notifications.filter(item => item.incidentKey.startsWith('account-sync:'))).toHaveLength(0);
  });

  it('víc pauz v jednom ticku = jedna souhrnná zpráva, markery pro všechny', () => {
    const result = evaluate([armedWith([pause, { ...pause, accountId: 68356281 }, { ...pause, accountId: 68356282 }])], [state('state:armed', true)]);
    const opened = result.notifications.filter(item => item.incidentKey.startsWith('account-sync:'));
    expect(opened).toEqual([expect.objectContaining({ title: '3 účty mimo synchron' })]);
    expect(result.upserts.filter(item => item.incidentKey.startsWith('account-sync:') && item.active)).toHaveLength(3);
  });

  it('starší worker bez pole nic neresolvuje, poškozený klíč se tiše zavře', () => {
    const noField = evaluate([runtime({ status: {
      armed: true, shadowMode: false, connected: true, killSwitch: false, stuckOutbox: false, lastError: null,
    } })], [state('state:armed', true), pausedState('1')]);
    expect(noField.upserts.filter(item => item.incidentKey.startsWith('account-sync:'))).toHaveLength(0);
    const broken = evaluate([armedWith([])], [state('state:armed', true), { ...state('account-sync:abc'), detail: '1' }]);
    expect(broken.notifications.filter(item => item.incidentKey.startsWith('account-sync:'))).toHaveLength(0);
    expect(broken.upserts).toContainEqual(expect.objectContaining({ incidentKey: 'account-sync:abc', active: false }));
  });

  it('konec pauzy při zapnuté kopírce ohlásí návrat', () => {
    const result = evaluate([armedWith([])], [state('state:armed', true), pausedState('1')]);
    expect(result.notifications).toContainEqual(expect.objectContaining({
      incidentKey: 'account-sync:68356280', kind: 'resolved', title: 'Účet 68356280 zase v synchronu',
    }));
  });

  it('konec pauzy po vypnutí kopírky se jen tiše zavře', () => {
    const result = evaluate([runtime({ status: {
      armed: false, shadowMode: false, connected: true, killSwitch: false, stuckOutbox: false, lastError: null, accountSyncPauses: [],
    } })], [state('state:armed', false), pausedState('1')]);
    expect(result.notifications.filter(item => item.incidentKey.startsWith('account-sync:'))).toHaveLength(0);
    expect(result.upserts).toContainEqual(expect.objectContaining({
      incidentKey: 'account-sync:68356280', active: false, notified: false,
    }));
  });

  it('pauzy z vnořeného controller statusu relay heartbeatu', () => {
    const result = evaluate([runtime({ status: { controller: {
      armed: true, shadowMode: false, connected: true, killSwitch: false, stuckOutbox: false, lastError: null,
      accountSyncPauses: [pause],
    } } })], [state('state:armed', true)]);
    expect(result.notifications.some(item => item.incidentKey === 'account-sync:68356280')).toBe(true);
  });
});

describe('automatické pokračování po výpadku (10. 10. 2026)', () => {
  const withResume = (phase: string, capabilities = ['transport-auto-resume-v1'], armed = phase === 'resumed') => runtime({ status: {
    capabilities,
    controller: {
      armed, shadowMode: false, connected: true, killSwitch: false, stuckOutbox: false, lastError: null,
      transportResume: { disarmAt: 1_000, armExpiresAt: 9_000, phase, reason: phase === 'declined' ? 'leader během výpadku obchodoval' : null, at: 2_000 },
    },
  } });

  it('pokračování ohlásí jednou a bez druhého „ARM zapnut“', () => {
    const first = evaluate([withResume('resumed')], [state('state:armed', false)]);
    expect(first.notifications.map(item => item.incidentKey)).toEqual(['auto-resume']);
    expect(first.notifications[0].title).toBe('Kopírka pokračuje');
    const again = evaluate([withResume('resumed')], [state('state:armed', true), { ...state('state:auto-resume', false), detail: '1000:resumed' }]);
    expect(again.notifications).toHaveLength(0);
  });

  it('odmítnutí ohlásí s důvodem; bez capability nic', () => {
    const declined = evaluate([withResume('declined')]);
    expect(declined.notifications).toContainEqual(expect.objectContaining({
      incidentKey: 'auto-resume', title: 'Kopírka po výpadku nepokračuje',
      body: 'leader během výpadku obchodoval. Zapni ji ručně.',
    }));
    expect(evaluate([withResume('declined', [])]).notifications.filter(item => item.incidentKey === 'auto-resume')).toHaveLength(0);
    expect(evaluate([withResume('waiting')]).notifications.filter(item => item.incidentKey === 'auto-resume')).toHaveLength(0);
  });
});

describe('zaseknutá fronta relaye (29. 10. 2026)', () => {
  const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const command = (partial: Partial<CopierRelayCommandRow> = {}): CopierRelayCommandRow => ({
    id: ID(1), device_id: 'dev-1', user_id: 'user-1', command_type: 'arm-live',
    status: 'claimed', created_at: iso(70_000), claimed_at: iso(65_000), error: null, ...partial,
  });
  const relay = (
    open: CopierRelayCommandRow[] | undefined,
    alertStates: CopierAlertStateRow[] = [],
    runtimes: CopierRuntimeRow[] = [runtime()],
    reported: CopierRelayCommandRow[] = [],
  ) => evaluateCopierIncidents({ runtimes, alertStates, now: NOW,
    relayQueue: open ? { open, reported, readAt: NOW } : undefined });
  const relayNotes = (result: ReturnType<typeof relay>) => result.notifications.filter(item => item.incidentKey === 'relay-stuck');
  const relayUpserts = (result: ReturnType<typeof relay>) => result.upserts.filter(item => item.incidentKey === 'relay-stuck');
  const stuckState = (detail: string): CopierAlertStateRow => ({ ...state('relay-stuck'), detail });
  const done = (partial: Partial<CopierRelayCommandRow> = {}) => command({ status: 'succeeded', ...partial });

  it('claimed příkaz po limitu otevře výstrahu jednou, stejná sada dál mlčí', () => {
    const opened = relay([command()]);
    expect(relayNotes(opened)).toEqual([expect.objectContaining({ kind: 'opened', title: 'Copier: relay příkaz visí' })]);
    expect(relayNotes(opened)[0].body).toBe('Worker převzal příkaz arm-live před 65 s a výsledek nepotvrdil. Pokud ho stále provádí, další příkazy včetně OFF čekají za ním.');
    expect(relayUpserts(opened)).toEqual([expect.objectContaining({ active: true, detail: `c:${ID(1)}`, notified: true })]);
    const again = relay([command()], [stuckState(`c:${ID(1)}`)]);
    expect(relayNotes(again)).toHaveLength(0);
    expect(relayUpserts(again)).toHaveLength(0);
  });

  it('limity: brzda 30 s, arm-live 60 s, dlouhé příkazy (Flatten, skupina) 5 min', () => {
    expect(relayNotes(relay([command({ claimed_at: iso(RELAY_STUCK_COMMAND_AFTER_MS) })]))).toHaveLength(0);
    expect(relayNotes(relay([command({ claimed_at: iso(RELAY_STUCK_COMMAND_AFTER_MS + 1) })]))).toHaveLength(1);
    expect(relayNotes(relay([command({ command_type: 'snapshot-test', claimed_at: iso(RELAY_STUCK_COMMAND_AFTER_MS + 1) })]))).toHaveLength(1);
    expect(relayNotes(relay([command({ command_type: 'disarm', claimed_at: iso(RELAY_STUCK_BRAKE_AFTER_MS) })]))).toHaveLength(0);
    for (const type of ['disarm', 'kill-switch', 'lock-until-session-end']) {
      const result = relay([command({ command_type: type, claimed_at: iso(RELAY_STUCK_BRAKE_AFTER_MS + 1) })]);
      expect(relayNotes(result)).toEqual([expect.objectContaining({ title: 'Copier: BRZDA NEPOTVRZENA' })]);
    }
    for (const type of ['copy-command', 'activate-group', 'verify-account-eligibility']) {
      expect(relayNotes(relay([command({ command_type: type, claimed_at: iso(RELAY_STUCK_LONG_COMMAND_AFTER_MS) })]))).toHaveLength(0);
      expect(relayNotes(relay([command({ command_type: type, claimed_at: iso(RELAY_STUCK_LONG_COMMAND_AFTER_MS + 1) })]))).toHaveLength(1);
    }
  });

  it('DISARM za legitimně běžícím Flattenem nevyzývá k ručnímu zavírání', () => {
    const result = relay([
      command({ command_type: 'copy-command', created_at: iso(125_000), claimed_at: iso(120_000) }),
      command({ id: ID(2), command_type: 'disarm', status: 'pending', claimed_at: null, created_at: iso(40_000) }),
    ]);
    const [note] = relayNotes(result);
    expect(note.title).toBe('Copier: brzda čeká ve frontě');
    expect(note.body).toBe('DISARM čeká 40 s za běžícím příkazem copy-command (převzat před 120 s). Worker by ji měl provést, až ten příkaz doběhne; ruční zásah v Tradovate teď může s ním kolidovat. Pokud se zasekne, přijde poplach.');
    expect(note.body).not.toContain('zavři pozice');
    expect(relayUpserts(result)[0].detail).toBe(`w:${ID(2)}`);
  });

  it('měkce ohlášená brzda eskaluje právě jednou, když se příkaz před ní zasekne', () => {
    const disarm = (msAgo: number) => command({ id: ID(2), command_type: 'disarm', status: 'pending', claimed_at: null, created_at: iso(msAgo) });
    const flatten = (claimedAgo: number) => command({ command_type: 'copy-command', created_at: iso(claimedAgo + 5_000), claimed_at: iso(claimedAgo) });
    // Flatten pořád běží (pod 5 min) → ticho.
    const stillRunning = relay([flatten(200_000), disarm(100_000)], [stuckState(`w:${ID(2)}`)]);
    expect(relayNotes(stillRunning)).toHaveLength(0);
    expect(relayUpserts(stillRunning)).toHaveLength(0);
    // Flatten překročil limit → jeden poplach s nouzovou radou, `w` → `b`.
    const escalated = relay([flatten(RELAY_STUCK_LONG_COMMAND_AFTER_MS + 1), disarm(250_000)], [stuckState(`w:${ID(2)}`)]);
    expect(relayNotes(escalated)).toEqual([expect.objectContaining({ kind: 'opened', title: 'Copier: BRZDA NEPOTVRZENA' })]);
    expect(relayNotes(escalated)[0].body).toContain('v nouzi zavři pozice');
    const detail = relayUpserts(escalated)[0].detail!;
    expect(detail).toBe(`b:${ID(2)},c:${ID(1)}`);
    const nextTick = relay([flatten(RELAY_STUCK_LONG_COMMAND_AFTER_MS + 60_001), disarm(310_000)], [stuckState(detail)]);
    expect(relayNotes(nextTick)).toHaveLength(0);
  });

  it('pending brzda starší než 24 h nespamuje: dva ticky = žádný další push', () => {
    const oldBrake = command({ id: ID(2), command_type: 'disarm', status: 'pending', claimed_at: null, created_at: iso(RELAY_STUCK_CLAIMED_WINDOW_MS + 60_000) });
    for (let tick = 0; tick < 2; tick += 1) {
      const result = relay([oldBrake], [stuckState(`b:${ID(2)}`)], [runtime()], [oldBrake]);
      expect(result.notifications).toHaveLength(0);
      expect(relayUpserts(result)).toHaveLength(0);
    }
  });

  it('DISARM, který nic nebrzdí, je poplach s nouzovou radou', () => {
    const result = relay([command({ id: ID(2), command_type: 'disarm', status: 'pending', claimed_at: null, created_at: iso(40_000) })]);
    expect(relayNotes(result)[0]).toMatchObject({ title: 'Copier: BRZDA NEPOTVRZENA',
      body: 'DISARM čeká ve frontě 40 s a worker si ji nevyzvedl, přestože žije. Brzda možná neproběhla — ověř stav v Tradovate a v nouzi zavři pozice tam.' });
    // Za zaseknutým (ne běžícím) příkazem platí totéž.
    const behindStuck = relay([command({ command_type: 'copy-command', claimed_at: iso(RELAY_STUCK_LONG_COMMAND_AFTER_MS + 1) }),
      command({ id: ID(2), command_type: 'disarm', status: 'pending', claimed_at: null, created_at: iso(40_000) })]);
    expect(relayNotes(behindStuck)[0].title).toBe('Copier: BRZDA NEPOTVRZENA');
  });

  it('první brzda eskaluje, další kliky OFF a nové ne-brzdy už jen tiše doplní detail', () => {
    const escalated = relay(
      [command(), command({ id: ID(2), command_type: 'kill-switch', status: 'pending', claimed_at: null, created_at: iso(31_000) })],
      [stuckState(`c:${ID(1)}`)],
    );
    expect(relayNotes(escalated)).toEqual([expect.objectContaining({ kind: 'opened', title: 'Copier: BRZDA NEPOTVRZENA' })]);
    expect(relayUpserts(escalated)).toEqual([expect.objectContaining({ detail: `b:${ID(2)},c:${ID(1)}`, notified: true })]);
    const moreClicks = relay(
      [command(), command({ id: ID(2), command_type: 'kill-switch', status: 'pending', claimed_at: null, created_at: iso(91_000) }),
        command({ id: ID(3), command_type: 'disarm', status: 'pending', claimed_at: null, created_at: iso(35_000) })],
      [stuckState(`b:${ID(2)},c:${ID(1)}`)],
    );
    expect(relayNotes(moreClicks)).toHaveLength(0);
    // Další brzda za už poplachově ohlášenou se drží jako `w`: kdyby první
    // prošla a tahle dál visela, znovu eskaluje.
    expect(relayUpserts(moreClicks)).toEqual([expect.objectContaining({ detail: `b:${ID(2)},w:${ID(3)},c:${ID(1)}`, notified: false })]);
  });

  it('víc než 20 zaseknutých: nová brzda přesto eskaluje a strop ji neodřízne', () => {
    const many = Array.from({ length: 25 }, (_, index) => command({ id: ID(index + 10), created_at: iso(200_000 - index) }));
    const reported = `${many.slice(0, 20).map(item => `c:${item.id}`).join(',')}`;
    const result = relay([...many, command({ id: ID(99), command_type: 'disarm', status: 'pending', claimed_at: null, created_at: iso(31_000) })],
      [stuckState(reported)]);
    expect(relayNotes(result)).toEqual([expect.objectContaining({ title: 'Copier: BRZDA NEPOTVRZENA' })]);
    const detail = relayUpserts(result)[0].detail!.split(',');
    expect(detail).toHaveLength(20);
    expect(detail[0]).toBe(`b:${ID(99)}`);
    const again = relay([...many, command({ id: ID(99), command_type: 'disarm', status: 'pending', claimed_at: null, created_at: iso(91_000) })],
      [stuckState(relayUpserts(result)[0].detail!)]);
    expect(relayNotes(again)).toHaveLength(0);
    expect(relayUpserts(again)).toHaveLength(0);
  });

  it('uzavření až se známým koncem: dokončené příkazy = fronta průchozí', () => {
    const result = relay([], [stuckState(`c:${ID(1)}`)], [runtime()], [done()]);
    expect(relayNotes(result)).toEqual([expect.objectContaining({
      kind: 'resolved', title: 'Copier: relay fronta průchozí', body: 'Zaseknuté příkazy worker dokončil.',
    })]);
    expect(relayUpserts(result)).toEqual([expect.objectContaining({ active: false, detail: null })]);
  });

  it('brzda, která vypršela nebo byla odmítnuta, je hned poplach (jednou per id), ne „průchozí“', () => {
    for (const ended of [
      done({ id: ID(2), command_type: 'disarm', status: 'expired', error: 'command-expired' }),
      done({ id: ID(2), command_type: 'disarm', status: 'rejected', error: 'command-expired-or-predates-worker-session' }),
    ]) {
      const result = relay([], [stuckState(`b:${ID(2)},c:${ID(1)}`)], [runtime()], [ended, done()]);
      expect(result.notifications).toEqual([expect.objectContaining({ incidentKey: `relay-brake-failed:${ID(2)}`, kind: 'opened',
        title: 'Copier: BRZDA NEPROVEDENA',
        body: `DISARM skončila bez potvrzeného provedení (${ended.error}). Kopírka může být stále zapnutá — zkontroluj LIVE a pozice v Tradovate.` })]);
      // „Fronta průchozí“ by poplach přebil — výstraha se zavře tiše.
      expect(relayUpserts(result)).toEqual([expect.objectContaining({ active: false, detail: null, notified: true })]);
    }
  });

  it('selhaná brzda se ohlásí hned, i když jiný řádek frontu dál drží', () => {
    const other = command({ command_type: 'copy-command', claimed_at: iso(100_000) });
    const failed = done({ id: ID(2), command_type: 'kill-switch', status: 'expired', error: 'command-expired' });
    const result = relay([other], [stuckState(`b:${ID(2)},c:${ID(1)}`)], [runtime()], [failed, other]);
    expect(result.notifications.map(item => item.incidentKey)).toEqual([`relay-brake-failed:${ID(2)}`]);
    expect(relayUpserts(result)).toEqual([expect.objectContaining({ active: true, detail: `c:${ID(1)}` })]);
    // Další tick už brzdu nezná → žádný druhý poplach.
    expect(relay([other], [stuckState(`c:${ID(1)}`)], [runtime()], [other]).notifications).toHaveLength(0);
  });

  it('osiřelá převzatá brzda > 24 h je poplach, ne tiché uzavření', () => {
    const orphanBrake = command({ id: ID(2), command_type: 'disarm', created_at: iso(RELAY_STUCK_CLAIMED_WINDOW_MS + 10_000), claimed_at: iso(RELAY_STUCK_CLAIMED_WINDOW_MS + 1) });
    const result = relay([], [stuckState(`b:${ID(2)}`)], [runtime()], [orphanBrake]);
    expect(result.notifications).toEqual([expect.objectContaining({ incidentKey: `relay-brake-failed:${ID(2)}`, title: 'Copier: BRZDA BEZ VÝSLEDKU' })]);
    expect(relayUpserts(result)).toEqual([expect.objectContaining({ active: false })]);
  });

  it('úspěšná ohlášená brzda se vyřadí a další zaseknutá brzda znovu eskaluje', () => {
    const result = relay(
      [command(), command({ id: ID(3), command_type: 'disarm', status: 'pending', claimed_at: null, created_at: iso(35_000) })],
      [stuckState(`b:${ID(2)},c:${ID(1)}`)], [runtime()],
      [done({ id: ID(2), command_type: 'disarm' }), command()],
    );
    expect(relayNotes(result)).toEqual([expect.objectContaining({ kind: 'opened', title: 'Copier: BRZDA NEPOTVRZENA' })]);
    expect(relayUpserts(result)).toEqual([expect.objectContaining({ detail: `b:${ID(3)},c:${ID(1)}` })]);
  });

  it('poplachová brzda prošla, ale tiše přidaná `w` brzda dál visí → nový poplach', () => {
    const stuckBrake = command({ id: ID(3), command_type: 'disarm', status: 'pending', claimed_at: null, created_at: iso(95_000) });
    const result = relay([stuckBrake], [stuckState(`b:${ID(2)},w:${ID(3)}`)], [runtime()],
      [done({ id: ID(2), command_type: 'disarm' }), stuckBrake]);
    expect(relayNotes(result)).toEqual([expect.objectContaining({ title: 'Copier: BRZDA NEPOTVRZENA' })]);
    expect(relayUpserts(result)[0].detail).toBe(`b:${ID(3)}`);
  });

  it('nejistý copy-command (Flatten) při uzavření je poplach s badge, ne „průchozí“', () => {
    const result = relay([], [stuckState(`c:${ID(1)}`)], [runtime()],
      [done({ command_type: 'copy-command', status: 'rejected', error: 'command-outcome-unknown-after-restart' })]);
    expect(relayNotes(result)).toEqual([expect.objectContaining({ kind: 'opened', title: 'Copier: výsledek příkazu nejistý',
      body: 'Ve frontě už nic nevisí, ale copy-command skončil bez potvrzeného výsledku (command-outcome-unknown-after-restart). Ověř pozice v LIVE.' })]);
    expect(relayUpserts(result)).toEqual([expect.objectContaining({ active: false })]);
  });

  it('restart workeru: pending brzda v boot grace výstrahu neuzavře', () => {
    const restarted = runtime({ started_at: iso(10_000) });
    const pendingBrake = command({ id: ID(2), command_type: 'disarm', status: 'pending', claimed_at: null, created_at: iso(90_000) });
    const result = relay([pendingBrake], [stuckState(`b:${ID(2)}`)], [restarted], [pendingBrake]);
    expect(relayNotes(result)).toHaveLength(0);
    expect(relayUpserts(result)).toHaveLength(0);
    // Po boot grace se znovu počítá jako zaseknutá, bez nové zprávy.
    const later = relay([pendingBrake], [stuckState(`b:${ID(2)}`)], [runtime({ started_at: iso(RELAY_STUCK_PENDING_BOOT_GRACE_MS + 1) })]);
    expect(relayNotes(later)).toHaveLength(0);
  });

  it('pending se do konce boot grace nehlásí, potom ano', () => {
    const old = command({ command_type: 'arm-live', status: 'pending', claimed_at: null, created_at: iso(10 * 60_000) });
    expect(relayNotes(relay([old], [], [runtime({ started_at: iso(RELAY_STUCK_PENDING_BOOT_GRACE_MS) })]))).toHaveLength(0);
    const result = relay([old], [], [runtime({ started_at: iso(RELAY_STUCK_PENDING_BOOT_GRACE_MS + 1) })]);
    expect(relayNotes(result)[0].body).toBe('Příkaz arm-live čeká ve frontě 600 s a worker si ho nevyzvedl, přestože žije. OFF může čekat také.');
  });

  it('neznámý konec ohlášeného příkazu (chybí řádek, ještě otevřený) výstrahu neuzavře', () => {
    expect(relayNotes(relay([], [stuckState(`c:${ID(1)}`)], [runtime()], []))).toHaveLength(0);
    // Opačné pořadí čtení: v open už není, ale lookup ho vidí claimed v okně.
    expect(relayNotes(relay([], [stuckState(`c:${ID(1)}`)], [runtime()], [command()]))).toHaveLength(0);
  });

  it('osiřelý claimed starší než 24 h se uzavře poctivě, ne jako „průchozí“', () => {
    const orphan = command({ created_at: iso(RELAY_STUCK_CLAIMED_WINDOW_MS + 10_000), claimed_at: iso(RELAY_STUCK_CLAIMED_WINDOW_MS + 1) });
    const result = relay([], [stuckState(`c:${ID(1)}`)], [runtime()], [orphan]);
    expect(relayNotes(result)).toEqual([expect.objectContaining({ kind: 'resolved', title: 'Copier: relay výstraha uzavřena bez výsledku' })]);
  });

  it('jiný otevřený řádek starší než 30 s (ještě pod limitem) uzavření odloží', () => {
    const running = command({ id: ID(5), command_type: 'copy-command', claimed_at: iso(45_000) });
    expect(relayNotes(relay([running], [stuckState(`c:${ID(1)}`)], [runtime()], [done()]))).toHaveLength(0);
  });

  it('nepřečtená fronta (undefined) neotevírá ani neuzavírá', () => {
    const result = relay(undefined, [stuckState(`c:${ID(1)}`)]);
    expect(relayNotes(result)).toHaveLength(0);
    expect(relayUpserts(result)).toHaveLength(0);
  });

  it('heartbeat kolem 30 s: na hraně se vyhodnocuje, nad ní výstraha zůstane; offline řeší worker-offline', () => {
    expect(relayNotes(relay([command()], [], [runtime({ last_seen_at: iso(RELAY_STUCK_HEARTBEAT_FRESH_MS) })]))).toHaveLength(1);
    const aging = runtime({ last_seen_at: iso(RELAY_STUCK_HEARTBEAT_FRESH_MS + 1) });
    expect(relayNotes(relay([command()], [], [aging]))).toHaveLength(0);
    expect(relayNotes(relay([], [stuckState(`c:${ID(1)}`)], [aging], [done()]))).toHaveLength(0);
    const offline = relay([command()], [stuckState(`c:${ID(1)}`)], [runtime({ last_seen_at: iso(DEFAULT_STALE_AFTER_MS + 1) })]);
    expect(offline.notifications.map(item => item.incidentKey)).toEqual(['worker-offline']);
    expect(relayUpserts(offline)).toHaveLength(0);
  });

  it('claimed bez času převzetí je zaseknutý (jen výstraha, hlasitě)', () => {
    expect(relayNotes(relay([command({ claimed_at: null })]))[0].body).toContain('před neznámo jak dlouho');
  });

  it('příkaz jiného zařízení nebo uživatele se nepočítá', () => {
    expect(relayNotes(relay([command({ device_id: 'dev-2' }), command({ id: ID(3), user_id: 'user-2' })]))).toHaveLength(0);
  });

  it('ohlášená id pro cron: jen z aktivních výstrah a jen platná', () => {
    expect(reportedRelayCommandIds([
      stuckState(`b:${ID(2)},c:${ID(1)},c:nonsense,x:${ID(4)}`),
      { ...stuckState(`c:${ID(3)}`), active: false },
    ])).toEqual([ID(2), ID(1)]);
  });

  it('dedupe: uzavírací poplach má jiný doručovací klíč než otevření a brzda má klíč s id', () => {
    const opened = incidentDeliveryKey({ deviceId: 'dev-1', key: 'relay-stuck', kind: 'opened' }, undefined);
    const closingAlarm = incidentDeliveryKey({ deviceId: 'dev-1', key: 'relay-stuck', kind: 'opened' },
      { ...stuckState(`c:${ID(1)}`), updated_at: NOW_ISO, notification_version: 'v-2' } as VersionedAlertState);
    expect(closingAlarm).not.toBe(opened);
    expect(incidentDeliveryKey({ deviceId: 'dev-1', key: `relay-brake-failed:${ID(2)}`, kind: 'opened' }, undefined))
      .not.toBe(incidentDeliveryKey({ deviceId: 'dev-1', key: `relay-brake-failed:${ID(3)}`, kind: 'opened' }, undefined));
  });

  it('nic neřídí execution: výstup jsou jen notifikace a markery', () => {
    expect(Object.keys(relay([command({ command_type: 'disarm' })])).sort()).toEqual(['notifications', 'upserts']);
  });
});

describe('fáze 1b: push o výsledku ručního vstupu', () => {
  const entry = (patch: Record<string, unknown> = {}) => ({
    operationId: 'entry:abc', status: 'acknowledged', createdAt: NOW - 5_000, updatedAt: NOW - 4_000,
    symbol: 'MNQZ6', side: 'Buy', quantity: 1, ...patch,
  });
  const withEntries = (entries: unknown[]) => runtime({ status: { armed: true, shadowMode: false, connected: true, killSwitch: false, stuckOutbox: false, lastError: null, manualEntries: entries } });
  const manual = (result: ReturnType<typeof evaluate>) => result.notifications.filter(item => item.incidentKey.startsWith('manual-entry:'));

  it('přijatý, odmítnutý, neznámý i bez ochrany → jedna zpráva s klíčem operace', () => {
    for (const [status, title] of [['acknowledged', 'přijat'], ['rejected', 'odmítnut'], ['unknown', 'neznámý'], ['abandoned', 'bez ochrany']] as const) {
      const result = evaluate([withEntries([entry({ status })])]);
      expect(manual(result)).toEqual([expect.objectContaining({ incidentKey: 'manual-entry:entry:abc', title: expect.stringContaining(title) })]);
      expect(result.upserts).toContainEqual(expect.objectContaining({ incidentKey: 'manual-entry:entry:abc', detail: status, active: false }));
    }
  });

  it('stejný stav se nehlásí podruhé; změna stavu ano; sending a waived nikdy', () => {
    const seen: CopierAlertStateRow = { ...state('manual-entry:entry:abc', false), detail: 'unknown' } as CopierAlertStateRow;
    expect(manual(evaluate([withEntries([entry({ status: 'unknown' })])], [seen]))).toEqual([]);
    expect(manual(evaluate([withEntries([entry({ status: 'acknowledged' })])], [seen]))).toHaveLength(1);
    expect(manual(evaluate([withEntries([entry({ status: 'sending' }), entry({ operationId: 'entry:w', status: 'waived' })])]))).toEqual([]);
  });

  it('starý záznam (po nasazení) se nehlásí; offline worker nehlásí nic', () => {
    expect(manual(evaluate([withEntries([entry({ updatedAt: NOW - 11 * 60_000 })])]))).toEqual([]);
    expect(manual(evaluate([{ ...withEntries([entry()]), last_seen_at: iso(DEFAULT_STALE_AFTER_MS + 1_000) }]))).toEqual([]);
  });
});

describe('fáze 1b: push o zrušení vlastního vstupu', () => {
  const entry = (patch: Record<string, unknown> = {}) => ({
    operationId: 'entry:c1', status: 'acknowledged', createdAt: NOW - 5_000, updatedAt: NOW - 4_000,
    symbol: 'MNQZ6', side: 'Buy', quantity: 1, ...patch,
  });
  const run = (entries: unknown[]) => evaluate([runtime({ status: { armed: true, shadowMode: false, connected: true, killSwitch: false, stuckOutbox: false, lastError: null, manualEntries: entries } })])
    .notifications.filter(item => item.incidentKey.startsWith('manual-entry:'));

  it('úspěch je informace, problém je výstraha', () => {
    expect(run([entry()])[0]).toMatchObject({ kind: 'resolved', title: 'Ruční vstup přijat' });
    expect(run([entry({ status: 'unknown' })])[0]).toMatchObject({ kind: 'opened' });
  });

  it('rozběhnuté zrušení se nehlásí; selhání nikdy netvrdí „zrušeno“', () => {
    expect(run([entry({ cancel: 'sending' })])).toEqual([]);
    expect(run([entry({ cancel: 'sent' })])[0]).toMatchObject({ title: 'Ruční vstup zrušen' });
    const failed = run([entry({ cancel: 'failed' })])[0];
    expect(failed.title).toContain('selhalo');
    expect(failed.body).toContain('SELHALO');
    expect(run([entry({ status: 'abandoned', cancel: 'failed' })])[0].body).toContain('SELHALO');
  });
});
