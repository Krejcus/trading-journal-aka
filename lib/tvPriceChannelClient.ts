import type { TvPricePayload } from './tvPriceMessage';
import type { TvPriceStore } from './tvPriceStore';

/**
 * Klient kanálu ceny z TradingView (krok 3 návrhu
 * `docs/reviews/tv-price-channel-design-20261026.md`). Jen zobrazení
 * (INV-UI-04, INV-RELAY-04): kanál nenese příkazy ani rozhodovací stav
 * a nic z něj se neukládá.
 *
 * - Téma a klíč bere z odpovědi relaye, kterou LIVE přijal jako status
 *   (`offerGrant`); při lokálním spojení s workerem z GET relaye čteného jen
 *   kvůli grantu (status z něj se nepřijímá). Změna tématu = odhlásit kanál
 *   a vyprázdnit store.
 * - Presence `{ pnl: true }` hlásí jen viditelná appka s připojenou listovou
 *   komponentou otevřeného P&L — bez ní worker nestreamuje vůbec. Při
 *   přechodu appky do pozadí se odhlásí hned (iOS JS brzy uspí).
 * - Ověření má strop času a frontu každého kanálu zvlášť: visící ověření
 *   nezablokuje nové téma.
 * - Zprávy se ověřují **postupně** (WebCrypto je asynchronní; pořadí `seq`
 *   se hodnotí až po ověření), neplatný podpis se zahodí.
 * - Nic tady nevyhodí výjimku ven: chyba kanálu = „stojí“, zobrazí se kotva.
 */

export interface TvPriceGrant {
  topic: string;
  key: string;
}

const TOPIC = /^tv-price-[A-Za-z0-9_-]{22}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;

export const isTvPriceGrant = (value: unknown): value is TvPriceGrant => {
  const row = value as Partial<TvPriceGrant> | null;
  return !!row && typeof row === 'object' && typeof row.topic === 'string' && TOPIC.test(row.topic)
    && typeof row.key === 'string' && KEY.test(row.key);
};

export type TvPriceChannelStatus = 'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED';

