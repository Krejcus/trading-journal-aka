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

import { COPIER_LEADER_DAILY_STATS_LABEL } from '../lib/copierDailyStatsLabels.js';
import { copierArmNotification } from './copierArmNotification.js';

export interface CopierRuntimeRow {
  device_id: string;
  user_id: string;
  /** Controller status JSON hlášený workerem (armed, killSwitch, lastError…). */
  status: Record<string, unknown>;
  last_seen_at: string;
  started_at: string;
}

/** Řádek relay fronty (`tradovate_copier_commands`), jen pro čtení. */
export interface CopierRelayCommandRow {
  id: string;
  device_id: string;
  user_id: string;
  command_type: string;
  status: string;
  created_at: string;
  claimed_at: string | null;
  error?: string | null;
}

/** Přečtená relay fronta pro zaseknuté příkazy. */
export interface CopierRelayQueueSnapshot {
  /**
   * `pending` a `claimed` starší než 30 s pro zařízení s čerstvým heartbeatem;
   * `claimed` jen v2 (s `delivery_id`) převzaté za posledních 24 h.
   */
  open: readonly CopierRelayCommandRow[];
  /** Řádky id z aktivních výstrah `relay-stuck`, v libovolném stavu. */
  reported: readonly CopierRelayCommandRow[];
  /** Kdy začalo čtení fronty — stáří příkazů se měří k tomuto času. */
  readAt: number;
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

/**
 * Zaseknutá fronta relaye (29. 10. 2026). Heartbeat workeru běží nezávisle
 * na delivery smyčce, takže věčně padající poll/ACK (409 po restartu, 400,
 * 413, osiřelá delivery) LIVE nevidí. Hlídáme ji jen u workeru s čerstvým
 * heartbeatem — výpadek celého workeru je `worker-offline`.
 */
export const RELAY_STUCK_HEARTBEAT_FRESH_MS = 30_000;
export const RELAY_STUCK_BRAKE_AFTER_MS = 30_000;
export const RELAY_STUCK_COMMAND_AFTER_MS = 60_000;
/** Flatten skupiny trval 17. 9. 265 s; legitimně dlouhé příkazy mají vlastní limit. */
export const RELAY_STUCK_LONG_COMMAND_AFTER_MS = 300_000;
/** Relay startuje až po setupu workeru, `started_at` předbíhá první poll. */
export const RELAY_STUCK_PENDING_BOOT_GRACE_MS = 120_000;
/** Starší `claimed` (osiřelé delivery) se nehlídají; ohlášený se uzavře poctivě. */
export const RELAY_STUCK_CLAIMED_WINDOW_MS = 24 * 60 * 60_000;
const RELAY_STUCK_KEY = 'relay-stuck';
const RELAY_STUCK_DETAIL_MAX_IDS = 20;
const RELAY_BRAKE_TYPES = new Set(['disarm', 'kill-switch', 'lock-until-session-end']);
const RELAY_LONG_COMMAND_TYPES = new Set(['copy-command', 'activate-group', 'verify-account-eligibility']);
const RELAY_BRAKE_LABEL: Record<string, string> = {
  disarm: 'DISARM', 'kill-switch': 'Kill switch', 'lock-until-session-end': 'Zámek dne',
};
const RELAY_OPEN_STATUSES = new Set(['pending', 'claimed']);
const RELAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Interní marker pro detekci hrany armed -> disarmed; nikdy nenotifikuje. */
const ARMED_MARKER_KEY = 'state:armed';

/** Marker: `detail` nese poslední ohlášené `dayLockUntil` (auto i ruční lock). */
const DAY_LOCK_MARKER_KEY = 'state:day-lock';

/** Marker: `detail` nese poslední ohlášené `entryCooldownUntil`. */
const COOLDOWN_MARKER_KEY = 'state:cooldown';

/** Marker: `detail` nese `operationId` posledního ohlášeného auto-flatten. */
const AUTO_CLOSE_MARKER_KEY = 'state:auto-close';

/** Marker: `detail` nese `at` poslední ohlášené resume nabídky. */
const RESUME_OFFER_MARKER_KEY = 'state:resume-offer';

/** Výsledek automatického pokračování po výpadku: `${disarmAt}:${phase}`. */
const AUTO_RESUME_MARKER_KEY = 'state:auto-resume';

/** Interní marker: `detail` nese `at` posledního odeslaného copy eventu. */
export const COPY_EVENTS_MARKER_KEY = 'state:copy-events';

/** Per-účtový incident „mimo synchron“ (etapa 2): `account-sync:<accountId>`. */
const ACCOUNT_SYNC_KEY_PREFIX = 'account-sync:';
const czechAccounts = (count: number) => `${count} ${count >= 2 && count <= 4 ? 'účty' : 'účtů'}`;

/**
 * ENTRY/EXIT dostane krátké okno pro jediný push už s obrázkem. Po vypršení
 * okna stejný planner pošle textovou zálohu; obchodní cesta na nic nečeká.
 */
export const COPY_EVENT_IMAGE_GRACE_MS = 1_800;

/**
 * Do kdy po události má ještě smysl doručit obrázek. Původní 1,5 s (obrázek
 * „v první notifikaci“) nestačilo ani na capture, natož na upload 1–2 MB PNG:
 * 3.–4. 9. 2026 skončil každý snímek `copier-relay-request-timeout` a journal
 * i notifikace zůstaly bez grafu. Textová notifikace odchází po
 * `COPY_EVENT_IMAGE_GRACE_MS`; obrázek ji díky stejnému `collapseId` nahradí.
 */
export const COPY_EVENT_IMAGE_PUSH_DEADLINE_MS = 45_000;

/** První čerstvý event po založení markeru není historie k replayi. */
const COPY_EVENT_FIRST_RUN_WINDOW_MS = 5_000;

export interface CopierCopyEventRow {
  id: string;
  at: number;
  kind: 'entry' | 'scale-in' | 'scale-out' | 'exit' | 'flip'
    | 'order-placed' | 'bracket-placed' | 'order-canceled' | 'order-moved'
    | 'sl-moved' | 'tp-moved' | 'follower-cut';
  symbol: string;
  side: 'Long' | 'Short';
  quantity: number;
  followers: number;
  episodeId?: string;
  price?: number;
  stopPrice?: number;
  targetPrice?: number;
  exitReason?: 'sl' | 'tp' | 'manual';
  pnlUsd?: number;
  levelPnlUsd?: number;
  stopPnlUsd?: number;
  targetPnlUsd?: number;
  accountId?: number;
  cutUsd?: number;
  realizedPnlUsd?: number;
  source?: 'broker' | 'ledger' | 'manual' | 'prop-reserve';
  closed?: number | null | false;
}

const COPY_KIND_TITLE: Record<CopierCopyEventRow['kind'], string> = {
  entry: 'Copier: vstup zkopírován',
  'scale-in': 'Copier: pozice navýšena',
  'scale-out': 'Copier: částečný výstup',
  exit: 'Copier: výstup zkopírován',
  flip: 'Copier: pozice otočena',
  'order-placed': 'Copier: obchod zadán',
  'bracket-placed': 'Copier: SL/TP nastaveny',
  'order-canceled': 'Copier: objednávka zrušena',
  'order-moved': 'Copier: objednávka posunuta',
  'sl-moved': 'Copier: SL posunut',
  'tp-moved': 'Copier: TP posunut',
  'follower-cut': 'Copier: účet vyřazen',
};

const formatUsd = (value: number): string =>
  `${value >= 0 ? '+' : '−'}${Math.abs(Math.round(value))} USD`;

/** Potenciální P&L úrovně v závorce; přesná nula = break-even. */
const formatPotential = (value: number | undefined): string => {
  if (value == null || !Number.isFinite(value)) return '';
  // BE jen pro skutečnou nulu — zaokrouhlená −0.5 USD není break-even.
  if (value === 0) return ' (BE)';
  return ` (${formatUsd(value)})`;
};

export function copyEventNotification(event: CopierCopyEventRow): { title: string; body: string } {
  if (event.kind === 'follower-cut') {
    const account = event.accountId != null ? ` ${event.accountId}` : '';
    if (event.source === 'manual') {
      return {
        title: `Copier: účet${account} ručně zavřen`,
        body: event.closed === false
          ? 'Účet zůstává mimo aktuální obchod; jeho kopii se nepodařilo potvrzeně zavřít.'
          : 'Účet čeká na další obchod; ostatní účty pokračují.',
      };
    }
    const loss = event.realizedPnlUsd != null ? formatUsd(event.realizedPnlUsd) : 'neověřeno';
    const limit = event.cutUsd != null ? `${event.cutUsd} USD` : 'neověřen';
    return {
      title: `Copier: účet${account} vyřazen`,
      body: `Ztráta ${loss}, limit ${limit}${event.closed === false ? ' · kopii se nepodařilo zavřít' : ''}.`,
    };
  }
  // Exit s atribucí: SL/TP hit má vlastní titulek, P&L jde do těla.
  const title = event.kind === 'exit' || event.kind === 'flip'
    ? event.exitReason === 'sl'
      ? `Copier: SL HIT${event.pnlUsd != null ? ` ${formatUsd(event.pnlUsd)}` : ''}`
      : event.exitReason === 'tp'
        ? `Copier: TP HIT${event.pnlUsd != null ? ` ${formatUsd(event.pnlUsd)}` : ''}`
        : COPY_KIND_TITLE[event.kind]
    : COPY_KIND_TITLE[event.kind] ?? 'Copier: obchodní událost';
  const parts = [`${event.side} ${event.quantity} ${event.symbol}`];
  if (event.price != null) parts.push(`@ ${event.price}${formatPotential(event.levelPnlUsd)}`);
  if (event.stopPrice != null) parts.push(`SL ${event.stopPrice}${formatPotential(event.stopPnlUsd)}`);
  if (event.targetPrice != null) parts.push(`TP ${event.targetPrice}${formatPotential(event.targetPnlUsd)}`);
  if ((event.kind === 'exit' || event.kind === 'flip') && event.pnlUsd != null) {
    parts.push(`P&L ${formatUsd(event.pnlUsd)} · ${COPIER_LEADER_DAILY_STATS_LABEL}`);
  }
  return {
    title,
    body: `${parts.join(' · ')} → ${event.followers} follower${event.followers === 1 ? '' : 'ů'}.`,
  };
}

/** Deterministická korelace textového a pozdějšího obrázkového push payloadu. */
export function copierSnapshotCollapseId(input: {
  episodeId: string;
  kind: string;
  at: number;
}): string {
  const second = Math.floor(input.at / 1_000);
  const episode = input.episodeId.toLowerCase().replace(/-/g, '').replace(/[^a-z0-9]/g, '').slice(0, 32);
  const kind = input.kind.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 12);
  return `cpimg-${episode}-${kind}-${second}`.slice(0, 64);
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
  replayBoundary?: boolean;
}): { notifications: Array<{
  userId: string;
  deviceId: string;
  eventId: string;
  kind: CopierCopyEventRow['kind'];
  at: number;
  title: string;
  body: string;
  episodeId?: string;
  collapseId?: string;
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
    episodeId?: string;
    collapseId?: string;
  }> = [];
  const markers: AlertStateUpsert[] = [];
  const markerFor = new Map(options.alertStates
    .filter(row => row.incident_key === COPY_EVENTS_MARKER_KEY)
    .map(row => [`${row.user_id}:${row.device_id}`, row]));

  for (const runtime of options.runtimes) {
    const lastSeen = Date.parse(runtime.last_seen_at);
    if (!Number.isFinite(lastSeen) || options.now - lastSeen > staleAfterMs) continue;
    const status = controllerStatus(runtime.status ?? {});
    const snapshotHealth = runtime.status?.snapshotHealth;
    const imagePipelineEnabled = Boolean(
      snapshotHealth && typeof snapshotHealth === 'object' && !Array.isArray(snapshotHealth)
      && (snapshotHealth as { enabled?: unknown }).enabled === true,
    );
    const events = Array.isArray(status.recentCopyEvents)
      ? (status.recentCopyEvents as CopierCopyEventRow[])
      : [];
    if (events.length === 0) continue;

    const chronological = events
      .filter(event => Number.isFinite(event?.at))
      .sort((left, right) => left.at - right.at);
    if (chronological.length === 0) continue;

    const marker = markerFor.get(`${runtime.user_id}:${runtime.device_id}`);
    const storedBoundary = marker ? Number(marker.detail ?? 0) : 0;
    let nextBoundary = Number.isFinite(storedBoundary) ? storedBoundary : 0;
    if (!marker) {
      // Starou historii při prvním serverovém průchodu přeskočíme, ale event,
      // který právě vyvolal worker nudge, nesmíme zahodit jen proto, že marker
      // ještě neexistoval.
      nextBoundary = chronological
        .filter(event => event.at <= options.now - COPY_EVENT_FIRST_RUN_WINDOW_MS)
        .reduce((latest, event) => Math.max(latest, event.at), 0);
    }
    // Durable callers can rediscover equal timestamps: the outbox deduplicates
    // existing IDs, while a later heartbeat can add another event in that ms.
    // Keep the first-run historical baseline silent.
    const fresh = chronological.filter(event => event.at > nextBoundary || (
      options.replayBoundary && marker && !marker.active && event.at === nextBoundary
    ));
    const notificationStart = notifications.length;
    for (const event of fresh) {
      const waitsForImage = imagePipelineEnabled && Boolean(event.episodeId)
        && (event.kind === 'entry' || event.kind === 'exit')
        && options.now < event.at + COPY_EVENT_IMAGE_GRACE_MS;
      // Nepřeskakujeme přes čekající ENTRY/EXIT. Marker je jediná časová
      // hranice, takže pozdější event smí ven až spolu s ním nebo po něm.
      if (waitsForImage) break;
      const content = copyEventNotification(event);
      notifications.push({
        userId: runtime.user_id,
        deviceId: runtime.device_id,
        eventId: event.id,
        kind: event.kind,
        at: event.at,
        ...(event.episodeId ? {
          episodeId: event.episodeId,
          collapseId: copierSnapshotCollapseId({
            episodeId: event.episodeId,
            kind: event.kind,
            at: event.at,
          }),
        } : {}),
        ...content,
      });
      nextBoundary = Math.max(nextBoundary, event.at);
    }
    // Pokud na prvním průchodu nebyl žádný čerstvý event, pouze založíme
    // baseline na konci historie. U čekajícího obrázku zůstane před ním.
    if (!marker && fresh.length === 0) nextBoundary = chronological.at(-1)?.at ?? nextBoundary;
    const markerMoved = nextBoundary !== (Number.isFinite(storedBoundary) ? storedBoundary : 0);
    if (!marker || markerMoved) {
      markers.push({
        userId: runtime.user_id,
        deviceId: runtime.device_id,
        incidentKey: COPY_EVENTS_MARKER_KEY,
        // Only this copy cursor uses active to denote a silent historical
        // bootstrap. Once newer events are durably enqueued it becomes false.
        active: !marker && fresh.length === 0,
        detail: String(nextBoundary),
        notified: notifications.length > notificationStart,
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
    openBody: () => 'Spojení k Tradovate vypadlo, kopírování stojí. Kopie mají u brokera své SL/TP; po obnovení si kopírka stav ověří sama.',
    resolvedTitle: 'Copier: Tradovate připojen',
    resolvedBody: 'Spojení k brokerovi je obnovené.',
  },
];

const isRelayBrake = (command: Pick<CopierRelayCommandRow, 'command_type'>) => RELAY_BRAKE_TYPES.has(command.command_type);

/** Stáří zaseknutého příkazu; null = (zatím) nezaseknutý. */
const relayCommandStuckAge = (
  command: CopierRelayCommandRow,
  workerStartedAt: number,
  readAt: number,
): number | null => {
  if (command.status === 'claimed') {
    const claimedAt = Date.parse(command.claimed_at ?? '');
    // Claimed bez času převzetí nemá vzniknout; jde jen o výstrahu, proto hlasitě.
    if (!Number.isFinite(claimedAt)) return Number.POSITIVE_INFINITY;
    const limit = isRelayBrake(command)
      ? RELAY_STUCK_BRAKE_AFTER_MS
      : RELAY_LONG_COMMAND_TYPES.has(command.command_type) ? RELAY_STUCK_LONG_COMMAND_AFTER_MS : RELAY_STUCK_COMMAND_AFTER_MS;
    return readAt - claimedAt > limit ? readAt - claimedAt : null;
  }
  if (command.status !== 'pending') return null;
  // Čerstvě nastartovaný worker ještě nemusel stihnout první poll.
  if (!Number.isFinite(workerStartedAt) || readAt - workerStartedAt <= RELAY_STUCK_PENDING_BOOT_GRACE_MS) return null;
  const createdAt = Date.parse(command.created_at);
  if (!Number.isFinite(createdAt)) return Number.POSITIVE_INFINITY;
  const limit = isRelayBrake(command) ? RELAY_STUCK_BRAKE_AFTER_MS : RELAY_STUCK_COMMAND_AFTER_MS;
  return readAt - createdAt > limit ? readAt - createdAt : null;
};

/** `b` = brzda ohlášená poplachem, `w` = brzda ohlášená jako čekající za během, `c` = ostatní. */
interface RelayStuckEntry { id: string; kind: 'b' | 'w' | 'c' }
const isBrakeEntry = (entry: RelayStuckEntry) => entry.kind !== 'c';

/** `detail` = `b:<id>` / `w:<id>` (brzdy) / `c:<id>`, brzdy první. */
const parseRelayStuckDetail = (detail: string | null | undefined): RelayStuckEntry[] =>
  (detail ?? '').split(',').flatMap(item => {
    const [kind, id] = item.split(':');
    return (kind === 'b' || kind === 'w' || kind === 'c') && id && RELAY_ID.test(id) ? [{ id, kind }] : [];
  });

const formatRelayStuckDetail = (entries: readonly RelayStuckEntry[]): string =>
  entries.map(entry => `${entry.kind}:${entry.id}`).join(',');

/** Ohlášená id z aktivních výstrah — cron podle nich čte koncový stav. */
export function reportedRelayCommandIds(alertStates: readonly CopierAlertStateRow[]): string[] {
  return [...new Set(alertStates
    .filter(row => row.incident_key === RELAY_STUCK_KEY && row.active)
    .flatMap(row => parseRelayStuckDetail(row.detail).map(entry => entry.id)))];
}

const relaySeconds = (age: number) => Number.isFinite(age) ? `${Math.round(age / 1_000)} s` : 'neznámo jak dlouho';

const relayStuckNotification = (
  stuck: ReadonlyArray<{ command: CopierRelayCommandRow; age: number }>,
  rows: readonly CopierRelayCommandRow[],
  readAt: number,
) => {
  const brake = stuck.find(item => isRelayBrake(item.command));
  if (brake) {
    const label = RELAY_BRAKE_LABEL[brake.command.command_type] ?? brake.command.command_type;
    if (brake.command.status === 'claimed') {
      return {
        hardBrake: true,
        title: 'Copier: BRZDA NEPOTVRZENA',
        body: `${label}: worker brzdu převzal před ${relaySeconds(brake.age)} a nepotvrdil ji, přestože žije. Brzda možná neproběhla — ověř stav v Tradovate a v nouzi zavři pozice tam.`,
      };
    }
    // Relay je sekvenční: brzda za legitimně běžícím příkazem (Flatten až
    // 5 min) čeká. Výzva k ručnímu zavírání by tu mohla zdvojit exit.
    const running = rows.find(row => row.status === 'claimed' && !isRelayBrake(row)
      && !stuck.some(item => item.command.id === row.id));
    if (running) {
      const runningSince = Date.parse(running.claimed_at ?? '');
      return {
        hardBrake: false,
        title: 'Copier: brzda čeká ve frontě',
        body: `${label} čeká ${relaySeconds(brake.age)} za běžícím příkazem ${running.command_type} (převzat před ${relaySeconds(readAt - runningSince)}). Worker by ji měl provést, až ten příkaz doběhne; ruční zásah v Tradovate teď může s ním kolidovat. Pokud se zasekne, přijde poplach.`,
      };
    }
    return {
      hardBrake: true,
      title: 'Copier: BRZDA NEPOTVRZENA',
      body: `${label} čeká ve frontě ${relaySeconds(brake.age)} a worker si ji nevyzvedl, přestože žije. Brzda možná neproběhla — ověř stav v Tradovate a v nouzi zavři pozice tam.`,
    };
  }
  const oldest = stuck.reduce((left, right) => right.age > left.age ? right : left);
  const type = oldest.command.command_type;
  return {
    hardBrake: false,
    title: 'Copier: relay příkaz visí',
    body: oldest.command.status === 'claimed'
      ? `Worker převzal příkaz ${type} před ${relaySeconds(oldest.age)} a výsledek nepotvrdil. Pokud ho stále provádí, další příkazy včetně OFF čekají za ním.`
      : `Příkaz ${type} čeká ve frontě ${relaySeconds(oldest.age)} a worker si ho nevyzvedl, přestože žije. OFF může čekat také.`,
  };
};

/** Převzatý řádek mimo hlídané 24h okno (osiřelá delivery). */
const relayRowAbandoned = (row: CopierRelayCommandRow, readAt: number): boolean => {
  // Jen claimed: pending se čte bez okna a hlídá dál jako zaseknutý.
  if (row.status !== 'claimed') return false;
  const since = Date.parse(row.claimed_at ?? row.created_at);
  return Number.isFinite(since) && readAt - since > RELAY_STUCK_CLAIMED_WINDOW_MS;
};

/**
 * Konec ohlášené brzdy hned, ne až po vyprázdnění fronty: selhaná nebo
 * osiřelá brzda je poplach (kopírka mohla zůstat zapnutá), nikdy
 * „fronta průchozí“. null = brzda ještě neskončila nebo nevíme.
 */
const relayBrakeEnd = (
  row: CopierRelayCommandRow | undefined,
  readAt: number,
): { failed: false } | { failed: true; title: string; body: string } | null => {
  if (!row) return null;
  const label = RELAY_BRAKE_LABEL[row.command_type] ?? row.command_type;
  if (relayRowAbandoned(row, readAt)) {
    return { failed: true, title: 'Copier: BRZDA BEZ VÝSLEDKU',
      body: `${label} visí přes 24 h bez potvrzení a přestala se hlídat. Kopírka může být stále zapnutá — zkontroluj LIVE a pozice v Tradovate.` };
  }
  if (RELAY_OPEN_STATUSES.has(row.status)) return null;
  if (row.status === 'succeeded') return { failed: false };
  return { failed: true, title: 'Copier: BRZDA NEPROVEDENA',
    body: `${label} skončila bez potvrzeného provedení (${asText(row.error) ?? row.status}). Kopírka může být stále zapnutá — zkontroluj LIVE a pozice v Tradovate.` };
};

/**
 * Uzavření jen se známým koncem všech zbylých ohlášených příkazů; null =
 * nevíme, výstraha zůstane. Nejistý obchodní příkaz (Flatten) je poplach.
 */
const relayStuckOutcome = (
  entries: readonly RelayStuckEntry[],
  reported: readonly CopierRelayCommandRow[],
  readAt: number,
): { title: string; body: string; alarm: boolean } | null => {
  let abandoned = false;
  let uncertain: CopierRelayCommandRow | null = null;
  for (const entry of entries) {
    const row = reported.find(item => item.id === entry.id);
    if (!row) return null;
    if (relayRowAbandoned(row, readAt)) abandoned = true;
    else if (RELAY_OPEN_STATUSES.has(row.status)) return null;
    else if (row.status !== 'succeeded' && (!uncertain || row.command_type === 'copy-command')) uncertain = row;
  }
  if (uncertain?.command_type === 'copy-command') {
    return { alarm: true, title: 'Copier: výsledek příkazu nejistý',
      body: `Ve frontě už nic nevisí, ale copy-command skončil bez potvrzeného výsledku (${asText(uncertain.error) ?? uncertain.status}). Ověř pozice v LIVE.` };
  }
  if (abandoned) {
    return { alarm: false, title: 'Copier: relay výstraha uzavřena bez výsledku',
      body: 'Příkaz visí přes 24 h bez potvrzení a přestal se hlídat. Zkontroluj frontu ručně.' };
  }
  return uncertain
    ? { alarm: false, title: 'Copier: relay fronta průchozí', body: 'Ve frontě už nic nevisí. Některé zaseknuté příkazy vypršely nebo skončily chybou — výsledek ověř v LIVE.' }
    : { alarm: false, title: 'Copier: relay fronta průchozí', body: 'Zaseknuté příkazy worker dokončil.' };
};

const MANUAL_ENTRY_NOTIFY_WINDOW_MS = 10 * 60_000;

/** Výsledky ručních vstupů ze statusu workeru, o kterých má přijít push (čistá funkce). */
export function manualEntryNotifications(
  entries: unknown,
  now: number,
): Array<{ key: string; detail: string; title: string; body: string; problem: boolean }> {
  if (!Array.isArray(entries)) return [];
  const out: Array<{ key: string; detail: string; title: string; body: string; problem: boolean }> = [];
  for (const raw of entries.slice(-10)) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const operationId = asText(entry.operationId);
    const status = asText(entry.status);
    const updatedAt = typeof entry.updatedAt === 'number' ? entry.updatedAt : NaN;
    if (!operationId || !status || !Number.isFinite(updatedAt) || now - updatedAt > MANUAL_ENTRY_NOTIFY_WINDOW_MS) continue;
    const what = `${entry.side === 'Sell' ? 'SELL' : 'BUY'} ${typeof entry.quantity === 'number' ? entry.quantity : '?'} ${asText(entry.symbol) ?? ''}`.trim();
    const reason = asText(entry.reason);
    // Rozběhnuté zrušení (`sending`) se nehlásí — až jeho výsledek (sent/failed).
    const cancel = asText(entry.cancel);
    if (cancel === 'sending') continue;
    const cancelText = cancel === 'failed'
      ? ' Zrušení vstupu na leaderovi SELHALO — zkontroluj leadera v Tradovate.'
      : cancel === 'sent' ? ' Vstup na leaderovi je zrušený.' : '';
    const message = status === 'acknowledged'
      ? (cancel ? { title: cancel === 'failed' ? 'Ruční vstup: zrušení selhalo' : 'Ruční vstup zrušen', body: `${what}: followeři vstup nedostali.${cancelText}`, problem: true }
        : { title: 'Ruční vstup přijat', body: `${what} je u brokera; kopie followerům řídí kopírka.`, problem: false })
      : status === 'rejected' ? { title: 'Ruční vstup odmítnut', body: `${what}: ${reason ?? 'broker vstup odmítl'}.`, problem: true }
        : status === 'unknown' ? { title: 'Ruční vstup: výsledek neznámý', body: `${what}: zkontroluj leadera v Tradovate a v LIVE ho vyřeš.${cancelText}`, problem: true }
          : status === 'abandoned' ? { title: 'Ruční vstup bez ochrany', body: `${what}: broker vrátil vstup bez SL/TP, kopírka je vypnutá.${cancelText || ' Vstup se ruší.'}`, problem: true }
            : null;
    if (!message) continue;
    out.push({ key: `manual-entry:${operationId}`, detail: `${status}${cancel ? `:${cancel}` : ''}`, ...message });
  }
  return out;
}

const MANAGE_ACTION_LABEL: Record<string, string> = { 'move-stop': 'Posun SL', 'move-target': 'Posun TP', 'cancel-entry': 'Zrušení vstupu' };

/** Problémové výsledky správy ručního vstupu (fáze 2a): push jen při odmítnutí / neznámém výsledku. */
export function manualOrderActionNotifications(
  actions: unknown,
  now: number,
): Array<{ key: string; detail: string; title: string; body: string }> {
  if (!Array.isArray(actions)) return [];
  const out: Array<{ key: string; detail: string; title: string; body: string }> = [];
  for (const raw of actions.slice(-10)) {
    const action = (raw ?? {}) as Record<string, unknown>;
    const operationId = asText(action.operationId);
    const status = asText(action.status);
    const updatedAt = typeof action.updatedAt === 'number' ? action.updatedAt : NaN;
    if (!operationId || (status !== 'rejected' && status !== 'unknown')) continue;
    if (!Number.isFinite(updatedAt) || now - updatedAt > MANUAL_ENTRY_NOTIFY_WINDOW_MS) continue;
    const label = MANAGE_ACTION_LABEL[asText(action.action) ?? ''] ?? 'Změna vstupu';
    const reason = asText(action.reason);
    out.push(status === 'rejected'
      ? { key: `manual-order:${operationId}`, detail: status, title: `${label} odmítnut`, body: `${reason ?? 'Broker změnu odmítl'}.${asText(action.action) === 'cancel-entry' ? ' Vstup dál čeká — zkontroluj ho v Tradovate.' : ' Leader i followeři mají původní cenu.'}` }
      : { key: `manual-order:${operationId}`, detail: status, title: `${label}: výsledek neznámý`, body: 'Zkontroluj leadera v Tradovate; kopírka se po výpadku sama nezapne, dokud se to nevyřeší.' });
  }
  return out;
}

export function evaluateCopierIncidents(options: {
  runtimes: readonly CopierRuntimeRow[];
  alertStates: readonly CopierAlertStateRow[];
  now: number;
  staleAfterMs?: number;
  /**
   * Relay fronta. `undefined` = nepřečtena nebo neúplná: `relay-stuck` se
   * pak neotevírá ani neuzavírá (neznámé není zdravé).
   */
  relayQueue?: CopierRelayQueueSnapshot;
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

    // --- Zaseknutá fronta relaye: heartbeat žije, příkaz ne --------------
    // Jen výstraha (INV-WATCH-01): fronta se nečte zpět do execution,
    // nic se neexpiruje ani neopakuje. Mezi 30 a 90 s stáří heartbeatu
    // nevíme dost — výstraha zůstane, jak je.
    const relayQueue = options.relayQueue;
    if (relayQueue && relayQueue.readAt - lastSeen <= RELAY_STUCK_HEARTBEAT_FRESH_MS) {
      const workerStartedAt = Date.parse(runtime.started_at);
      const rows = relayQueue.open.filter(command => command.device_id === deviceId && command.user_id === userId);
      const stuck = rows
        .map(command => ({ command, age: relayCommandStuckAge(command, workerStartedAt, relayQueue.readAt) }))
        .filter((item): item is { command: CopierRelayCommandRow; age: number } => item.age != null);
      const state = activeState(userId, deviceId, RELAY_STUCK_KEY);
      const reportedAll = state?.active ? parseRelayStuckDetail(state.detail) : [];
      // Skončené ohlášené brzdy: selhaná/osiřelá = okamžitý poplach (klíč s id
      // příkazu, takže právě jednou), úspěšná se tiše vyřadí — další
      // zaseknutá brzda pak znovu eskaluje.
      const endedBrakes = new Set<string>();
      let brakeAlarm = false;
      for (const entry of reportedAll.filter(isBrakeEntry)) {
        const end = relayBrakeEnd(relayQueue.reported.find(row => row.id === entry.id), relayQueue.readAt);
        if (!end) continue;
        endedBrakes.add(entry.id);
        if (end.failed) {
          brakeAlarm = true;
          notifications.push({ userId, deviceId, incidentKey: `relay-brake-failed:${entry.id}`, kind: 'opened', title: end.title, body: end.body });
        }
      }
      const reported = reportedAll.filter(entry => !endedBrakes.has(entry.id));
      const prunedDetail = formatRelayStuckDetail(reported);
      if (stuck.length > 0) {
        // Ohlášená id zůstávají do uzavření (jejich konec určí text), nová se
        // přidají; brzdy první, aby je strop nikdy neodřízl.
        const content = relayStuckNotification(stuck, rows, relayQueue.readAt);
        const stuckBrake = stuck.some(item => isRelayBrake(item.command));
        // Push při vzniku; u brzdy, když žádná ohlášená brzda nevisí, nebo
        // když dřív měkce ohlášená (`w`) přestala mít před sebou běžící
        // příkaz. Další kliky OFF už ne.
        const escalate = !state?.active || (stuckBrake && !reported.some(entry => entry.kind === 'b')
          && (!reported.some(entry => entry.kind === 'w') || content.hardBrake));
        const brakeKind: 'b' | 'w' = escalate ? (content.hardBrake ? 'b' : 'w') : 'w';
        // Ukončené brzdy se nevracejí (jinak by se poplach opakoval každý
        // tick); po poplachu se měkké `w` povýší na `b`.
        const fresh = [...stuck]
          .sort((left, right) => left.command.created_at.localeCompare(right.command.created_at))
          .map(item => ({ id: item.command.id, kind: isRelayBrake(item.command) ? brakeKind : 'c' as const }))
          .filter(entry => RELAY_ID.test(entry.id) && !endedBrakes.has(entry.id) && !reported.some(known => known.id === entry.id));
        const merged = [...reported, ...fresh]
          .map(entry => escalate && content.hardBrake && entry.kind === 'w' ? { ...entry, kind: 'b' as const } : entry);
        const detail = formatRelayStuckDetail([
          ...merged.filter(isBrakeEntry), ...merged.filter(entry => !isBrakeEntry(entry)),
        ].slice(0, RELAY_STUCK_DETAIL_MAX_IDS));
        if (escalate) {
          open(RELAY_STUCK_KEY, detail, content.title, content.body);
        } else if (state?.detail !== detail) {
          upserts.push({ userId, deviceId, incidentKey: RELAY_STUCK_KEY, active: true, detail, notified: brakeAlarm });
        }
      } else if (state?.active) {
        // Uzavírá se, až ve frontě nevisí nic staršího než 30 s (ani pending
        // v boot grace po restartu) a konec ohlášených příkazů je známý.
        const outcome = rows.length === 0 ? relayStuckOutcome(reported, relayQueue.reported, relayQueue.readAt) : null;
        if (outcome && brakeAlarm && !outcome.alarm) {
          // Poplach o brzdě už odešel; „fronta průchozí“ by ho přebil.
          upserts.push({ userId, deviceId, incidentKey: RELAY_STUCK_KEY, active: false, detail: null, notified: true });
        } else if (outcome?.alarm) {
          // Výstraha končí, ale zpráva je poplach (badge), ne „vyřešeno“.
          notifications.push({ userId, deviceId, incidentKey: RELAY_STUCK_KEY, kind: 'opened', title: outcome.title, body: outcome.body });
          upserts.push({ userId, deviceId, incidentKey: RELAY_STUCK_KEY, active: false, detail: null, notified: true });
        } else if (outcome) {
          resolve(RELAY_STUCK_KEY, outcome.title, outcome.body);
        } else if (state.detail !== prunedDetail) {
          upserts.push({ userId, deviceId, incidentKey: RELAY_STUCK_KEY, active: true, detail: prunedDetail, notified: brakeAlarm });
        }
      }
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

    // --- Účet mimo synchron (etapa 2): per účet otevření i návrat ---------
    // Pauza = follower vynechá zbytek leader obchodu; ostatní kopírují dál.
    // Obojí hlásíme jen při zapnuté kopírce: durable pauza přežije DISARM
    // i restart a „ostatní kopírují dál / zase kopíruje“ by pak byla nepravda.
    // Starší worker pole neposílá — bez něj nevíme nic, nic se neřeší.
    if (Array.isArray(status.accountSyncPauses)) {
      const syncArmed = asBool(status.armed) && status.shadowMode !== true;
      const syncPauses = new Map<number, { reasonCode: string; pausedAt: number; symbols: string[] }>();
      for (const item of status.accountSyncPauses) {
        const pause = item as { accountId?: unknown; symbol?: unknown; reasonCode?: unknown; pausedAt?: unknown };
        if (typeof pause.accountId !== 'number' || !Number.isSafeInteger(pause.accountId)) continue;
        const pausedAt = asNumber(pause.pausedAt);
        const current = syncPauses.get(pause.accountId);
        const symbol = asText(pause.symbol);
        // Víc symbolů jednoho účtu: nejstarší pauza určuje marker, aby
        // přeřazení pole neposlalo zprávu znovu.
        if (!current || pausedAt < current.pausedAt) {
          syncPauses.set(pause.accountId, { reasonCode: String(pause.reasonCode ?? ''), pausedAt, symbols: [...(current?.symbols ?? []), ...(symbol ? [symbol] : [])] });
        } else if (symbol) current.symbols.push(symbol);
      }
      const opened: Array<{ key: string; accountId: number; pause: { reasonCode: string; pausedAt: number; symbols: string[] } }> = [];
      if (syncArmed) {
        for (const [accountId, pause] of syncPauses) {
          const key = `${ACCOUNT_SYNC_KEY_PREFIX}${accountId}`;
          const state = activeState(userId, deviceId, key);
          if (state?.active && state.detail === String(pause.pausedAt)) continue;
          opened.push({ key, accountId, pause });
        }
      }
      const returned: Array<{ key: string; accountId: number }> = [];
      for (const row of options.alertStates) {
        if (row.user_id !== userId || row.device_id !== deviceId || !row.active
          || !row.incident_key.startsWith(ACCOUNT_SYNC_KEY_PREFIX)) continue;
        const accountId = Number(row.incident_key.slice(ACCOUNT_SYNC_KEY_PREFIX.length));
        if (Number.isSafeInteger(accountId) && syncPauses.has(accountId)) continue;
        if (syncArmed && Number.isSafeInteger(accountId)) returned.push({ key: row.incident_key, accountId });
        else upserts.push({ userId, deviceId, incidentKey: row.incident_key, active: false, detail: null, notified: false });
      }
      // Jedna zpráva za tick: při hromadném odmítnutí nepřijde N pushů.
      for (const item of opened) {
        upserts.push({ userId, deviceId, incidentKey: item.key, active: true, detail: String(item.pause.pausedAt), notified: true });
      }
      if (opened.length === 1) {
        const [{ key, accountId, pause }] = opened;
        const symbols = pause.symbols.length > 0 ? ` (${[...new Set(pause.symbols)].join(', ')})` : '';
        notifications.push({ userId, deviceId, incidentKey: key, kind: 'opened',
          title: `Účet ${accountId} mimo synchron${symbols}`,
          body: `${pause.reasonCode === 'protective-filled-early' ? 'Stop nebo target se vyplnil dřív než u leadera.' : 'Broker odmítl vstup.'} Vynechá zbytek obchodu, ostatní kopírují dál.` });
      } else if (opened.length > 1) {
        notifications.push({ userId, deviceId, incidentKey: opened[0].key, kind: 'opened',
          title: `${czechAccounts(opened.length)} mimo synchron`,
          body: `${opened.map(item => item.accountId).join(', ')} vynechají zbytek obchodu, ostatní kopírují dál.` });
      }
      for (const item of returned) {
        upserts.push({ userId, deviceId, incidentKey: item.key, active: false, detail: null, notified: true });
      }
      if (returned.length === 1) {
        notifications.push({ userId, deviceId, incidentKey: returned[0].key, kind: 'resolved',
          title: `Účet ${returned[0].accountId} zase v synchronu`, body: 'K dalšímu obchodu leadera se připojí automaticky.' });
      } else if (returned.length > 1) {
        notifications.push({ userId, deviceId, incidentKey: returned[0].key, kind: 'resolved',
          title: `${czechAccounts(returned.length)} zase v synchronu`, body: `${returned.map(item => item.accountId).join(', ')} se k dalšímu obchodu leadera připojí automaticky.` });
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
          ? `${reason}. ${COPIER_LEADER_DAILY_STATS_LABEL}. ARM je blokovaný do konce broker session.`
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
      const cause = close?.trigger === 'fail-closed'
        ? 'FAIL-CLOSED'
        : close?.trigger === 'reconnect' ? 'osiřelé kopie po výpadku' : 'ARM vypršel';
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

    // --- Resume nabídka po výpadku: kopie drženy, čeká se na ARM ---------
    const resumeOffer = status.resumeOffer as { at?: unknown } | null | undefined;
    const resumeAt = asNumber(resumeOffer?.at);
    const resumeMarker = activeState(userId, deviceId, RESUME_OFFER_MARKER_KEY);
    if (resumeAt > 0 && resumeMarker?.detail !== String(resumeAt)) {
      notifications.push({
        userId, deviceId, incidentKey: 'resume-offer', kind: 'opened',
        title: 'Copier: výpadek skončil — kopie drženy',
        body: 'Účty jsou synchronní s leaderem a kopie chrání brackety. Klikni ARM pro pokračování kopírování.',
      });
      upserts.push({
        userId, deviceId, incidentKey: RESUME_OFFER_MARKER_KEY,
        active: false, detail: String(resumeAt), notified: true,
      });
    }

    // --- Automatické pokračování po výpadku (10. 10. 2026): výsledek jednou
    // per epizoda. Jen u workeru, který funkci opravdu má zapnutou.
    const capabilities = Array.isArray(runtime.status?.capabilities) ? runtime.status.capabilities as unknown[] : [];
    const resume = status.transportResume as { disarmAt?: unknown; phase?: unknown; reason?: unknown } | null | undefined;
    const resumeDisarmAt = asNumber(resume?.disarmAt);
    const resumeAutoResumed = capabilities.includes('transport-auto-resume-v1')
      && resume?.phase === 'resumed';
    if (capabilities.includes('transport-auto-resume-v1') && resumeDisarmAt > 0
      && (resume?.phase === 'resumed' || resume?.phase === 'declined')) {
      const detail = `${resumeDisarmAt}:${String(resume.phase)}`;
      const resumeMarker = activeState(userId, deviceId, AUTO_RESUME_MARKER_KEY);
      // Vlastní ruční vypnutí není zpráva, jen se zapíše marker.
      const silent = resume.phase === 'declined' && /ručně vypnuta|vypnul kopírku ručně/.test(asText(resume.reason) ?? '');
      if (resumeMarker?.detail !== detail && silent) {
        upserts.push({ userId, deviceId, incidentKey: AUTO_RESUME_MARKER_KEY, active: false, detail, notified: false });
      } else if (resumeMarker?.detail !== detail) {
        notifications.push({
          userId, deviceId, incidentKey: 'auto-resume', kind: 'opened',
          ...(resume.phase === 'resumed'
            ? { title: 'Kopírka pokračuje', body: 'Spojení s brokerem je zpět, účty ověřené flat bez příkazů — kopírování jede dál.' }
            : { title: 'Kopírka po výpadku nepokračuje', body: `${asText(resume.reason) ?? 'Kontrola nevyšla'}. Zapni ji ručně.` }),
        });
        upserts.push({ userId, deviceId, incidentKey: AUTO_RESUME_MARKER_KEY, active: false, detail, notified: true });
      }
    }

    // --- Ruční vstupy z grafu (fáze 1b): jednorázová zpráva o výsledku ---
    // Klíč na operaci, detail = stav; jen záznamy změněné za posledních
    // 10 min (žádný replay starých vstupů po nasazení). Jen výstraha (INV-WATCH-01).
    for (const notification of manualOrderActionNotifications(status.manualOrderActions, options.now)) {
      const state = activeState(userId, deviceId, notification.key);
      if (state?.detail === notification.detail) continue;
      notifications.push({ userId, deviceId, incidentKey: notification.key, kind: 'opened', title: notification.title, body: notification.body });
      upserts.push({ userId, deviceId, incidentKey: notification.key, active: false, detail: notification.detail, notified: true });
    }
    for (const notification of manualEntryNotifications(status.manualEntries, options.now)) {
      const state = activeState(userId, deviceId, notification.key);
      if (state?.detail === notification.detail) continue;
      // Úspěch je jen informace (bez odznaku a riziková kategorie), problém je `opened`.
      notifications.push({ userId, deviceId, incidentKey: notification.key, kind: notification.problem ? 'opened' : 'resolved', title: notification.title, body: notification.body });
      upserts.push({ userId, deviceId, incidentKey: notification.key, active: false, detail: notification.detail, notified: true });
    }

    // --- Hrany DISARMED <-> ARMED (jednorázově, bez replaye při bootstrapu)
    // Zajímá nás jen ostrý ARM: shadow nic neposílá, o ten uživatel nepřijde.
    const liveArmed = asBool(status.armed) && status.shadowMode !== true;
    const marker = activeState(userId, deviceId, ARMED_MARKER_KEY);
    // Automatické pokračování má vlastní zprávu — bez druhého „ARM zapnut“.
    if (marker && marker.active === false && liveArmed && !resumeAutoResumed) {
      // Stejný text jako okamžitý relay push; snapshotHealth leží mimo
      // controller část heartbeatu, proto se bere z celého runtime statusu.
      notifications.push({
        userId, deviceId, incidentKey: 'arm-started', kind: 'opened',
        ...copierArmNotification('arm-started', runtime.status?.snapshotHealth),
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
