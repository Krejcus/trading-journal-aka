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

/**
 * Agent příkaz během stavu obnoveného z paměti (návrat na LIVE, tato instance
 * ještě nepřijala vlastní odpověď workeru). Projde jen riziko snižující
 * copy příkaz; ARM, konfigurace, reconcile ani nic jiného ne. DISARM a kill
 * switch mají vlastní cestu (executeSafetyCommand) a touto bránou nejdou.
 */
export const copierAgentCommandAllowedWhileRestored = (
  command: { type: string; command?: LiveCopyTradingCommand },
): boolean => command.type === 'copy-command' && command.command != null
  && copierCommandAllowedWithoutFreshStatus(command.command);

export const selectCopierSafetyRoute = (
  lastVerified: CopierAgentRoute | null,
  current: CopierAgentRoute | null,
  directLocalAvailable: boolean,
): CopierAgentRoute | null => lastVerified
  ?? current
  ?? (directLocalAvailable ? { transport: 'local', relayConnectionId: null } : null);
