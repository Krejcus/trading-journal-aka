import type { Account } from '../types';
import type { TradovateAccountProfile } from './tradovateAccountProfileTypes';
import type { TradovateOAuthStatus, TradovatePreflightResult } from '../services/tradovateOAuthConnection';

export interface OAuthAccountLiveState {
  status: 'connected' | 'disconnected' | 'unknown';
  lastSeenAt: string | null;
}

const newestTimestamp = (...values: Array<string | null | undefined>): string | null => {
  const valid = values.filter((value): value is string => !!value && Number.isFinite(Date.parse(value)));
  return valid.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
};

export const buildOAuthAccountLiveStates = ({
  accounts,
  status,
  connectionData,
  profiles,
}: {
  accounts: readonly Account[];
  status: TradovateOAuthStatus | null;
  connectionData: Readonly<Record<string, TradovatePreflightResult>>;
  profiles: readonly TradovateAccountProfile[];
}): Record<string, OAuthAccountLiveState> => Object.fromEntries(accounts.flatMap(account => {
  if (!account.oauth) return [];
  const dataset = Object.values(connectionData).find(candidate => (
    candidate.environment === account.oauth!.environment
    && candidate.accounts.some(brokerAccount => String(brokerAccount.id) === account.oauth!.externalAccountId)
  ));
  const connectionId = dataset?.connectionId ?? account.oauth.connectionId;
  const connection = status?.connections.find(candidate => candidate.id === connectionId);
  const profile = profiles.find(candidate => (
    candidate.provider === account.oauth!.provider
    && candidate.environment === account.oauth!.environment
    && candidate.externalAccountId === account.oauth!.externalAccountId
  ));
  return [[account.id, {
    status: status == null ? 'unknown' : connection?.connected ? 'connected' : 'disconnected',
    lastSeenAt: newestTimestamp(dataset?.capturedAt, profile?.lastSeenAt),
  } satisfies OAuthAccountLiveState]];
}));
