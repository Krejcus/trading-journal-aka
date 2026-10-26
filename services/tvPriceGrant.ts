import { isAppForeground, subscribeAppForeground } from '../lib/appForeground';
import { supabase } from './supabase';
import { tvPriceChannel } from './tvPriceChannel';
import { loadTradovateCopierRelayStatus, loadTradovateOAuthStatus } from './tradovateOAuthConnection';

/**
 * Jediné, co LIVE desk smí s kanálem ceny z TradingView dělat: předat grant
 * (téma + klíč) z odpovědi relaye a při odhlášení vše zapomenout. Store ani
 * zájem o P&L odsud nejsou dostupné (INV-UI-04, `tests/tvPriceClientGuards.test.ts`).
 */
export function offerTvPriceGrant(userId: string, grant: unknown, workerConnected: boolean): void {
  tvPriceChannel.offerGrant(userId, grant, workerConnected);
}

export function clearTvPriceChannel(): void {
  tvPriceChannel.clear();
}

/** Grant mimo LIVE se obnovuje nejvýš takhle často (a po návratu do popředí). */
export const TV_GRANT_REFRESH_MS = 60_000;

export interface TvPriceGrantRefreshDeps {
  userId(): Promise<string | null>;
  connectionIds(): Promise<string[]>;
  relayStatus(connectionId: string): Promise<{ connected?: boolean; priceChannel?: unknown } | null>;
  offer(userId: string, grant: unknown, workerConnected: boolean): void;
  isForeground(): boolean;
  subscribeForeground(listener: (foreground: boolean) => void): () => void;
  setIntervalImpl?: (callback: () => void, ms: number) => unknown;
  clearIntervalImpl?: (timer: unknown) => void;
}

/**
 * Graf dne (mimo LIVE): grant z GET relaye čteného jen kvůli kanálu ceny —
 * status workeru se nepřijímá, neukládá a nic podle něj nerozhoduje (stejné
 * čtení jako restart TradingView mimo LIVE). Vrací zastavení.
 */
export function startTvPriceGrantRefresh(deps: TvPriceGrantRefreshDeps): () => void {
  let stopped = false;
  let inFlight = false;
  let connectionIds: string[] | null = null;
  const load = async () => {
    if (stopped || inFlight || !deps.isForeground()) return;
    inFlight = true;
    try {
      const userId = await deps.userId();
      if (!userId || stopped) return;
      if (!connectionIds) connectionIds = [...new Set(await deps.connectionIds())].sort();
      if (stopped) return;
      // Kterékoli připojení uživatele najde jeho Mac worker. Přednost má odpověď
      // s živým workerem a grantem; jinak poslední odpověď (serverový vypínač / grace).
      let fallback: { connected?: boolean; priceChannel?: unknown } | null = null;
      for (const connectionId of connectionIds) {
        const remote = await deps.relayStatus(connectionId).catch(() => null);
        if (stopped) return;
        if (remote?.connected === true && remote.priceChannel) {
          deps.offer(userId, remote.priceChannel, true);
          return;
        }
        fallback = remote ?? fallback;
      }
      if (fallback) deps.offer(userId, fallback.priceChannel ?? null, fallback.connected === true);
      // Seznam připojení mohl zastarat — bez živého grantu ho příště načíst znovu.
      connectionIds = null;
    } catch {
      connectionIds = null;
    } finally {
      inFlight = false;
    }
  };
  const every = deps.setIntervalImpl ?? ((callback: () => void, ms: number) => setInterval(callback, ms));
  const cancel = deps.clearIntervalImpl ?? (timer => clearInterval(timer as ReturnType<typeof setInterval>));
  void load();
  const timer = every(() => { void load(); }, TV_GRANT_REFRESH_MS);
  const unsubscribeForeground = deps.subscribeForeground(foreground => { if (foreground) void load(); });
  return () => {
    stopped = true;
    cancel(timer);
    unsubscribeForeground();
  };
}

const defaultRefreshDeps: TvPriceGrantRefreshDeps = {
  userId: async () => (await supabase.auth.getSession()).data.session?.user.id ?? null,
  connectionIds: async () => (await loadTradovateOAuthStatus()).connections
    .filter(connection => connection.connected).map(connection => connection.id),
  relayStatus: loadTradovateCopierRelayStatus,
  offer: offerTvPriceGrant,
  isForeground: isAppForeground,
  subscribeForeground: subscribeAppForeground,
};

let sharedRefresh: { holders: number; stop: () => void } | null = null;

/** Jedna společná obnova grantu pro všechny napojené grafy (počítá držitele). */
export function acquireTvPriceGrantRefresh(): () => void {
  if (!sharedRefresh) sharedRefresh = { holders: 0, stop: startTvPriceGrantRefresh(defaultRefreshDeps) };
  sharedRefresh.holders += 1;
  let released = false;
  return () => {
    if (released || !sharedRefresh) return;
    released = true;
    sharedRefresh.holders -= 1;
    if (sharedRefresh.holders <= 0) {
      sharedRefresh.stop();
      sharedRefresh = null;
    }
  };
}