/** Tenká obálka Realtime kanálu (v aplikaci supabase-js, v testech falešná). */
export interface TvPriceChannelHandle {
  track(meta: { pnl: boolean; chart: boolean }): Promise<unknown>;
  untrack(): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface TvPriceChannelClientDeps {
  store: TvPriceStore;
  openChannel(topic: string, handlers: {
    onMessage(envelope: unknown): void;
    onStatus(status: TvPriceChannelStatus): void;
  }): TvPriceChannelHandle;
  /**
   * Kanál se stejným tématem se ještě zavírá. supabase-js pro stejné téma
   * vrátí starou (odcházející) instanci a její `subscribe()` nic neudělá —
   * klient by zůstal navždy „připojuje“. Nový kanál se proto otevře až potom.
   */
  topicBusy?(topic: string): boolean;
  /** Vynuceně odebrat kanál tématu, který se sám neodebral (chyba odchodu). Best effort. */
  releaseTopic?(topic: string): void;
  verify(envelope: unknown, key: string): Promise<TvPricePayload | null>;
  /** Cesta ceny k ověřené zprávě (jen přehrání v grafu); chybí = bez cesty. */
  verifyTrail?(envelope: unknown, key: string, payload: TvPricePayload): Promise<number[] | null>;
  hasWebCrypto(): boolean;
  isForeground(): boolean;
  subscribeForeground(listener: (foreground: boolean) => void): () => void;
  now?: () => number;
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (timer: unknown) => void;
}

export interface TvPriceChannelClient {
  /**
   * Grant z přijaté odpovědi relaye (tvar se ověří tady). Bez platného grantu
   * při připojeném workeru = serverový vypínač (hned vypnout); bez workeru až
   * po `TV_GRANT_GRACE_MS`.
   */
  offerGrant(userId: string, grant: unknown, workerConnected: boolean): void;
  /** Odhlášení / jiný uživatel: vše zapomenout. */
  clear(): void;
  /** Připojená listová komponenta s otevřenou pozicí. Vrací odhlášení. */
  addPnlInterest(): () => void;
  /** Připojený graf dne s živou svíčkou (presence `chart`). Vrací odhlášení. */
  addChartInterest(): () => void;
}

type PresenceMeta = { pnl: boolean; chart: boolean };

/** Bez grantu (worker nepřipojený) se kanál drží ještě takhle dlouho. */
export const TV_GRANT_GRACE_MS = 30_000;
/** Konec zájmu nebo skrytí appky: presence se odhlásí po krátké prodlevě (alt-tab, remount řádků). */
export const TV_UNTRACK_DELAY_MS = 10_000;
/** … a kanál se zavře, když zájem nepřišel ani potom. */
export const TV_CLOSE_DELAY_MS = 60_000;
/** Víc čekajících ověření = zahodit (zahlcení veřejného kanálu cizím odesílatelem). */
export const TV_VERIFY_QUEUE_MAX = 16;
/** Ověření, které nedoběhne, se po této době bere jako neplatné. */
export const TV_VERIFY_TIMEOUT_MS = 2_000;
/** Jak často se zkusí otevřít kanál, dokud se starý se stejným tématem zavírá. */
export const TV_REOPEN_RETRY_MS = 250;
/** Starý kanál se nezavřel ani po této době → odebrat vynuceně (jinak by se čekalo navždy). */
export const TV_REOPEN_MAX_WAIT_MS = 10_000;
/**
 * Kanál, který se do této doby nepřipojí (nebo po chybě nevrátí), se zavře a otevře
 * znovu. realtime-js po odpojení socketu v okně `disconnecting` nový join nikdy
 * neodešle — bez hlídače by klient zůstal „připojuje“ napořád.
 */
export const TV_SUBSCRIBE_WATCHDOG_MS = 15_000;
/** Prodleva před novým otevřením po zásahu hlídače. */
export const TV_WATCHDOG_REOPEN_DELAY_MS = 2_000;

export function createTvPriceChannelClient(deps: TvPriceChannelClientDeps): TvPriceChannelClient {
  const now = deps.now ?? Date.now;
  const schedule = deps.setTimeoutImpl ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const cancel = deps.clearTimeoutImpl ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const { store } = deps;
  let userId: string | null = null;
  let grant: TvPriceGrant | null = null;
  const interest = { pnl: 0, chart: 0 };
  let foreground = deps.isForeground();
  let channel: TvPriceChannelHandle | null = null;
  let generation = 0;
  let joined = false;
  /** Co server o tomto klientovi ví (`null` = nic ohlášeno). */
  let trackedMeta: PresenceMeta | null = null;
  // Fronta ověřování patří jednomu kanálu; nový kanál začíná s prázdnou.
  let queue = { pending: 0, chain: Promise.resolve() as Promise<void> };
  let graceTimer: unknown = null;
  let untrackTimer: unknown = null;
  let closeTimer: unknown = null;
  let metaTimer: unknown = null;
  let reopenTimer: unknown = null;
  /** Kolikrát se čekalo na zavření starého kanálu se stejným tématem. */
  let reopenWaits = 0;
  let watchdogTimer: unknown = null;
  /** Hlídač zavřel kanál: znovu otevřít až po prodlevě. */
  let watchdogHold = false;
  let unsubscribeForeground: (() => void) | null = null;

  const safe = (action: () => unknown) => {
    try {
      const result = action();
      if (result && typeof (result as Promise<unknown>).catch === 'function') (result as Promise<unknown>).catch(() => undefined);
    } catch {
      // Zobrazovací kanál nikdy nevyhodí do LIVE.
    }
  };
  const clearTimer = (timer: unknown) => { if (timer !== null) cancel(timer); };

  const watching = () => interest.pnl + interest.chart > 0;
  const wanted = () => grant !== null && watching() && foreground && deps.hasWebCrypto();
  const idleReason = () => (watching() ? 'background' : 'not-watching');
  const desiredMeta = (): PresenceMeta => ({ pnl: interest.pnl > 0, chart: interest.chart > 0 });

  const closeChannel = (reason: string) => {
    clearTimer(untrackTimer);
    clearTimer(closeTimer);
    clearTimer(metaTimer);
    untrackTimer = null;
    closeTimer = null;
    metaTimer = null;
    const current = channel;
    channel = null;
    joined = false;
    trackedMeta = null;
    // Ověření rozpracovaná pro starý kanál se po dokončení zahodí.
    generation += 1;
    queue = { pending: 0, chain: Promise.resolve() };
    clearTimer(watchdogTimer);
    watchdogTimer = null;
    if (current) safe(() => current.close());
    store.setLink('off', reason);
  };

  /** Hlídač připojení: bez `SUBSCRIBED` do `TV_SUBSCRIBE_WATCHDOG_MS` zavřít a po prodlevě otevřít znovu. */
  const armWatchdog = () => {
    if (watchdogTimer !== null) return;
    const owner = generation;
    watchdogTimer = schedule(() => {
      watchdogTimer = null;
      if (owner !== generation || joined || !channel) return;
      closeChannel('subscribe-timeout');
      watchdogHold = true;
      store.setLink('connecting', 'subscribe-timeout');
      schedule(() => {
        watchdogHold = false;
        try { reconcile(); } catch { /* zobrazovací kanál nikdy nevyhodí */ }
      }, TV_WATCHDOG_REOPEN_DELAY_MS);
    }, TV_SUBSCRIBE_WATCHDOG_MS);
  };

  const track = (applyDrop = false) => {
    if (!channel || !joined || !wanted()) return;
    const meta = desiredMeta();
    if (trackedMeta && trackedMeta.pnl === meta.pnl && trackedMeta.chart === meta.chart) return;
    // Přibývající zájem se ohlásí hned; ubývající až po prodlevě (remount řádků, přepnutí grafu).
    const onlyDrops = trackedMeta !== null && (meta.pnl ? trackedMeta.pnl : true) && (meta.chart ? trackedMeta.chart : true);
    if (onlyDrops && !applyDrop) {
      if (metaTimer === null) {
        metaTimer = schedule(() => {
          metaTimer = null;
          track(true);
        }, TV_UNTRACK_DELAY_MS);
      }
      return;
    }
    clearTimer(metaTimer);
    metaTimer = null;
    trackedMeta = meta;
    const current = channel;
    safe(() => current.track(meta));
  };

  const untrack = () => {
    clearTimer(metaTimer);
    metaTimer = null;
    if (!channel || !trackedMeta) return;
    trackedMeta = null;
    const current = channel;
    safe(() => current.untrack());
  };

  const onMessage = (owner: number, envelope: unknown) => {
    if (owner !== generation || !grant) return;
    store.noteReceived();
    const current = queue;
    if (current.pending >= TV_VERIFY_QUEUE_MAX) {
      store.noteDropped();
      return;
    }
    const receivedAt = now();
    const key = grant.key;
    current.pending += 1;
    current.chain = current.chain.then(async () => {
      let timer: unknown = null;
      const startedAt = now();
      try {
        const payload = await Promise.race([
          deps.verify(envelope, key).catch(() => null),
          new Promise<null>(resolve => { timer = schedule(() => resolve(null), TV_VERIFY_TIMEOUT_MS); }),
        ]);
        if (owner !== generation) return;
        if (!payload) { store.noteRejected(); return; }
        // Neplatná nebo zaseknutá cesta zprávu neshodí (a frontu nezablokuje) — graf jen skočí rovnou na poslední cenu.
        // Jeden společný limit pro zprávu i cestu: zpráva nesmí kvůli cestě čekat déle než dřív.
        clearTimer(timer);
        timer = null;
        const remaining = TV_VERIFY_TIMEOUT_MS - (now() - startedAt);
        const trail = deps.verifyTrail && remaining > 0
          ? await Promise.race([
            deps.verifyTrail(envelope, key, payload).catch(() => null),
            new Promise<null>(resolve => { timer = schedule(() => resolve(null), remaining); }),
          ])
          : null;
        if (owner !== generation) return;
        store.accept(payload, receivedAt, trail);
      } finally {
        clearTimer(timer);
        current.pending -= 1;
      }
    }).catch(() => undefined);
  };

  const onStatus = (owner: number, status: TvPriceChannelStatus) => {
    if (owner !== generation) return;
    if (status === 'SUBSCRIBED') {
      clearTimer(watchdogTimer);
      watchdogTimer = null;
      joined = true;
      // Po (re)joinu server presence nezná — ohlásit znovu.
      trackedMeta = null;
      store.setLink('joined');
      track();
      return;
    }
    joined = false;
    trackedMeta = null;
    store.setLink('connecting', status.toLowerCase());
    // Chyba nebo vypršení: realtime-js zkouší sám, ale po odpojení socketu se nemusí vrátit nikdy.
    armWatchdog();
  };

  const open = () => {
    if (channel || !grant) return;
    if (watchdogHold) {
      store.setLink('connecting', 'subscribe-timeout');
      return;
    }
    let busy = false;
    try { busy = deps.topicBusy?.(grant.topic) === true; } catch { busy = false; }
    if (busy && reopenWaits * TV_REOPEN_RETRY_MS >= TV_REOPEN_MAX_WAIT_MS) {
      // Starý kanál se sám neodebral: vynuceně pryč, pak otevřít.
      safe(() => deps.releaseTopic?.(grant!.topic));
      try { busy = deps.topicBusy?.(grant.topic) === true; } catch { busy = false; }
    }
    if (busy) {
      reopenWaits += 1;
      store.setLink('connecting', 'closing-previous');
      if (reopenTimer === null) {
        reopenTimer = schedule(() => {
          reopenTimer = null;
          try { reconcile(); } catch { /* zobrazovací kanál nikdy nevyhodí */ }
        }, TV_REOPEN_RETRY_MS);
      }
      return;
    }
    reopenWaits = 0;
    generation += 1;
    const owner = generation;
    store.setLink('connecting', 'subscribing');
    try {
      channel = deps.openChannel(grant.topic, {
        onMessage: envelope => onMessage(owner, envelope),
        onStatus: status => onStatus(owner, status),
      });
      armWatchdog();
    } catch {
      channel = null;
      store.setLink('off', 'channel-error');
    }
  };

  const reconcile = () => {
    if (!grant) {
      closeChannel(userId ? 'no-grant' : 'signed-out');
      return;
    }
    if (!deps.hasWebCrypto()) {
      closeChannel('no-webcrypto');
      return;
    }
    if (wanted()) {
      clearTimer(untrackTimer);
      clearTimer(closeTimer);
      untrackTimer = null;
      closeTimer = null;
      if (!channel) open();
      else track();
      return;
    }
    if (!channel) {
      store.setLink('off', idleReason());
      return;
    }
    // Pozadí: odhlásit hned — iOS JS uspí dřív, než by prodleva doběhla.
    if (!foreground) {
      clearTimer(untrackTimer);
      untrackTimer = null;
      untrack();
    }
    if (trackedMeta && untrackTimer === null) {
      untrackTimer = schedule(() => {
        untrackTimer = null;
        if (!wanted()) untrack();
      }, TV_UNTRACK_DELAY_MS);
    }
    if (closeTimer === null) {
      closeTimer = schedule(() => {
        closeTimer = null;
        if (!wanted()) closeChannel(idleReason());
      }, TV_CLOSE_DELAY_MS);
    }
  };

  const ensureForegroundListener = () => {
    if (unsubscribeForeground) return;
    try {
      unsubscribeForeground = deps.subscribeForeground(next => {
        try {
          foreground = next;
          reconcile();
        } catch {
          // Nesmí zastavit ostatní posluchače popředí (obnova pollu LIVE).
        }
      });
      foreground = deps.isForeground();
    } catch {
      unsubscribeForeground = null;
    }
  };

  const forget = () => {
    clearTimer(graceTimer);
    graceTimer = null;
    grant = null;
    closeChannel(userId ? 'no-grant' : 'signed-out');
    store.reset();
  };

  return {
    offerGrant(nextUserId, nextGrant, workerConnected) {
      try {
        if (userId !== nextUserId) {
          userId = nextUserId;
          forget();
        }
        ensureForegroundListener();
        const valid = isTvPriceGrant(nextGrant) ? nextGrant : null;
        if (valid) {
          clearTimer(graceTimer);
          graceTimer = null;
          if (grant && (grant.topic !== valid.topic || grant.key !== valid.key)) {
            // Jiné zařízení / nový klíč: starý kanál pryč, běh a vzorky zapomenout.
            closeChannel('grant-changed');
            store.reset();
          }
          grant = valid;
          reconcile();
          return;
        }
        if (!grant) {
          reconcile();
          return;
        }
        if (workerConnected) {
          // Serverový vypínač: připojený worker bez grantu.
          forget();
          return;
        }
        if (graceTimer === null) {
          graceTimer = schedule(() => {
            graceTimer = null;
            forget();
          }, TV_GRANT_GRACE_MS);
        }
      } catch {
        // Nikdy do LIVE pollu.
      }
    },
    clear() {
      try {
        userId = null;
        forget();
      } catch {
        // best effort
      }
    },
    addPnlInterest: () => addInterest('pnl'),
    addChartInterest: () => addInterest('chart'),
  };

  function addInterest(kind: keyof PresenceMeta): () => void {
    interest[kind] += 1;
    try {
      ensureForegroundListener();
      reconcile();
    } catch {
      // best effort
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      interest[kind] = Math.max(0, interest[kind] - 1);
      try {
        reconcile();
      } catch {
        // best effort
      }
    };
  }
}
