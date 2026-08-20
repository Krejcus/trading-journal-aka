import { describe, expect, it } from 'vitest';
import {
  planCopierNotifications,
  type CopierNotificationSnapshot,
  type CopierScheduledSlot,
} from '../services/nativeCopierNotificationPlan';

const NOW = 1_000_000_000;
const HOUR = 60 * 60 * 1000;

const snapshot = (partial: Partial<CopierNotificationSnapshot> = {}): CopierNotificationSnapshot => ({
  armed: false,
  shadowMode: false,
  killSwitch: false,
  stuckOutbox: false,
  connected: true,
  reconciliationRequired: false,
  divergentAccounts: [],
  lastError: null,
  armExpiresAt: 0,
  entryCooldownUntil: 0,
  dayLockUntil: 0,
  dayLockReason: null,
  autoClose: null,
  copyEvents: [],
  ...partial,
});

const plan = (
  previous: CopierNotificationSnapshot | null,
  next: CopierNotificationSnapshot | null,
  slots: CopierScheduledSlot[] = [],
) => planCopierNotifications({ previous, next, slots, now: NOW });

describe('plánované sloty', () => {
  it('ostrý ARM naplánuje notifikaci na armExpiresAt', () => {
    const result = plan(null, snapshot({ armed: true, armExpiresAt: NOW + 8 * HOUR }));
    expect(result.schedule).toEqual([expect.objectContaining({
      key: 'arm-expiry', at: NOW + 8 * HOUR, title: 'Copier: ARM vypršel',
    })]);
    expect(result.cancel).toEqual([]);
  });

  it('shadow ARM nic neplánuje', () => {
    const result = plan(null, snapshot({ armed: true, shadowMode: true, armExpiresAt: NOW + 8 * HOUR }));
    expect(result.schedule).toEqual([]);
  });

  it('DISARM zruší naplánovaný slot', () => {
    const result = plan(
      snapshot({ armed: true, armExpiresAt: NOW + 8 * HOUR }),
      snapshot(),
      [{ key: 'arm-expiry', at: NOW + 8 * HOUR, id: 42 }],
    );
    expect(result.cancel).toEqual([42]);
    expect(result.schedule).toEqual([]);
  });

  it('stejný cíl se nepřeplánovává, posunutý ano', () => {
    const same = plan(null, snapshot({ armed: true, armExpiresAt: NOW + 8 * HOUR }),
      [{ key: 'arm-expiry', at: NOW + 8 * HOUR + 5_000, id: 7 }]);
    expect(same.cancel).toEqual([]);
    expect(same.schedule).toEqual([]);

    const moved = plan(null, snapshot({ armed: true, armExpiresAt: NOW + 4 * HOUR }),
      [{ key: 'arm-expiry', at: NOW + 8 * HOUR, id: 7 }]);
    expect(moved.cancel).toEqual([7]);
    expect(moved.schedule).toEqual([expect.objectContaining({ key: 'arm-expiry', at: NOW + 4 * HOUR })]);
  });

  it('cooldown a day-lock dostanou vlastní sloty', () => {
    const result = plan(null, snapshot({
      entryCooldownUntil: NOW + 10 * 60_000,
      dayLockUntil: NOW + 5 * HOUR,
    }));
    expect(result.schedule.map(item => item.key).sort()).toEqual(['cooldown-end', 'daylock-end']);
  });

  it('cíl v minulosti se neplánuje', () => {
    const result = plan(null, snapshot({ armed: true, armExpiresAt: NOW - 1_000 }));
    expect(result.schedule).toEqual([]);
  });
});

