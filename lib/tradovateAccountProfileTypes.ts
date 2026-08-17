export type TradovateProfileEnvironment = 'demo' | 'live';
export type TradovateProfileAccountType = 'evaluation' | 'funded' | 'live';
export type TradovateProfileDrawdownType = 'trailing' | 'eod_trailing' | 'static' | 'none';
export type TradovateProfileStatus = 'active' | 'archived';

export interface TradovateAccountProfileInput {
  externalAccountId: string;
  accountName: string;
  displayName: string | null;
  propFirm: string | null;
  planName: string | null;
  accountType: TradovateProfileAccountType | null;
  accountSize: number | null;
  drawdownType: TradovateProfileDrawdownType | null;
  maxLoss: number | null;
  dailyLossLimit: number | null;
  consistencyPct: number | null;
  profitTarget: number | null;
  maxMini: number | null;
  maxMicro: number | null;
}

export interface TradovateAccountProfile extends TradovateAccountProfileInput {
  id: string;
  provider: 'tradovate';
  environment: TradovateProfileEnvironment;
  status: TradovateProfileStatus;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface TradovateAccountProfilesResult {
  environment: TradovateProfileEnvironment;
  profiles: TradovateAccountProfile[];
}
