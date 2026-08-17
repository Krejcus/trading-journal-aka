import {
  LOCAL_COPIER_AGENT_BASE_URL,
  type LocalCopierAgentCommand,
  type LocalCopierAgentCommandResult,
  type LocalCopierAgentStatus,
} from '../lib/localCopierAgentProtocol';
import type { LiveCopyTradingAdapter, LiveCopyTradingCommand } from './liveCopyTrading';

export interface LocalCopierAgentClient {
  status(): Promise<LocalCopierAgentStatus>;
  execute(command: LocalCopierAgentCommand): Promise<LocalCopierAgentCommandResult>;
  adapter(): LiveCopyTradingAdapter;
}

export function createLocalCopierAgentClient(baseUrl = LOCAL_COPIER_AGENT_BASE_URL): LocalCopierAgentClient {
  let current: LocalCopierAgentStatus | null = null;

  const readJson = async (response: Response): Promise<unknown> => {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload && typeof payload === 'object' && 'error' in payload
        ? String(payload.error)
        : `Lokální execution agent odpověděl ${response.status}`;
      throw new Error(message);
    }
    return payload;
  };

  const status = async () => {
    const response = await fetch(`${baseUrl}/v1/status`, { cache: 'no-store' });
    current = await readJson(response) as LocalCopierAgentStatus;
    return current;
  };

  const execute = async (command: LocalCopierAgentCommand) => {
    if (!current) await status();
    const response = await fetch(`${baseUrl}/v1/command`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-AlphaTrade-Agent-Nonce': current?.nonce ?? '',
      },
      body: JSON.stringify(command),
    });
    const payload = await readJson(response) as LocalCopierAgentCommandResult;
    current = payload.status;
    return payload;
  };

  return {
    status,
    execute,
    adapter: () => ({
      execute: (command: LiveCopyTradingCommand) => execute({ type: 'copy-command', command }).then(payload => payload.result),
    }),
  };
}
