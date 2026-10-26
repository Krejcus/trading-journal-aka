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
  verify(envelope: unknown, key: string): Promise<TvPricePayload | null>;
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
}

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

export function createTvPriceChannelClient(deps: TvPriceChannelClientDeps): TvPriceChannelClient {
  const now = deps.now ?? Date.now;
  const schedule = deps.setTimeoutImpl ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const cancel = deps.clearTimeoutImpl ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const { store } = deps;
  let userId: string | null = null;
  let grant: TvPriceGrant | null = null;
  let interest = 0;
  let foreground = deps.isForeground();
  let channel: TvPriceChannelHandle | null = null;
  let generation = 0;
  let joined = false;
  let tracked = false;
  // Fronta ověřování patří jednomu kanálu; nový kanál začíná s prázdnou.
  let queue = { pending: 0, chain: Promise.resolve() as Promise<void> };
  let graceTimer: unknown = null;
  let untrackTimer: unknown = null;
  let closeTimer: unknown = null;
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

  const wanted = () => grant !== null && interest > 0 && foreground && deps.hasWebCrypto();

  const closeChannel = (reason: string) => {
    clearTimer(untrackTimer);
    clearTimer(closeTimer);
    untrackTimer = null;
    closeTimer = null;
    const current = channel;
    channel = null;
    joined = false;
    tracked = false;
    // Ověření rozpracovaná pro starý kanál se po dokončení zahodí.
    generation += 1;
    queue = { pending: 0, chain: Promise.resolve() };
    if (current) safe(() => current.close());
    store.setLink('off', reason);
  };

  const track = () => {
    if (!channel || !joined || tracked || !wanted()) return;
    tracked = true;
    const current = channel;
    safe(() => current.track({ pnl: true, chart: false }));
  };

  const untrack = () => {
    if (!channel || !tracked) return;
    tracked = false;
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
      try {
        const payload = await Promise.race([
          deps.verify(envelope, key).catch(() => null),
          new Promise<null>(resolve => { timer = schedule(() => resolve(null), TV_VERIFY_TIMEOUT_MS); }),
        ]);
        if (owner !== generation) return;
        if (!payload) store.noteRejected();
        else store.accept(payload, receivedAt);
      } finally {
        clearTimer(timer);
        current.pending -= 1;
      }
    }).catch(() => undefined);
  };

  const onStatus = (owner: number, status: TvPriceChannelStatus) => {
    if (owner !== generation) return;
    if (status === 'SUBSCRIBED') {
      joined = true;
      // Po (re)joinu server presence nezná — ohlásit znovu.
      tracked = false;
      store.setLink('joined');
      track();
      return;
    }
    joined = false;
    tracked = false;
    store.setLink('connecting', status.toLowerCase());
  };

  const open = () => {
    if (channel || !grant) return;
    generation += 1;
    const owner = generation;
    store.setLink('connecting', 'subscribing');
    try {
      channel = deps.openChannel(grant.topic, {
        onMessage: envelope => onMessage(owner, envelope),
        onStatus: status => onStatus(owner, status),
      });
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
      store.setLink('off', interest > 0 ? 'background' : 'no-open-position');
      return;
    }
    // Pozadí: odhlásit hned — iOS JS uspí dřív, než by prodleva doběhla.
    if (!foreground) {
      clearTimer(untrackTimer);
      untrackTimer = null;
      untrack();
    }
    if (tracked && untrackTimer === null) {
      untrackTimer = schedule(() => {
        untrackTimer = null;
        if (!wanted()) untrack();
      }, TV_UNTRACK_DELAY_MS);
    }
    if (closeTimer === null) {
      closeTimer = schedule(() => {
        closeTimer = null;
        if (!wanted()) closeChannel(interest > 0 ? 'background' : 'no-open-position');
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
    addPnlInterest() {
      interest += 1;
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
        interest = Math.max(0, interest - 1);
        try {
          reconcile();
        } catch {
          // best effort
        }
      };
    },
  };
}
