/**
 * Vzdálený watchdog copieru — čistá vyhodnocovací logika.
 *
 * Lokální watchdog (scripts/copier/watchdog.ts) hlásí na obrazovku Macu,
 * tedy stroje, který právě umřel. Tahle vrstva běží v serverovém cronu,
 * čte heartbeat workera ze Supabase a rozhoduje, co poslat na telefon.
 *
 * Záměrně NIC neposílá ani nezapisuje — vrací akce. Side effects dělá
 * cron; díky tomu jde celé chování pokrýt deterministickými testy.
 *
 * Deduplikace: incident se hlásí JEDNOU při vzniku a jednou při zotavení.
 * Cron běží každou minutu — bez dedupe by „worker offline" znamenal
 * 60 notifikací za hodinu a uživatel by kanál vypnul. Ohlášený incident
 * drží `active` v copier_alert_state, dokud podmínka nezmizí.
 */

export interface CopierRuntimeRow {
  device_id: string;
  user_id: string;
  /** Controller status JSON hlášený workerem (armed, killSwitch, lastError…). */
  status: Record<string, unknown>;
  last_seen_at: string;
  started_at: string;
}

export interface CopierAlertStateRow {
  device_id: string;
  user_id: string;
  incident_key: string;
  active: boolean;
  detail?: string | null;
}

export interface IncidentNotification {
  userId: string;
  deviceId: string;
  incidentKey: string;
  kind: 'opened' | 'resolved';
  title: string;
  body: string;
}

export interface AlertStateUpsert {
  userId: string;
  deviceId: string;
  incidentKey: string;
  active: boolean;
  detail: string | null;
  /** Pravda, když upsert doprovází notifikace (nastaví notified_at). */
  notified: boolean;
}

export interface WatchdogEvaluation {
  notifications: IncidentNotification[];
  upserts: AlertStateUpsert[];
}

/**
 * Heartbeat starší než tohle = worker je pro nás mrtvý. Worker zapisuje
 * stav průběžně (relay ho považuje za živý do 10 s); 90 s snese výpadek
 * jednoho cron ticku i krátký síťový zákmit bez falešného poplachu.
 */
export const DEFAULT_STALE_AFTER_MS = 90_000;

/** Po startu workera chvíli nehlásíme "broker odpojen" — sync teprve běží. */
const BOOT_GRACE_MS = 120_000;

/** Interní marker pro detekci hrany armed -> disarmed; nikdy nenotifikuje. */
const ARMED_MARKER_KEY = 'state:armed';

interface IncidentSpec {
  key: string;
  /** Vyhodnocuje se jen na živém heartbeatu. */
  present: (status: Record<string, unknown>, uptimeMs: number) => boolean;
  detail: (status: Record<string, unknown>) => string | null;
  openTitle: string;
  openBody: (detail: string | null) => string;
  resolvedTitle: string;
  resolvedBody: string;
}

const asBool = (value: unknown): boolean => value === true;
const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

const INCIDENTS: IncidentSpec[] = [
  {
    key: 'kill-switch',
    present: status => asBool(status.killSwitch),
    detail: status => asText(status.lastError),
    openTitle: 'Copier: KILL SWITCH',
    openBody: detail => detail
      ? `Kill switch je aktivní: ${detail}`
      : 'Kill switch je aktivní. Runtime se sám znovu nespustí.',
    resolvedTitle: 'Copier: kill switch zrušen',
    resolvedBody: 'Runtime běží bez kill switche (nový start).',
  },
  {
    key: 'fail-closed',
    present: status => asText(status.lastError) != null && !asBool(status.killSwitch),
    detail: status => asText(status.lastError),
    openTitle: 'Copier: FAIL-CLOSED',
    openBody: detail => detail ?? 'Runtime se bezpečně zastavil kvůli chybě.',
    resolvedTitle: 'Copier: chyba odezněla',
    resolvedBody: 'Runtime už nehlásí chybu.',
  },
  {
    key: 'stuck-outbox',
    present: status => asBool(status.stuckOutbox),
    detail: () => 'Nevyřešená objednávka čeká na ruční kontrolu.',
    openTitle: 'Copier: STUCK OUTBOX',
    openBody: () => 'Objednávka s nejasným výsledkem čeká na ruční kontrolu. ARM je blokovaný.',
    resolvedTitle: 'Copier: outbox čistý',
    resolvedBody: 'Nejasné objednávky jsou vyřešené.',
  },
  {
    key: 'broker-disconnected',
    present: (status, uptimeMs) => uptimeMs > BOOT_GRACE_MS && status.connected === false,
    detail: () => null,
    openTitle: 'Copier: Tradovate odpojen',
    openBody: () => 'Worker běží, ale spojení k Tradovate je dole. Kopírování stojí.',
    resolvedTitle: 'Copier: Tradovate připojen',
    resolvedBody: 'Spojení k brokerovi je obnovené.',
  },
];

