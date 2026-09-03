/**
 * Deterministické copier notifikace pro nativní appku — čisté plánování.
 *
 * Události se ZNÁMÝM časem (konec ARM, konec cooldownu, konec day-locku)
 * plánujeme jako lokální fallback přímo v iOS. Nepředvídatelné incidenty
 * plán hlásí okamžitě při živém pollu; serverová APNs cesta kryje zavřenou
 * aplikaci. Obě větve sdílejí stejné hrany a nesmějí vykonat broker akci.
 *
 * Tenhle modul NIC neplánuje — vrací akce. Side effects dělá exekutor,
 * takže celé chování jde pokrýt deterministickými testy.
 */

import {
  copierCopiesOutcomeText,
  type CopierDisarmRecord,
} from '../lib/copierDisarmReason';
import { COPIER_LEADER_DAILY_STATS_LABEL } from '../lib/copierDailyStatsLabels';

export interface CopierNotificationSnapshot {
  armed: boolean;
  shadowMode: boolean;
  killSwitch: boolean;
  stuckOutbox: boolean;
  connected: boolean;
  reconciliationRequired: boolean;
  divergentAccounts: number[];
  lastError: string | null;
  lastDisarm?: CopierDisarmRecord;
  armExpiresAt: number;
  entryCooldownUntil: number;
  dayLockUntil: number;
  dayLockReason: string | null;
  /** Connection recovery: kopie drženy, čeká se na ruční ARM. */
  resumeOffer: { at: number } | null;
  /** Výsledek posledního auto-flatten (expirace ARM / fail-closed). */
  autoClose: {
    operationId: string;
    trigger: 'arm-expiry' | 'fail-closed' | 'reconnect';
    flat: boolean;
    canceledOrders: number;
    submittedClosures: number;
    error?: string;
  } | null;
  /** Vstupy/exity leadera z runtime deníku (id, popisek). */
  copyEvents: Array<{
    id: string;
    kind: string;
    title: string;
    body: string;
  }>;
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
  kind: 'trade' | 'risk';
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
        kind: 'risk',
      });
    }
    if (previous.lastError == null && next.lastError != null && !next.killSwitch) {
      const disarm = next.lastDisarm;
      fireNow.push({
        title: disarm
          ? `Copier: ${disarm.title.replace(/[.!?]$/, '')}`
          : 'Copier: bezpečné zastavení',
        body: disarm
          ? `${copierCopiesOutcomeText(disarm.copiesOutcome)} Další krok: ${disarm.nextStep}`
          : next.lastError,
        kind: 'risk',
      });
    }
    if (!previous.stuckOutbox && next.stuckOutbox) {
      fireNow.push({
        title: 'Copier: STUCK OUTBOX',
        body: 'Objednávka s nejasným výsledkem čeká na ruční kontrolu. ARM je blokovaný.',
        kind: 'risk',
      });
    }
    if (previous.stuckOutbox && !next.stuckOutbox) {
      fireNow.push({
        title: 'Copier: outbox vyřešen',
        body: 'Nejasné objednávky už neblokují kontrolu účtů. Před ARM proběhne reconciliation.',
        kind: 'risk',
      });
    }
    if (previous.connected && !next.connected) {
      fireNow.push({
        title: 'Copier: Tradovate odpojen',
        body: 'Spojení k brokerovi spadlo. Kopírování stojí; SL/TP u brokera zůstávají.',
        kind: 'risk',
      });
    }
    if (!previous.connected && next.connected) {
      fireNow.push({
        title: 'Copier: Tradovate připojen',
        body: 'Broker spojení je obnovené. Ostrý ARM se sám nezapnul.',
        kind: 'risk',
      });
    }
    const previousDivergence = previous.divergentAccounts.join(',');
    const nextDivergence = next.divergentAccounts.join(',');
    if (next.divergentAccounts.length > 0 && nextDivergence !== previousDivergence) {
      fireNow.push({
        title: 'Copier: ÚČTY NESOUHLASÍ',
        body: `${next.divergentAccounts.length} účt${next.divergentAccounts.length === 1 ? 'u' : 'ů'} má rozdílnou pozici. ARM je zamčený do úspěšné reconciliation.`,
        kind: 'risk',
      });
    } else if (previous.divergentAccounts.length > 0
      && next.divergentAccounts.length === 0
      && !next.reconciliationRequired) {
      fireNow.push({
        title: 'Copier: účty synchronní',
        body: 'Reconciliation potvrdila shodné pozice. Případný nový ARM zůstává ruční.',
        kind: 'risk',
      });
    }
    if (next.entryCooldownUntil > now && previous.entryCooldownUntil !== next.entryCooldownUntil) {
      fireNow.push({
        title: 'Copier: COOLDOWN aktivní',
        body: `Po potvrzeném zploštění je nový vstup blokovaný do ${new Date(next.entryCooldownUntil).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' })}.`,
        kind: 'risk',
      });
    }
    // Auto day-lock: hlásí se nová hodnota dayLockUntil, která je v budoucnu.
    if (next.dayLockUntil > now && previous.dayLockUntil !== next.dayLockUntil) {
      fireNow.push({
        title: 'Copier: DAY-LOCK',
        body: next.dayLockReason
          ? `${next.dayLockReason}. ${COPIER_LEADER_DAILY_STATS_LABEL}. ARM je blokovaný do konce broker session.`
          : 'Denní zámek je aktivní. ARM je blokovaný do konce broker session.',
        kind: 'risk',
      });
    }
    // Resume nabídka po výpadku — jednou per `at`.
    if (next.resumeOffer && next.resumeOffer.at !== previous.resumeOffer?.at) {
      fireNow.push({
        title: 'Copier: výpadek skončil — kopie drženy',
        body: 'Účty jsou synchronní s leaderem a kopie chrání brackety. Klikni ARM pro pokračování kopírování.',
        kind: 'risk',
      });
    }
    // Výsledek auto-flatten (expirace ARM / fail-closed) — jednou per operationId.
    if (next.autoClose
      && next.autoClose.operationId !== previous.autoClose?.operationId) {
      const close = next.autoClose;
      const cause = close.trigger === 'fail-closed'
        ? 'FAIL-CLOSED'
        : close.trigger === 'reconnect' ? 'osiřelé kopie po výpadku' : 'ARM vypršel';
      fireNow.push(close.flat && !close.error
        ? {
          title: `Copier: ${cause} — kopie zavřeny`,
          body: `Auto-flatten hotový: zrušeno ${close.canceledOrders} příkazů, zavřeno ${close.submittedClosures} pozic. Vše flat.`,
          kind: 'risk',
        }
        : {
          title: `Copier: ${cause}, auto-zavření kopií SELHALO`,
          body: `${close.error ?? 'Účty nejsou potvrzené flat.'} Zkontroluj pozice v Tradovate!`,
          kind: 'risk',
        });
    }
    // Trade potvrzení: jen eventy, které v předchozím snapshotu nebyly.
    // První sync (bez prev) historii nepřehrává — stejné pravidlo jako výše.
    const known = new Set(previous.copyEvents.map(event => event.id));
    for (const event of next.copyEvents) {
      // ENTRY/EXIT vlastní serverová APNs větev: buď jediný push s obrázkem,
      // nebo po krátkém grace textový fallback. Lokální kopie by ji duplikovala.
      if ((event.kind === 'entry' || event.kind === 'exit') || known.has(event.id)) continue;
      fireNow.push({ title: event.title, body: event.body, kind: 'trade' });
    }
  }

  return { cancel, schedule, fireNow };
}
