import type { LocalCopierExecutionAgent } from './localCopierExecutionAgent.js';
import {
  localCopierAgentErrorDetails,
  type LocalCopierAgentCommand,
} from '../lib/localCopierAgentProtocol.js';

export interface MacCopierCommandRelay {
  /** Okamžitě probudí poll s příznakem nových trade eventů — server pošle
   *  push hned místo čekání na minutový cron. */
  nudgeCopyEvents(): void;
  uploadSnapshot(snapshot: {
    episodeId: string;
    kind: 'entry' | 'exit' | 'sl-moved' | 'tv-alert';
    at: number;
    symbol: string;
    png: string;
    notifyDeadlineAt?: number;
  }, options?: { deadlineAt?: number }): Promise<void>;
  uploadSnapshotTest(snapshot: {
    requestId: string;
    png: string;
  }): Promise<{ devices: number; sent: number }>;
  close(): Promise<void>;
}

export interface MacCopierRealtimeKickConfig {
  url: string;
  anonKey: string;
  topic: string;
}

export interface MacTvAlertSnapshotRequest {
  id: string;
  symbol: string;
  timeframe: string | null;
}

export function startMacCopierCommandRelay(options: {
  apiOrigin: string;
  authorizationHeader: () => Promise<string>;
  agent: LocalCopierExecutionAgent;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  /**
   * Volitelný realtime „kick": server po zařazení příkazu pošle broadcast a
   * relay poll proběhne okamžitě místo čekání na interval. Konfigurace
   * kanálu přijde v poll odpovědi; poll interval zůstává jako záloha —
   * kick je čistá optimalizace latence, ne transport.
   */
  createKickSubscription?: (
    config: MacCopierRealtimeKickConfig,
    onKick: () => void,
  ) => () => Promise<void> | void;
  /** Fire-and-forget handoff; the relay poll never awaits chart capture. */
  onSnapshotRequests?: (requests: readonly MacTvAlertSnapshotRequest[]) => void;
}): MacCopierCommandRelay {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const pollMs = Math.max(500, options.pollMs ?? 750);
  let stopped = false;
  let running: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  /** Kick přišel mimo spánek (během poll requestu) — nesmí se ztratit. */
  let kickPending = false;
  /** Nové trade eventy čekají na okamžité odeslání serverem. */
  let copyEventsPending = false;
  let unsubscribeKick: (() => Promise<void> | void) | null = null;
  let kickTopic: string | null = null;
  const loopAbort = new AbortController();

  const sleep = (ms: number) => new Promise<void>(resolve => {
    if (kickPending) {
      kickPending = false;
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      kickPending = false;
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });

  const clearKickSubscription = async () => {
    const unsubscribe = unsubscribeKick;
    unsubscribeKick = null;
    kickTopic = null;
    if (unsubscribe) await unsubscribe();
  };

  const maybeSubscribeKick = async (realtime: unknown) => {
    if (!options.createKickSubscription || stopped) return;
    const config = realtime as Partial<MacCopierRealtimeKickConfig> | null | undefined;
    if (!config?.url || !config.anonKey || !config.topic || config.topic === kickTopic) return;
    await clearKickSubscription();
    kickTopic = config.topic;
    unsubscribeKick = options.createKickSubscription(
      { url: config.url, anonKey: config.anonKey, topic: config.topic },
      () => {
        kickPending = true;
        wake?.();
      },
    );
  };

  const abortable = <T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!signal) return pending;
    if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  };

  const request = async (payload: unknown, timeoutMs?: number, externalSignal?: AbortSignal) => {
    const requestAbort = timeoutMs || externalSignal ? new AbortController() : null;
    const abortFromExternal = () => requestAbort?.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    const timeout = timeoutMs ? setTimeout(
      () => requestAbort?.abort(new Error('copier-relay-request-timeout')),
      Math.max(1, timeoutMs),
    ) : null;
    timeout?.unref();
    try {
      const authorization = await abortable(options.authorizationHeader(), requestAbort?.signal);
      const response = await fetchImpl(`${options.apiOrigin}/api/tradovate/oauth/copier-relay`, {
        method: 'POST', headers: { Accept: 'application/json', Authorization: authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        ...(requestAbort ? { signal: requestAbort.signal } : {}),
      });
      let body: unknown;
      try {
        body = await response.json();
      } catch (error) {
        if (requestAbort?.signal.aborted) throw requestAbort.signal.reason ?? error;
        body = {};
      }
      if (!response.ok) throw new Error((body as { error?: string }).error || `copier-relay-http-${response.status}`);
      return body as Record<string, unknown>;
    } finally {
      if (timeout) clearTimeout(timeout);
      externalSignal?.removeEventListener('abort', abortFromExternal);
    }
  };

  const complete = async (commandId: string, result?: unknown, error?: string) => {
    // Autoritativní stav po vykonání posíláme ve stejném potvrzení. Server tak
    // může okamžitě oznámit ARM/DISARM bez čekání na další poll heartbeat.
    await request({
      action: 'complete', commandId, status: options.agent.status(),
      ...(error ? { error, ...(result == null ? {} : { result }) } : { result }),
    }, 10_000, loopAbort.signal);
  };

  const loop = async () => {
    let failures = 0;
    while (!stopped) {
      try {
        const notifyCopyEvents = copyEventsPending;
        const response = await request({
          action: 'poll',
          status: options.agent.status(),
          ...(notifyCopyEvents ? { copyEvents: true } : {}),
        }, 10_000, loopAbort.signal);
        failures = 0;
        if (notifyCopyEvents) copyEventsPending = false;
        await maybeSubscribeKick(response.realtime);
        if (Array.isArray(response.snapshotRequests) && options.onSnapshotRequests) {
          const requests = response.snapshotRequests.flatMap(value => {
            if (!value || typeof value !== 'object') return [];
            const row = value as Record<string, unknown>;
            if (typeof row.id !== 'string' || typeof row.symbol !== 'string') return [];
            return [{
              id: row.id,
              symbol: row.symbol,
              timeframe: typeof row.timeframe === 'string' ? row.timeframe : null,
            }];
          });
          if (requests.length > 0) options.onSnapshotRequests(requests);
        }
        const remote = response.command as { id?: string; command?: LocalCopierAgentCommand; expiresAt?: string } | null;
        if (remote?.id && remote.command) {
          // Telemetrie: enqueue čas = expiresAt - 30 s (server TTL). Čekání
          // ve frontě přímo ukazuje, jestli realtime kick funguje (<300 ms).
          if (remote.expiresAt) {
            const queuedAt = Date.parse(remote.expiresAt) - 30_000;
            if (Number.isFinite(queuedAt)) {
              console.log(`${new Date().toISOString()} RELAY CMD ${remote.command.type} čekal ve frontě ${Math.max(0, Date.now() - queuedAt)} ms`);
            }
          }
          if (!remote.expiresAt || Date.parse(remote.expiresAt) <= Date.now()) {
            await complete(remote.id, undefined, 'command-expired-before-execution');
          } else {
            let result: unknown;
            let executionError: string | undefined;
            try {
              result = await options.agent.execute(remote.command);
            } catch (error) {
              executionError = error instanceof Error ? error.message : String(error);
              const errorDetails = localCopierAgentErrorDetails(error);
              if (errorDetails) result = { errorDetails };
            }
            // ACK transport failure must never be rewritten as execution
            // failure: the broker outcome may already be authoritative and
            // must not be retried or falsely reported as unexecuted.
            await complete(remote.id, result, executionError);
          }
        }
      } catch (error) {
        if (stopped && loopAbort.signal.aborted) break;
        failures += 1;
        if (failures === 1 || failures % 20 === 0) {
          console.error(`${new Date().toISOString()} COPIER RELAY (${failures}. selhání v řadě) ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (stopped) break;
      await sleep(failures ? Math.min(5_000, pollMs * failures) : pollMs);
    }
  };
  running = loop();
  return {
    nudgeCopyEvents() {
      copyEventsPending = true;
      kickPending = true;
      wake?.();
    },
    async uploadSnapshot(snapshot, uploadOptions) {
      let lastError: unknown;
      // První pokus + nejvýše dva retry. Tato větev nikdy není awaitovaná
      // controllerem a po vyčerpání pokusů pouze předá chybu SNAPSHOT logu.
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          // Server během jednoho requestu ukládá do storage, linkuje alert
          // a posílá APNs; tři sekundy na to nestačí a klient si po timeoutu
          // vyrobil retry, který pak narazil na „alert už snímek má".
          const remaining = uploadOptions?.deadlineAt == null ? 8_000 : uploadOptions.deadlineAt - Date.now();
          if (remaining <= 0) throw new Error('copier-snapshot-deadline');
          const response = await request({ action: 'snapshot', ...snapshot }, Math.min(8_000, remaining));
          if (response.accepted !== true) throw new Error('copier-snapshot-store-rejected');
          return;
        } catch (error) {
          lastError = error;
          const retryDelay = 250 * (attempt + 1);
          if (attempt < 2 && (uploadOptions?.deadlineAt == null || Date.now() + retryDelay < uploadOptions.deadlineAt)) {
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          } else if (attempt < 2) break;
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
    async uploadSnapshotTest(snapshot) {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const response = await request({ action: 'snapshot-test', ...snapshot }, 8_000);
          if (response.accepted !== true) throw new Error('copier-snapshot-test-not-delivered');
          return {
            devices: Number(response.devices) || 0,
            sent: Number(response.sent) || 0,
          };
        } catch (error) {
          lastError = error;
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
    async close() {
      stopped = true;
      loopAbort.abort(new Error('copier-relay-close'));
      wake?.();
      await running;
      await clearKickSubscription();
    },
  };
}
