import type { LocalCopierExecutionAgent } from './localCopierExecutionAgent.js';
import type { LocalCopierAgentCommand } from '../lib/localCopierAgentProtocol.js';

export interface MacCopierCommandRelay {
  close(): Promise<void>;
}

export interface MacCopierRealtimeKickConfig {
  url: string;
  anonKey: string;
  topic: string;
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
  ) => () => void;
}): MacCopierCommandRelay {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const pollMs = Math.max(500, options.pollMs ?? 750);
  let stopped = false;
  let running: Promise<void> | null = null;
  let wake: (() => void) | null = null;
  /** Kick přišel mimo spánek (během poll requestu) — nesmí se ztratit. */
  let kickPending = false;
  let unsubscribeKick: (() => void) | null = null;
  let kickTopic: string | null = null;

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

  const maybeSubscribeKick = (realtime: unknown) => {
    if (!options.createKickSubscription || stopped) return;
    const config = realtime as Partial<MacCopierRealtimeKickConfig> | null | undefined;
    if (!config?.url || !config.anonKey || !config.topic || config.topic === kickTopic) return;
    unsubscribeKick?.();
    kickTopic = config.topic;
    unsubscribeKick = options.createKickSubscription(
      { url: config.url, anonKey: config.anonKey, topic: config.topic },
      () => {
        kickPending = true;
        wake?.();
      },
    );
  };

  const request = async (payload: unknown) => {
    const response = await fetchImpl(`${options.apiOrigin}/api/tradovate/oauth/copier-relay`, {
      method: 'POST', headers: { Accept: 'application/json', Authorization: await options.authorizationHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error((body as { error?: string }).error || `copier-relay-http-${response.status}`);
    return body as Record<string, unknown>;
  };

  const complete = async (commandId: string, result?: unknown, error?: string) => {
    // Autoritativní stav po vykonání posíláme ve stejném potvrzení. Server tak
    // může okamžitě oznámit ARM/DISARM bez čekání na další poll heartbeat.
    await request({
      action: 'complete', commandId, status: options.agent.status(),
      ...(error ? { error } : { result }),
    });
  };

  const loop = async () => {
    let failures = 0;
    while (!stopped) {
      try {
        const response = await request({ action: 'poll', status: options.agent.status() });
        failures = 0;
        maybeSubscribeKick(response.realtime);
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
            try {
              await complete(remote.id, await options.agent.execute(remote.command));
            } catch (error) {
              await complete(remote.id, undefined, error instanceof Error ? error.message : String(error));
            }
          }
        }
      } catch (error) {
        failures += 1;
        if (failures === 1 || failures % 20 === 0) {
          console.error(`${new Date().toISOString()} COPIER RELAY (${failures}. selhání v řadě) ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      await sleep(failures ? Math.min(5_000, pollMs * failures) : pollMs);
    }
  };
  running = loop();
  return {
    async close() {
      stopped = true;
      unsubscribeKick?.();
      unsubscribeKick = null;
      wake?.();
      await running;
    },
  };
}
