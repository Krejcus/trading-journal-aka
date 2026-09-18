import type { CopierConnectionUsage } from './localCopierAgentProtocol';
import { TRADOVATE_HOUR_LIMIT, TRADOVATE_MINUTE_LIMIT, tradovateUsageLevel, type TradovateUsageWindow } from './tradovateUsageMeter';

/**
 * Řádek panelu „Diagnostika dat a API“: kolik Tradovate volání na jeden
 * login (token) dělá tato aplikace přes server a kolik worker, proti limitu
 * Tradovate, a v jakém stavu je session workeru. Jen zobrazení.
 */
export interface TradovateConnectionUsageRow {
  connectionId: string;
  label: string;
  /** Volání serveru pro tuto otevřenou aplikaci (sdílené výsledky se nepočítají). */
  web: TradovateUsageWindow;
  /** Volání workeru na Macu (REST + WebSocket požadavky); null = worker nehlásí. */
  worker: { rest: TradovateUsageWindow; ws: TradovateUsageWindow } | null;
  total: TradovateUsageWindow;
  level: 'ok' | 'warn' | 'over';
  minuteLimit: number;
  hourLimit: number;
  session: {
    known: boolean;
    streamConnected: boolean;
    phase: string;
    penaltyRemainingMs: number | null;
    lastClose: CopierConnectionUsage['lastClose'];
    consecutiveSyncTimeouts: number;
  };
}

export interface TradovateConnectionUsageInput {
  connections: ReadonlyArray<{ id: string; connected?: boolean; organizationName?: string | null; tradovateEmail?: string | null }>;
  brokerCalls: Readonly<Record<string, TradovateUsageWindow>>;
  workerUsage: ReadonlyArray<CopierConnectionUsage> | null | undefined;
  now: number;
}

const zero = (): TradovateUsageWindow => ({ minute: 0, hour: 0 });

export function buildTradovateConnectionUsageRows(input: TradovateConnectionUsageInput): TradovateConnectionUsageRow[] {
  const ids = new Set<string>();
  for (const connection of input.connections) ids.add(connection.id);
  for (const id of Object.keys(input.brokerCalls)) ids.add(id);
  for (const usage of input.workerUsage ?? []) ids.add(usage.connectionId);
  const byId = new Map(input.connections.map(connection => [connection.id, connection]));
  const workerById = new Map((input.workerUsage ?? []).map(usage => [usage.connectionId, usage]));
  return [...ids].map(connectionId => {
    const connection = byId.get(connectionId);
    const web = input.brokerCalls[connectionId] ?? zero();
    const worker = workerById.get(connectionId) ?? null;
    const total = {
      minute: web.minute + (worker?.rest.minute ?? 0) + (worker?.ws.minute ?? 0),
      hour: web.hour + (worker?.rest.hour ?? 0) + (worker?.ws.hour ?? 0),
    };
    return {
      connectionId,
      label: connection?.organizationName?.trim() || connection?.tradovateEmail?.trim() || `conn:${connectionId.slice(0, 8)}`,
      web,
      worker: worker ? { rest: worker.rest, ws: worker.ws } : null,
      total,
      level: tradovateUsageLevel(total),
      minuteLimit: TRADOVATE_MINUTE_LIMIT,
      hourLimit: TRADOVATE_HOUR_LIMIT,
      session: {
        known: worker != null,
        streamConnected: worker?.streamConnected === true,
        phase: worker?.phase ?? 'unknown',
        penaltyRemainingMs: worker?.penaltyUntil != null && worker.penaltyUntil > input.now ? worker.penaltyUntil - input.now : null,
        lastClose: worker?.lastClose ?? null,
        consecutiveSyncTimeouts: worker?.consecutiveSyncTimeouts ?? 0,
      },
    };
  }).sort((left, right) => right.total.minute - left.total.minute || left.label.localeCompare(right.label, 'cs'));
}
