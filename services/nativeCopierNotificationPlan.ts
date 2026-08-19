/**
 * Deterministické copier notifikace pro nativní appku — čisté plánování.
 *
 * Free Apple ID neumí APNs, takže server nemůže probudit zavřenou Capacitor
 * appku. Co ale jde: události se ZNÁMÝM časem (konec ARM, konec cooldownu,
 * konec day-locku) naplánovat dopředu jako lokální notifikace — doručí je
 * pak samotný iOS i při zavřené appce. Nepředvídatelné incidenty se hlásí
 * okamžitě, dokud appka běží; se zavřenou appkou je kryje PWA watchdog.
 *
 * Tenhle modul NIC neplánuje — vrací akce. Side effects dělá exekutor,
 * takže celé chování jde pokrýt deterministickými testy.
 */

export interface CopierNotificationSnapshot {
  armed: boolean;
  shadowMode: boolean;
  killSwitch: boolean;
  stuckOutbox: boolean;
  connected: boolean;
  lastError: string | null;
  armExpiresAt: number;
  entryCooldownUntil: number;
  dayLockUntil: number;
  /** Vstupy/exity leadera z runtime deníku (id, popisek). */
  copyEvents: Array<{ id: string; title: string; body: string }>;
}

export type CopierSlotKey = 'arm-expiry' | 'cooldown-end' | 'daylock-end';

export interface CopierScheduledSlot {
  key: CopierSlotKey;
  /** Epoch ms, na který je notifikace naplánovaná. */
  at: number;
  /** iOS notification id — potřeba ke zrušení. */
  id: number;
}

export interface CopierPlannedNotification {
  key: CopierSlotKey;
  at: number;
  title: string;
  body: string;
}

export interface CopierImmediateNotification {
  title: string;
  body: string;
}

export interface CopierNotificationPlan {
  /** iOS id ke zrušení (slot zanikl nebo se přeplánovává). */
  cancel: number[];
  /** Nové plánované sloty. */
  schedule: CopierPlannedNotification[];
  /** Okamžité incident hlášky (jen na hraně prev -> next). */
  fireNow: CopierImmediateNotification[];
}

/** Posun cíle menší než tohle nepřeplánovává — šetří iOS notification API. */
const RESCHEDULE_TOLERANCE_MS = 60_000;

/** Cíl v minulosti nebo příliš blízko nemá smysl plánovat. */
const MIN_LEAD_MS = 15_000;

const SLOT_CONTENT: Record<CopierSlotKey, { title: string; body: string }> = {
  'arm-expiry': {
    title: 'Copier: ARM vypršel',
    body: 'Ostrý ARM právě skončil (konec broker session). Kopírování stojí; nový ARM je ruční.',
  },
  'cooldown-end': {
    title: 'Copier: cooldown skončil',
    body: 'Anti-revenge cooldown doběhl. ARM je zase možný — rozhodni s chladnou hlavou.',
  },
  'daylock-end': {
    title: 'Copier: denní zámek skončil',
    body: 'Day-lock doběhl s koncem broker session. Nový ARM je zase možný.',
  },
};

function desiredSlotTimes(
  snapshot: CopierNotificationSnapshot | null,
  now: number,
): Map<CopierSlotKey, number> {
  const desired = new Map<CopierSlotKey, number>();
  if (!snapshot) return desired;
  if (snapshot.armed && !snapshot.shadowMode && snapshot.armExpiresAt > now + MIN_LEAD_MS) {
    desired.set('arm-expiry', snapshot.armExpiresAt);
  }
  if (snapshot.entryCooldownUntil > now + MIN_LEAD_MS) {
    desired.set('cooldown-end', snapshot.entryCooldownUntil);
  }
  if (snapshot.dayLockUntil > now + MIN_LEAD_MS) {
    desired.set('daylock-end', snapshot.dayLockUntil);
  }
  return desired;
}

export function planCopierNotifications(options: {
  previous: CopierNotificationSnapshot | null;
  next: CopierNotificationSnapshot | null;
  slots: readonly CopierScheduledSlot[];
  now: number;
}): CopierNotificationPlan {
  const { previous, next, slots, now } = options;
  const cancel: number[] = [];
  const schedule: CopierPlannedNotification[] = [];
  const fireNow: CopierImmediateNotification[] = [];

  // --- Plánované sloty: srovnat existující stav s žádaným -----------------
  const desired = desiredSlotTimes(next, now);
  for (const slot of slots) {
    const target = desired.get(slot.key);
    if (target == null) {
      // Slot už není žádaný (DISARM zrušil ARM, cooldown zrušen…).
      // Prošlé sloty (at < now) iOS už doručil — rušit je je neškodné.
      cancel.push(slot.id);
    } else if (Math.abs(target - slot.at) > RESCHEDULE_TOLERANCE_MS) {
      cancel.push(slot.id);
      schedule.push({ key: slot.key, at: target, ...SLOT_CONTENT[slot.key] });
    }
    desired.delete(slot.key);
  }
  for (const [key, at] of desired) {
    schedule.push({ key, at, ...SLOT_CONTENT[key] });
  }

  // --- Okamžité incidenty: jen skutečné hrany prev -> next ----------------
  // Bez prev (první sync po startu appky) nehlásíme nic — stavy mohly
  // vzniknout dávno a PWA watchdog je už ohlásil.
  if (previous && next) {
    if (!previous.killSwitch && next.killSwitch) {
      fireNow.push({
        title: 'Copier: KILL SWITCH',
        body: 'Kill switch je aktivní. Runtime se sám znovu nespustí.',
      });
    }
    if (previous.lastError == null && next.lastError != null && !next.killSwitch) {
      fireNow.push({
        title: 'Copier: bezpečné zastavení',
        body: next.lastError,
      });
    }
    if (!previous.stuckOutbox && next.stuckOutbox) {
      fireNow.push({
        title: 'Copier: STUCK OUTBOX',
        body: 'Objednávka s nejasným výsledkem čeká na ruční kontrolu. ARM je blokovaný.',
      });
    }
    if (previous.connected && !next.connected) {
      fireNow.push({
        title: 'Copier: Tradovate odpojen',
        body: 'Spojení k brokerovi spadlo. Kopírování stojí; SL/TP u brokera zůstávají.',
      });
    }
    // Trade potvrzení: jen eventy, které v předchozím snapshotu nebyly.
    // První sync (bez prev) historii nepřehrává — stejné pravidlo jako výše.
    const known = new Set(previous.copyEvents.map(event => event.id));
    for (const event of next.copyEvents) {
      if (!known.has(event.id)) fireNow.push({ title: event.title, body: event.body });
    }
  }

  return { cancel, schedule, fireNow };
}
