import type { TradovatePreflightResult } from '../services/tradovateOAuthConnection';

export type SettledTradovatePreflight = PromiseSettledResult<TradovatePreflightResult>;
export type PrestartedTradovatePreflights = Map<string, Promise<SettledTradovatePreflight>>;

type StartPreflight = (connectionId: string) => Promise<TradovatePreflightResult>;

const startSettledPreflight = (
  connectionId: string,
  start: StartPreflight,
): Promise<SettledTradovatePreflight> => {
  try {
    return start(connectionId).then(
      value => ({ status: 'fulfilled', value }),
      reason => ({ status: 'rejected', reason }),
    );
  } catch (reason) {
    return Promise.resolve({ status: 'rejected', reason });
  }
};

export const startTradovatePreflights = (
  connectionIds: readonly string[],
  start: StartPreflight,
): PrestartedTradovatePreflights => new Map(connectionIds.map(connectionId => [
  connectionId,
  startSettledPreflight(connectionId, start),
]));

export const consumeTradovatePreflights = (
  connectionIds: readonly string[],
  start: StartPreflight,
  onDataset: (dataset: TradovatePreflightResult) => void,
  prestarted?: PrestartedTradovatePreflights,
): Promise<SettledTradovatePreflight[]> => Promise.all(connectionIds.map(connectionId => {
  const result = prestarted?.get(connectionId) ?? startSettledPreflight(connectionId, start);
  return result.then(settled => {
    if (settled.status === 'fulfilled') onDataset(settled.value);
    return settled;
  });
}));
