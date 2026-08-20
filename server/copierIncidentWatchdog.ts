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

/** Marker: `detail` nese poslední ohlášené `dayLockUntil` (auto i ruční lock). */
const DAY_LOCK_MARKER_KEY = 'state:day-lock';

/** Marker: `detail` nese poslední ohlášené `entryCooldownUntil`. */
const COOLDOWN_MARKER_KEY = 'state:cooldown';

/** Marker: `detail` nese `operationId` posledního ohlášeného auto-flatten. */
const AUTO_CLOSE_MARKER_KEY = 'state:auto-close';

/** Interní marker: `detail` nese `at` posledního odeslaného copy eventu. */
export const COPY_EVENTS_MARKER_KEY = 'state:copy-events';

export interface CopierCopyEventRow {
  id: string;
  at: number;
  kind: 'entry' | 'scale-in' | 'scale-out' | 'exit' | 'flip';
  symbol: string;
  side: 'Long' | 'Short';
  quantity: number;
  followers: number;
}

const COPY_KIND_TITLE: Record<CopierCopyEventRow['kind'], string> = {
  entry: 'Copier: vstup zkopírován',
  'scale-in': 'Copier: pozice navýšena',
  'scale-out': 'Copier: částečný výstup',
  exit: 'Copier: výstup zkopírován',
  flip: 'Copier: pozice otočena',
};

export function copyEventNotification(event: CopierCopyEventRow): { title: string; body: string } {
  return {
    title: COPY_KIND_TITLE[event.kind],
    body: `${event.side} ${event.quantity} ${event.symbol} → ${event.followers} follower${event.followers === 1 ? '' : 'ů'}.`,
  };
}

/**
 * Trade notifikace (vstupy/exity) — vedle incidentů, ale se stejnou kázní:
 * každý event právě jednou. Worker drží ring buffer jen v paměti procesu,
 * takže po jeho restartu začíná deník znovu — marker proto nese časovou
 * hranici, ne id, a starší eventy se po restartu nikdy nepošlou dvakrát.
 */
export function planCopyEventNotifications(options: {
  runtimes: readonly CopierRuntimeRow[];
  alertStates: readonly CopierAlertStateRow[];
  now: number;
  staleAfterMs?: number;
}): { notifications: Array<{
  userId: string;
  deviceId: string;
  eventId: string;
  kind: CopierCopyEventRow['kind'];
  at: number;
  title: string;
  body: string;
}>; markers: AlertStateUpsert[] } {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const notifications: Array<{
    userId: string;
    deviceId: string;
    eventId: string;
    kind: CopierCopyEventRow['kind'];
    at: number;
    title: string;
    body: string;
  }> = [];
  const markers: AlertStateUpsert[] = [];
  const markerFor = new Map(options.alertStates
    .filter(row => row.incident_key === COPY_EVENTS_MARKER_KEY)
    .map(row => [`${row.user_id}:${row.device_id}`, row]));

  for (const runtime of options.runtimes) {
    const lastSeen = Date.parse(runtime.last_seen_at);
    if (!Number.isFinite(lastSeen) || options.now - lastSeen > staleAfterMs) continue;
    const status = controllerStatus(runtime.status ?? {});
    const events = Array.isArray(status.recentCopyEvents)
      ? (status.recentCopyEvents as CopierCopyEventRow[])
      : [];
    if (events.length === 0) continue;

    const marker = markerFor.get(`${runtime.user_id}:${runtime.device_id}`);
    // Bez markeru (první běh) nehlásíme historii — jen posuneme hranici,
    // stejné pravidlo jako u incidentů: start nesmí přehrát minulost.
    const lastNotifiedAt = marker ? Number(marker.detail ?? 0) : Number.POSITIVE_INFINITY;
    const fresh = Number.isFinite(lastNotifiedAt)
      ? events.filter(event => Number.isFinite(event?.at) && event.at > lastNotifiedAt)
      : [];
    for (const event of fresh) {
      const content = copyEventNotification(event);
      notifications.push({
        userId: runtime.user_id,
        deviceId: runtime.device_id,
        eventId: event.id,
        kind: event.kind,
        at: event.at,
        ...content,
      });
    }
    const maxAt = Math.max(...events.map(event => (Number.isFinite(event?.at) ? event.at : 0)));
    const nextBoundary = marker ? Math.max(Number(marker.detail ?? 0), maxAt) : maxAt;
    if (!marker || fresh.length > 0 || Number(marker.detail ?? 0) !== nextBoundary) {
      markers.push({
        userId: runtime.user_id,
        deviceId: runtime.device_id,
        incidentKey: COPY_EVENTS_MARKER_KEY,
        active: false,
        detail: String(nextBoundary),
        notified: fresh.length > 0,
      });
    }
  }
  return { notifications, markers };
}

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
const asNumber = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/**
 * Relay heartbeat ukládá celý LocalCopierAgentStatus, kde je skutečný stav
 * controlleru pod `status.controller`. Starší snapshoty mohou mít controller
 * fields přímo v `status`, proto podporujeme oba formáty.
 */
