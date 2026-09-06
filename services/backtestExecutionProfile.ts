import type { BacktestRunConfig } from './backtestTypes';
import { DEFAULT_BACKTEST_FLAT_BY_MINUTE, DEFAULT_BACKTEST_FLAT_TIME_ZONE } from './backtestSessionClose';
import { hashBacktestEvidence } from './backtestEvidenceIdentity';

/** Describes the current implementation; codeRevision must be supplied for an exact build identity. */
export const buildBacktestExecutionProfile = async (config: BacktestRunConfig, codeRevision?: string) => {
  const instruments = [...new Set(config.instruments)].sort();
  if (!instruments.length || !instruments.every(root => root === 'MNQ' || root === 'NQ') || !instruments.includes(config.executionInstrument) || config.contractPolicy !== 'continuous') throw new Error('Invalid execution profile instruments.');
  const costs = Object.fromEntries(instruments.map(root => {
    const commissionPerSide = config.commissionPerSide[root], slippageTicks = config.slippageTicks[root];
    if (![commissionPerSide, slippageTicks].every(value => Number.isFinite(value) && value >= 0)) throw new Error('Invalid execution profile costs.');
    return [root, { commissionPerSide, slippageTicks, tickSize: 0.25, pointValue: root === 'MNQ' ? 2 : 20, currency: 'USD' as const }];
  }));
  const flatTimeZone = config.flatTimeZone ?? DEFAULT_BACKTEST_FLAT_TIME_ZONE;
  const flatByMinute = config.flatByMinute ?? DEFAULT_BACKTEST_FLAT_BY_MINUTE;
  if (!Number.isInteger(flatByMinute) || flatByMinute < 0 || flatByMinute >= 1440) throw new Error('Invalid execution cutoff minute.');
  for (const timeZone of [flatTimeZone, config.timezone]) new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  const body = {
    format: 'alphatrade-backtest-execution-profile' as const, version: 1 as const,
    implementation: { module: 'services/backtestEngine.ts', codeRevision: codeRevision ?? null, policyId: 'alphatrade-minute-ohlcv-conservative-v1' },
    instruments, executionInstrument: config.executionInstrument, contractPolicy: config.contractPolicy, replayInterval: '1m' as const, displayTimeZone: config.timezone,
    costs,
    cutoff: { timeZone: flatTimeZone, minuteOfDay: flatByMinute, behavior: 'cancel pending; flatten at first available candle open at or after per-order/position cutoff, with adverse slippage' },
    execution: {
      marketAction: 'last-revealed quote close plus adverse tick slippage',
      restingActivation: 'only candle.time > order.updatedAt',
      limitFill: 'open improvement allowed; adverse slippage capped by limit price',
      stopFill: 'trigger or gap-open price plus adverse tick slippage',
      intrabar: 'open-gap crossings first; conservative adverse-first when OHLC cannot order SL and TP; uncertainty flags retained',
      uncertainTargetOnly: 'not credited without a proven post-entry crossing',
      excursion: 'proven post-entry/pre-exit prices; unresolved extrema flagged',
    },
    limitations: ['No tick path, spread, latency, queue or volume-based fill model.', 'No supplied codeRevision means policy metadata is not proof of a specific engine build.'],
  };
  return { ...body, profileHash: await hashBacktestEvidence(body) };
};
export type BacktestExecutionProfile = Awaited<ReturnType<typeof buildBacktestExecutionProfile>>;