export function evaluateCopierIncidents(options: {
  runtimes: readonly CopierRuntimeRow[];
  alertStates: readonly CopierAlertStateRow[];
  now: number;
  staleAfterMs?: number;
}): WatchdogEvaluation {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const notifications: IncidentNotification[] = [];
  const upserts: AlertStateUpsert[] = [];
  const stateFor = new Map(options.alertStates.map(row => [
    `${row.user_id}:${row.device_id}:${row.incident_key}`,
    row,
  ]));
  const activeState = (userId: string, deviceId: string, key: string) =>
    stateFor.get(`${userId}:${deviceId}:${key}`);

  for (const runtime of options.runtimes) {
    const { user_id: userId, device_id: deviceId } = runtime;
    const lastSeen = Date.parse(runtime.last_seen_at);
    const uptimeMs = options.now - Date.parse(runtime.started_at);
    const offline = !Number.isFinite(lastSeen) || options.now - lastSeen > staleAfterMs;
    const status = runtime.status ?? {};

    const open = (key: string, detail: string | null, title: string, body: string) => {
      notifications.push({ userId, deviceId, incidentKey: key, kind: 'opened', title, body });
      upserts.push({ userId, deviceId, incidentKey: key, active: true, detail, notified: true });
    };
    const resolve = (key: string, title: string, body: string) => {
      notifications.push({ userId, deviceId, incidentKey: key, kind: 'resolved', title, body });
      upserts.push({ userId, deviceId, incidentKey: key, active: false, detail: null, notified: true });
    };

    // --- Offline je nadřazený všem ostatním incidentům -------------------
    const offlineState = activeState(userId, deviceId, 'worker-offline');
    if (offline) {
      if (!offlineState?.active) {
        const minutes = Number.isFinite(lastSeen)
          ? Math.max(1, Math.round((options.now - lastSeen) / 60_000))
          : null;
        open(
          'worker-offline',
          null,
          'Copier: WORKER OFFLINE',
          minutes
            ? `Mac worker se neozval ${minutes} min. Kopírování neběží; SL/TP u brokera zůstávají.`
            : 'Mac worker se neozývá. Kopírování neběží; SL/TP u brokera zůstávají.',
        );
      }
      // Ostatní incidenty NEřešíme ani neresolvujeme — bez heartbeatu
      // nevíme nic; zotavení se vyhodnotí, až se worker ozve.
      continue;
    }
    if (offlineState?.active) {
      resolve(
        'worker-offline',
        'Copier: worker zpět online',
        'Mac worker se znovu ozývá. Před ARM proběhne reconciliation.',
      );
    }

    // --- Stavové incidenty na živém heartbeatu ---------------------------
    for (const spec of INCIDENTS) {
      const present = spec.present(status, uptimeMs);
      const state = activeState(userId, deviceId, spec.key);
      if (present && !state?.active) {
        const detail = spec.detail(status);
        open(spec.key, detail, spec.openTitle, spec.openBody(detail));
      } else if (!present && state?.active) {
        resolve(spec.key, spec.resolvedTitle, spec.resolvedBody);
      }
    }

    // --- Hrana armed -> disarmed (jednorázová zpráva, žádné recovery) ----
    // Zajímá nás jen ostrý ARM: shadow nic neposílá, o ten uživatel nepřijde.
    const liveArmed = asBool(status.armed) && status.shadowMode !== true;
    const marker = activeState(userId, deviceId, ARMED_MARKER_KEY);
    if (marker?.active === true && !liveArmed) {
      // Důvod už možná ohlásil konkrétní incident; obecná zpráva kryje
      // tichý konec (expirace TTL, ruční DISARM z jiného zařízení).
      const reason = asText(status.lastError);
      if (!reason && !asBool(status.killSwitch)) {
        notifications.push({
          userId, deviceId, incidentKey: 'arm-ended', kind: 'opened',
          title: 'Copier: ARM skončil',
          body: 'Ostrý ARM už neplatí (expirace nebo ruční DISARM). Kopírování stojí.',
        });
        upserts.push({
          userId, deviceId, incidentKey: 'arm-ended', active: false, detail: null, notified: true,
        });
      }
    }
    if (marker?.active !== liveArmed) {
      upserts.push({
        userId, deviceId, incidentKey: ARMED_MARKER_KEY,
        active: liveArmed, detail: null, notified: false,
      });
    }
  }

  return { notifications, upserts };
}
