import type { Account } from '../types';
import type { TradovateAccountProfile } from './tradovateAccountProfileTypes';
import type { TradovatePreflightResult } from '../services/tradovateOAuthConnection';

export interface TradovateJournalAccountPlan {
  accounts: Account[];
  profiles: TradovateAccountProfile[];
  changed: boolean;
}

const oauthIdentity = (provider: string, environment: string, externalAccountId: string) =>
  `${provider}:${environment}:${externalAccountId}`;

export const planTradovateJournalAccountLinks = ({
  accounts,
  profiles,
  connectionData,
  now = Date.now(),
  createId = () => crypto.randomUUID(),
}: {
  accounts: readonly Account[];
  profiles: readonly TradovateAccountProfile[];
  connectionData: Readonly<Record<string, TradovatePreflightResult>>;
  now?: number;
  createId?: () => string;
}): TradovateJournalAccountPlan => {
  const nextAccounts = [...accounts];
  let changed = false;

  const brokerAccounts = new Map<string, {
    connectionId: string;
    account: TradovatePreflightResult['accounts'][number];
  }>();
  for (const dataset of Object.values(connectionData)) {
    for (const account of dataset.accounts) {
      brokerAccounts.set(oauthIdentity('tradovate', dataset.environment, String(account.id)), {
        connectionId: dataset.connectionId,
        account,
      });
    }
  }

  const journalByOauth = new Map(nextAccounts.flatMap(account => account.oauth ? [[
    oauthIdentity(account.oauth.provider, account.oauth.environment, account.oauth.externalAccountId),
    account,
  ] as const] : []));

  const nextProfiles = profiles.map(profile => {
    if (profile.mappedAccountId) return profile;
    const identity = oauthIdentity(profile.provider, profile.environment, profile.externalAccountId);
    const broker = brokerAccounts.get(identity);
    if (!broker) return profile;

    let journalAccount = journalByOauth.get(identity);
    if (!journalAccount) {
      journalAccount = {
        id: createId(),
        name: profile.displayName || broker.account.name,
        type: 'Funded',
        phase: 'Funded',
        status: 'Active',
        initialBalance: profile.accountSize ?? broker.account.balance.totalCashValue ?? 0,
        currency: 'USD',
        createdAt: now,
        oauth: {
          provider: profile.provider,
          environment: profile.environment,
          externalAccountId: profile.externalAccountId,
          connectionId: broker.connectionId,
          firm: profile.propFirm,
        },
      };
      nextAccounts.push(journalAccount);
      journalByOauth.set(identity, journalAccount);
    }
    changed = true;
    return { ...profile, mappedAccountId: journalAccount.id };
  });

  return { accounts: nextAccounts, profiles: nextProfiles, changed };
};
