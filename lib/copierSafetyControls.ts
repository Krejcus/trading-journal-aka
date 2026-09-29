import type { LiveCopyTradingCommand } from '../services/liveCopyTrading';

export interface CopierAgentRoute {
  transport: 'local' | 'relay';
  relayConnectionId: string | null;
}

const RISK_REDUCING_COPY_COMMANDS = new Set<LiveCopyTradingCommand['type']>([
  'flatten-group',
  'flatten-account',
  'flatten-follower-trade',
]);

export const copierCommandAllowedWithoutFreshStatus = (command: LiveCopyTradingCommand): boolean =>
  RISK_REDUCING_COPY_COMMANDS.has(command.type);

export const selectCopierSafetyRoute = (
  lastVerified: CopierAgentRoute | null,
  current: CopierAgentRoute | null,
  directLocalAvailable: boolean,
): CopierAgentRoute | null => lastVerified
  ?? current
  ?? (directLocalAvailable ? { transport: 'local', relayConnectionId: null } : null);
