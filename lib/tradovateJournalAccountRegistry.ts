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

  // Typ/fáze v journalu podle typu účtu z profilu (evaluace ≠ funded).
  const classification = (accountType: TradovateAccountProfile['accountType']): Pick<Account, 'type' | 'phase'> => {
    if (accountType === 'evaluation') return { type: 'Funded', phase: 'Challenge' };
    if (accountType === 'live') return { type: 'Live' };
    return { type: 'Funded', phase: 'Funded' };
  };

  // Hojení už namapovaných účtů: firmOverride (řídí seskupení v kartě Účty)
  // doplň, jen když chybí; typ/fázi oprav pouze z auto-výchozího stavu
  // 'Funded'/'Funded' — ručně přenastavené hodnoty se nikdy nepřepisují.
  const healMapped = (profile: TradovateAccountProfile) => {
    const index = nextAccounts.findIndex(account => account.id === profile.mappedAccountId && account.oauth);
    if (index < 0) return;
    const account = nextAccounts[index];
    const healed = { ...account };
    let touched = false;
    if (!String(healed.firmOverride ?? '').trim() && profile.propFirm) {
      healed.firmOverride = profile.propFirm;
      touched = true;
    }
    const desired = classification(profile.accountType);
    if (profile.accountType && profile.accountType !== 'funded'
      && healed.type === 'Funded' && healed.phase === 'Funded'
      && (healed.type !== desired.type || healed.phase !== desired.phase)) {
      healed.type = desired.type;
      healed.phase = desired.phase;
      touched = true;
    }
    if (touched) {
      nextAccounts[index] = healed;
      changed = true;
    }
  };

  const nextProfiles = profiles.map(profile => {
    if (profile.mappedAccountId) {
      healMapped(profile);
      return profile;
    }
    const identity = oauthIdentity(profile.provider, profile.environment, profile.externalAccountId);
    const broker = brokerAccounts.get(identity);
    if (!broker) return profile;

    let journalAccount = journalByOauth.get(identity);
    if (!journalAccount) {
      journalAccount = {
        id: createId(),
        name: profile.displayName || broker.account.name,
        ...classification(profile.accountType),
        status: 'Active',
        initialBalance: profile.accountSize ?? broker.account.balance.totalCashValue ?? 0,
        currency: 'USD',
        createdAt: now,
        ...(profile.propFirm ? { firmOverride: profile.propFirm } : {}),
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