describe('okamžité incidenty', () => {
  it('hrana kill switch vystřelí hned; opakovaný stav ne', () => {
    const edge = plan(snapshot(), snapshot({ killSwitch: true }));
    expect(edge.fireNow).toEqual([expect.objectContaining({ title: 'Copier: KILL SWITCH' })]);
    const steady = plan(snapshot({ killSwitch: true }), snapshot({ killSwitch: true }));
    expect(steady.fireNow).toEqual([]);
  });

  it('nová chyba nese její text; kill switch ji nepřekrývá duplicitně', () => {
    const error = plan(snapshot(), snapshot({ lastError: 'Divergence pozic' }));
    expect(error.fireNow).toEqual([expect.objectContaining({ body: 'Divergence pozic' })]);
    const both = plan(snapshot(), snapshot({ killSwitch: true, lastError: 'Ruční stop' }));
    expect(both.fireNow.map(item => item.title)).toEqual(['Copier: KILL SWITCH']);
  });

  it('první sync po startu appky nehlásí staré stavy', () => {
    const result = plan(null, snapshot({ lastError: 'stará chyba', stuckOutbox: true }));
    expect(result.fireNow).toEqual([]);
  });

  it('nový copy event vystřelí hned; známý ani historie po startu ne', () => {
    const event = { id: 'e1', title: 'Copier: vstup zkopírován', body: 'Long 4 MNQU6 → 5 followerů.' };
    const fresh = plan(snapshot(), snapshot({ copyEvents: [event] }));
    expect(fresh.fireNow).toEqual([expect.objectContaining({ title: event.title })]);
    const steady = plan(snapshot({ copyEvents: [event] }), snapshot({ copyEvents: [event] }));
    expect(steady.fireNow).toEqual([]);
    const coldStart = plan(null, snapshot({ copyEvents: [event] }));
    expect(coldStart.fireNow).toEqual([]);
  });

  it('pád i bezpečný návrat spojení hlásí', () => {
    const down = plan(snapshot(), snapshot({ connected: false }));
    expect(down.fireNow).toEqual([expect.objectContaining({ title: 'Copier: Tradovate odpojen' })]);
    const up = plan(snapshot({ connected: false }), snapshot());
    expect(up.fireNow).toEqual([expect.objectContaining({ title: 'Copier: Tradovate připojen' })]);
  });

  it('divergence účtů zamkne ARM a úspěšná reconciliation oznámí obnovu', () => {
    const mismatch = plan(snapshot(), snapshot({
      reconciliationRequired: true,
      divergentAccounts: [11, 12],
    }));
    expect(mismatch.fireNow).toEqual([expect.objectContaining({
      title: 'Copier: ÚČTY NESOUHLASÍ',
      body: expect.stringContaining('2 účtů'),
    })]);
    const fixed = plan(snapshot({
      reconciliationRequired: true,
      divergentAccounts: [11, 12],
    }), snapshot());
    expect(fixed.fireNow).toEqual([expect.objectContaining({ title: 'Copier: účty synchronní' })]);
  });

  it('začátek cooldownu se oznámí okamžitě a konec zůstane naplánovaný', () => {
    const result = plan(snapshot(), snapshot({ entryCooldownUntil: NOW + HOUR }));
    expect(result.fireNow).toEqual([expect.objectContaining({ title: 'Copier: COOLDOWN aktivní' })]);
    expect(result.schedule).toEqual([expect.objectContaining({ key: 'cooldown-end' })]);
  });
});

describe('day-lock a auto-flatten hrany', () => {
  it('nové dayLockUntil vypálí okamžitou zprávu s důvodem a naplánuje konec', () => {
    const next = snapshot({
      dayLockUntil: NOW + 2 * HOUR,
      dayLockReason: 'auto day-lock: 2. ztrátový obchod dne (limit 2)',
    });
    const result = plan(snapshot(), next);
    expect(result.fireNow).toEqual([expect.objectContaining({
      title: 'Copier: DAY-LOCK',
      body: expect.stringContaining('2. ztrátový obchod'),
    })]);
    expect(result.schedule).toEqual([expect.objectContaining({ key: 'daylock-end' })]);

    // Stejný zámek podruhé už nic nepálí.
    const repeat = plan(next, next, [{ key: 'daylock-end', at: NOW + 2 * HOUR, id: 7 }]);
    expect(repeat.fireNow).toHaveLength(0);
    expect(repeat.schedule).toHaveLength(0);
  });

  it('výsledek auto-flatten se hlásí právě jednou per operationId, selhání křičí', () => {
    const success = snapshot({
      autoClose: { operationId: 'arm-expiry:1', trigger: 'arm-expiry' as const, flat: true, canceledOrders: 1, submittedClosures: 2 },
    });
    const first = plan(snapshot(), success);
    expect(first.fireNow).toEqual([expect.objectContaining({
      title: expect.stringContaining('kopie zavřeny'),
    })]);
    expect(plan(success, success).fireNow).toHaveLength(0);

    const failure = snapshot({
      autoClose: {
        operationId: 'arm-expiry:2', trigger: 'arm-expiry' as const, flat: false, canceledOrders: 0, submittedClosures: 0,
        error: 'Flatten close MNQU6 nebyl bezpečně potvrzen',
      },
    });
    const failed = plan(success, failure);
    expect(failed.fireNow).toEqual([expect.objectContaining({
      title: expect.stringContaining('SELHAL'),
      body: expect.stringContaining('Zkontroluj pozice'),
    })]);
  });

  it('první sync bez prev nehlásí historický day-lock ani auto-flatten', () => {
    const next = snapshot({
      dayLockUntil: NOW + HOUR,
      dayLockReason: 'auto day-lock: cokoliv',
      autoClose: { operationId: 'arm-expiry:9', trigger: 'arm-expiry' as const, flat: true, canceledOrders: 0, submittedClosures: 1 },
    });
    expect(plan(null, next).fireNow).toHaveLength(0);
  });
});
