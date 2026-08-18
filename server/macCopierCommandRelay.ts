import type { LocalCopierExecutionAgent } from './localCopierExecutionAgent.js';
import type { LocalCopierAgentCommand } from '../lib/localCopierAgentProtocol.js';

export interface MacCopierCommandRelay {
  close(): Promise<void>;
}

export function startMacCopierCommandRelay(options: {
  apiOrigin: string;
  authorizationHeader: () => Promise<string>;
  agent: LocalCopierExecutionAgent;
  fetchImpl?: typeof fetch;
  pollMs?: number;
}): MacCopierCommandRelay {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const pollMs = Math.max(500, options.pollMs ?? 750);
  let stopped = false;
  let running: Promise<void> | null = null;

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
    await request({ action: 'complete', commandId, ...(error ? { error } : { result }) });
  };

  const loop = async () => {
    let failures = 0;
    while (!stopped) {
      try {
        const response = await request({ action: 'poll', status: options.agent.status() });
        failures = 0;
        const remote = response.command as { id?: string; command?: LocalCopierAgentCommand; expiresAt?: string } | null;
        if (remote?.id && remote.command) {
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
        if (failures === 1 || failures % 20 === 0) console.error(`COPIER RELAY ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise(resolve => setTimeout(resolve, failures ? Math.min(5_000, pollMs * failures) : pollMs));
    }
  };
  running = loop();
  return { async close() { stopped = true; await running; } };
}
