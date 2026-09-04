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
  dayLockTrigger: null,
  ruleWarnings: [],
  resumeOffer: null,
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

  it('nová fail-closed chyba použije lidský důvod a výsledek kopií; kill switch ji neduplikuje', () => {
    const error = plan(snapshot(), snapshot({ lastError: 'Divergence pozic' }));
    expect(error.fireNow).toEqual([expect.objectContaining({ body: 'Divergence pozic' })]);
    const structured = plan(snapshot(), snapshot({
      lastError: 'RAW TECHNICAL DETAIL MUST NOT BE BODY',
      lastDisarm: {
        at: NOW,
        trigger: 'fail-closed',
        code: 'follower-position-mismatch',
        title: 'Pozice followera nesouhlasí s očekávaným násobkem leadera.',
        detail: 'RAW TECHNICAL DETAIL MUST NOT BE BODY',
        copiesOutcome: 'unknown',
        nextStep: 'Spusť Kontrolu pozic.',
      },
    }));
    expect(structured.fireNow).toEqual([expect.objectContaining({
      title: 'Copier: Pozice followera nesouhlasí s očekávaným násobkem leadera',
      body: 'Výsledek kopií se nepodařilo potvrdit. Další krok: Spusť Kontrolu pozic.',
    })]);
    expect(structured.fireNow[0]?.body).not.toContain('RAW TECHNICAL');
    const both = plan(snapshot(), snapshot({ killSwitch: true, lastError: 'Ruční stop' }));
    expect(both.fireNow.map(item => item.title)).toEqual(['Copier: KILL SWITCH']);
  });

  it('první sync po startu appky nehlásí staré stavy', () => {
    const result = plan(null, snapshot({ lastError: 'stará chyba', stuckOutbox: true }));
    expect(result.fireNow).toEqual([]);
  });

  it('nový copy event vystřelí hned; známý ani historie po startu ne', () => {
    const event = {
      id: 'e1', kind: 'order-placed', title: 'Copier: obchod zadán', body: 'Long 4 MNQU6 → 5 followerů.',
    };
    const fresh = plan(snapshot(), snapshot({ copyEvents: [event] }));
    expect(fresh.fireNow).toEqual([expect.objectContaining({ title: event.title })]);
    const steady = plan(snapshot({ copyEvents: [event] }), snapshot({ copyEvents: [event] }));
    expect(steady.fireNow).toEqual([]);
    const coldStart = plan(null, snapshot({ copyEvents: [event] }));
    expect(coldStart.fireNow).toEqual([]);
  });

  it('lokální appka neduplikuje ENTRY/EXIT vlastněný obrázkovým APNs tokem', () => {
    const entry = {
      id: 'entry-1', kind: 'entry', title: 'Copier: vstup zkopírován', body: 'Long 4 MNQU6 → 5 followerů.',
    };
    const exit = {
      id: 'exit-1', kind: 'exit', title: 'Copier: výstup zkopírován', body: 'Long 4 MNQU6 → 5 followerů.',
    };
    expect(plan(snapshot(), snapshot({ copyEvents: [entry, exit] })).fireNow).toEqual([]);
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
      dayLockTrigger: 'losing-trades',
    });
    const result = plan(snapshot(), next);
    expect(result.fireNow).toEqual([expect.objectContaining({
      title: 'Copier: DEN ZAMČENÝ',
      body: expect.stringContaining('Max. ztrátových obchodů'),
      kind: 'daylock-engaged',
    })]);
    expect(result.fireNow[0].body).toContain('do');
    expect(result.fireNow[0].body).not.toMatch(/USD|účet|\$|limit 2/i);
    expect(result.schedule).toEqual([expect.objectContaining({ key: 'daylock-end' })]);

    // Stejný zámek podruhé už nic nepálí.
    const repeat = plan(next, next, [{ key: 'daylock-end', at: NOW + 2 * HOUR, id: 7 }]);
    expect(repeat.fireNow).toHaveLength(0);
    expect(repeat.schedule).toHaveLength(0);
  });

  it('nové varování je tichý rule-warning a stejný durable záznam se neopakuje', () => {
    const warning = { rule: 'max-trades' as const, current: 9, limit: 10, at: NOW };
    const next = snapshot({ ruleWarnings: [warning] });
    expect(plan(snapshot(), next).fireNow).toEqual([{
      title: 'Copier: pravidlo dne',
      body: 'Max. obchodů se blíží limitu.',
      kind: 'rule-warning',
    }]);
    expect(plan(next, next).fireNow).toEqual([]);
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

describe('resume nabídka po výpadku', () => {
  it('vystřelí jednou per `at` a bez prev mlčí', () => {
    const next = snapshot({ resumeOffer: { at: 42 } });
    const first = plan(snapshot(), next);
    expect(first.fireNow).toEqual([expect.objectContaining({
      title: expect.stringContaining('kopie drženy'),
    })]);
    expect(plan(next, next).fireNow).toHaveLength(0);
    expect(plan(null, next).fireNow).toHaveLength(0);
  });
});
