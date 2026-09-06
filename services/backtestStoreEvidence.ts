import type { BacktestCandleSnapshot } from './backtestCandleStore';
import { buildBacktestDataManifest, type BacktestDataCalendar } from './backtestDataManifest';
import { buildBacktestExecutionProfile } from './backtestExecutionProfile';
import type { BacktestRun } from './backtestTypes';
import { resolveMarketSymbol } from './marketData';

/** No fetches. Even request provenance is clipped to the revealed bar-open horizon. */
export async function buildBacktestStoreEvidence(input: {
  snapshot: BacktestCandleSnapshot;
  run: Pick<BacktestRun, 'id' | 'startAt' | 'endAt' | 'config'>;
  replayHorizonTime: number | null;
  calendar?: BacktestDataCalendar;
  codeRevision?: string;
}) {
  const { run, snapshot, replayHorizonTime: horizon } = input;
  const endMs = horizon !== null && Number.isFinite(horizon)
    ? Math.min(run.endAt, (Math.floor(horizon / 60) + 1) * 60_000) : run.startAt;
  const executionProfile = await buildBacktestExecutionProfile(run.config, input.codeRevision);
  const manifests = await Promise.all(endMs > run.startAt ? run.config.instruments.map(async root => {
    const receipts = (snapshot.provenance ?? []).filter(item => item.root === root && item.schema === 'ohlcv-1m'
      && item.purpose !== 'context-history' && item.startMs < endMs && item.endMs > run.startAt);
    const sourceSymbols = [...new Set(receipts.map(item => item.response?.sourceSymbol).filter((value): value is string => Boolean(value)))];
    const knownSource = receipts.length > 0 && receipts.every(item => item.response?.provider === 'databento' && item.response?.dataset === 'GLBX.MDP3');
    const manifest = await buildBacktestDataManifest({
      source: { provider: 'databento', dataset: 'GLBX.MDP3', symbol: resolveMarketSymbol(root),
        basis: knownSource ? 'response' : 'configured-loader', ...(sourceSymbols.length === 1 ? { sourceSymbol: sourceSymbols[0] } : {}) },
      schema: 'ohlcv-1m', range: { startMs: run.startAt, endMs },
      candles: (snapshot.candles[root] ?? []).filter(bar => bar.time <= Number(horizon)),
      fetchedRanges: receipts.map(item => ({ startMs: Math.max(run.startAt, item.startMs), endMs: Math.min(endMs, item.endMs) })),
      calendar: input.calendar,
    });
    return { root, manifest, sourceSymbols,
      provenance: receipts.map(item => ({ root, schema: item.schema, purpose: item.purpose,
        range: { startMs: Math.max(run.startAt, item.startMs), endMs: Math.min(endMs, item.endMs) },
        provider: item.response?.provider ?? null, dataset: item.response?.dataset ?? null,
        symbol: item.response?.symbol ?? item.symbol, sourceSymbol: item.response?.sourceSymbol ?? null })),
    };
  }) : []);
  return { format: 'alphatrade-backtest-evidence' as const, version: 1 as const,
    runId: run.id, replayHorizonTime: horizon, executionProfile, manifests,
    limitations: ['Svíčky jsou po normalizaci, řazení a deduplikaci loaderu; původní vady feedu nelze zpětně dokázat.',
      'Přítomnost minutových svíček neprokazuje intrabar pořadí ani konkrétní futures kontrakt.',
      'Bez dodaného verzovaného kalendáře nelze mezeru označit jako svátek nebo výpadek.',
      'Kontrakt sourceSymbol je údaj vrácený loaderem; může zůstat spojitým symbolem a nepotvrzuje roll politiku.'],
  };
}
export type BacktestStoreEvidence = Awaited<ReturnType<typeof buildBacktestStoreEvidence>>;