const controllerStatus = (status: Record<string, unknown>): Record<string, unknown> => {
  const nested = status.controller;
  return nested && typeof nested === 'object' && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : status;
};

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
    // Samotný lastError nestačí — přechodná transportní chyba, ze které se
    // runtime zotavil a dál běží ARMED, není incident. Skutečný fail-closed
    // = chyba, která runtime nechala odzbrojený.
    present: status => asText(status.lastError) != null
      && !asBool(status.killSwitch)
      && !asBool(status.armed),
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
    key: 'position-divergence',
    present: status => Array.isArray(status.divergentAccounts) && status.divergentAccounts.length > 0,
    detail: status => Array.isArray(status.divergentAccounts)
      ? String(status.divergentAccounts.length)
      : null,
    openTitle: 'Copier: ÚČTY NESOUHLASÍ',
    openBody: detail => `${detail ?? 'Několik'} účtů má rozdílnou pozici. ARM je zamčený do úspěšné reconciliation.`,
    resolvedTitle: 'Copier: účty synchronní',
    resolvedBody: 'Reconciliation potvrdila shodné pozice. Případný nový ARM zůstává ruční.',
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
    const status = controllerStatus(runtime.status ?? {});

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

    // --- Day-lock (auto i ruční): jednorázová zpráva per dayLockUntil ----
    const dayLockUntil = asNumber(status.dayLockUntil);
    const dayLockMarker = activeState(userId, deviceId, DAY_LOCK_MARKER_KEY);
    if (dayLockUntil > options.now && dayLockMarker?.detail !== String(dayLockUntil)) {
      const reason = asText(status.dayLockReason);
      notifications.push({
        userId, deviceId, incidentKey: 'day-lock', kind: 'opened',
        title: 'Copier: DAY-LOCK',
        body: reason
          ? `${reason}. ARM je blokovaný do konce broker session.`
          : 'Denní zámek je aktivní. ARM je blokovaný do konce broker session.',
      });
      upserts.push({
        userId, deviceId, incidentKey: DAY_LOCK_MARKER_KEY,
        active: false, detail: String(dayLockUntil), notified: true,
      });
    }

    // --- Anti-revenge cooldown: vznik i konec právě jednou ----------------
    const cooldownUntil = asNumber(status.entryCooldownUntil);
    const cooldownMarker = activeState(userId, deviceId, COOLDOWN_MARKER_KEY);
    if (cooldownUntil > options.now && cooldownMarker?.detail !== String(cooldownUntil)) {
      notifications.push({
        userId, deviceId, incidentKey: 'cooldown', kind: 'opened',
        title: 'Copier: COOLDOWN aktivní',
        body: 'Po potvrzeném zploštění je nový vstup dočasně blokovaný.',
      });
      upserts.push({
        userId, deviceId, incidentKey: COOLDOWN_MARKER_KEY,
        active: true, detail: String(cooldownUntil), notified: true,
      });
    } else if (cooldownUntil <= options.now && cooldownMarker?.active) {
      notifications.push({
        userId, deviceId, incidentKey: 'cooldown-ended', kind: 'resolved',
        title: 'Copier: cooldown skončil',
        body: 'Anti-revenge cooldown doběhl. Nový ARM zůstává ruční.',
      });
      upserts.push({
        userId, deviceId, incidentKey: COOLDOWN_MARKER_KEY,
        active: false, detail: cooldownMarker.detail ?? null, notified: true,
      });
    }

    // --- Auto-flatten (expirace ARM / fail-closed): jednou per operationId
    const close = status.autoClose as {
      operationId?: unknown; trigger?: unknown; flat?: unknown;
      canceledOrders?: unknown; submittedClosures?: unknown; error?: unknown;
    } | null | undefined;
    const closeOperationId = asText(close?.operationId);
    const closeMarker = activeState(userId, deviceId, AUTO_CLOSE_MARKER_KEY);
    if (closeOperationId && closeMarker?.detail !== closeOperationId) {
      const failed = close?.flat !== true || asText(close?.error) != null;
      const cause = close?.trigger === 'fail-closed' ? 'FAIL-CLOSED' : 'ARM vypršel';
      notifications.push({
        userId, deviceId, incidentKey: 'auto-close', kind: 'opened',
        title: failed
          ? `Copier: ${cause}, auto-zavření kopií SELHALO`
          : `Copier: ${cause} — kopie zavřeny`,
        body: failed
          ? `${asText(close?.error) ?? 'Účty nejsou potvrzené flat.'} Zkontroluj pozice v Tradovate!`
          : `Auto-flatten hotový: zrušeno ${asNumber(close?.canceledOrders)} příkazů, zavřeno ${asNumber(close?.submittedClosures)} pozic. Vše flat.`,
      });
      upserts.push({
        userId, deviceId, incidentKey: AUTO_CLOSE_MARKER_KEY,
        active: false, detail: closeOperationId, notified: true,
      });
    }

    // --- Hrany DISARMED <-> ARMED (jednorázově, bez replaye při bootstrapu)
    // Zajímá nás jen ostrý ARM: shadow nic neposílá, o ten uživatel nepřijde.
    const liveArmed = asBool(status.armed) && status.shadowMode !== true;
    const marker = activeState(userId, deviceId, ARMED_MARKER_KEY);
    if (marker && marker.active === false && liveArmed) {
      notifications.push({
        userId, deviceId, incidentKey: 'arm-started', kind: 'opened',
        title: 'Copier: ARM aktivní',
        body: 'Ostrý ARM je aktivní. Kopírování je povolené do expirace session nebo ručního DISARM.',
      });
    }
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
        userId, deviceId, incidentKey: ARMED_MARKER_KEY, active: liveArmed,
        detail: null, notified: Boolean(marker && marker.active === false && liveArmed),
      });
    }
  }

  return { notifications, upserts };
}
