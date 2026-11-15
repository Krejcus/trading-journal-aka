import { advanceReplayTimeByInterval, type ChartReplayStepMinutes } from './chartReplay';
import type { MarketCandle, MarketDataSchema } from './marketData';
import {
  REPLAY_GO_TO_MARKET_GAP_SECONDS, replayTargetHasMarket, resolveReplayGoTo,
  type ReplayGoToRequest, type ReplayGoToResult, type ReplayGoToSettings,
} from './replayGoTo';

const DAY_MS = 86_400_000;
const FORWARD_CHUNK_MS = 3 * DAY_MS;

export interface ReplayDataAccess {
  candles: MarketCandle[];
  /** Exclusive end of continuous loaded coverage, including empty market periods. */
  loadedUntilMs: number;
  endMs: number;
  ensure: (endMs: number) => Promise<MarketCandle[]>;
  isCurrent?: () => boolean;
}

class SupersededReplayRequest extends Error {}
const checkCurrent = (access: ReplayDataAccess) => {
  if (access.isCurrent && !access.isCurrent()) throw new SupersededReplayRequest();
};

/** No cursor changes until the entire crossed interval has been loaded. */
export async function prepareBacktestReplayStep(
  access: ReplayDataAccess,
  cursorTime: number | null,
  stepMinutes: ChartReplayStepMinutes,
  steps = 1,
): Promise<number | null> {
  let candles = access.candles;
  let coveredUntil = access.loadedUntilMs;
  const target = cursorTime === null
    ? (candles[0]?.time ?? coveredUntil / 1_000)
    : cursorTime + Math.max(1, Math.floor(stepMinutes)) * 60 * Math.max(1, Math.floor(steps));
  for (;;) {
    checkCurrent(access);
    const next = advanceReplayTimeByInterval(candles, cursorTime, stepMinutes, steps);
    if (next !== null) return next;
    if (coveredUntil >= access.endMs) {
      // A large final step must still process the session's remaining bars.
      const last = candles.at(-1)?.time;
      return last !== undefined && (cursorTime === null || last > cursorTime) ? last : null;
    }
    const end = Math.min(access.endMs, Math.max(coveredUntil + FORWARD_CHUNK_MS, (target + 60) * 1_000));
    candles = await access.ensure(end);
    checkCurrent(access);
    coveredUntil = end;
  }
}

export async function prepareBacktestReplayGoTo(
  access: ReplayDataAccess,
  request: ReplayGoToRequest,
  options: { cursorTime: number | null; settings: ReplayGoToSettings; timeZone: string },
): Promise<ReplayGoToResult> {
  checkCurrent(access);
  let candles = access.candles;
  let coveredUntil = access.loadedUntilMs;
  const resolve = (target: ReplayGoToRequest, searchFromTime?: number) => resolveReplayGoTo(target, {
    ...options, candles, dataEndTime: Math.floor(access.endMs / 1_000), searchFromTime,
  });
  let result = resolve(request);
  if (request.kind !== 'price') {
    // Cíl může padnout na den bez obchodování (sobota, svátek). Pozná se to až
    // z dotažených dat: pak se hledá další výskyt, místo aby kurzor zůstal
    // viset v mrtvém čase za poslední páteční svíčkou.
    const gapMs = REPLAY_GO_TO_MARKET_GAP_SECONDS * 1_000;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      if (result.kind === 'error') return result;
      const targetTime = result.value.targetTime;
      // Dotáhnout i kousek za cíl: seance začínající přesně s otevřením trhu
      // má první svíčku až v cílovém čase.
      const neededUntil = Math.min(access.endMs, targetTime * 1_000 + (request.kind === 'time' ? gapMs : 0));
      if (neededUntil > coveredUntil) {
        candles = await access.ensure(neededUntil);
        checkCurrent(access);
        coveredUntil = neededUntil;
      }
      const knowable = targetTime * 1_000 + gapMs <= coveredUntil;
      if (request.kind !== 'time' || !knowable || replayTargetHasMarket(candles, targetTime)) {
        // Re-resolve against the returned source, not the pre-fetch React closure.
        return resolve({ kind: 'date', unixSeconds: targetTime });
      }
      result = resolve(request, targetTime);
    }
    return { kind: 'error', reason: 'invalid_target' };
  }
  if (!Number.isFinite(request.price)) return { kind: 'error', reason: 'invalid_target' };
  while (result.kind === 'error' && result.reason === 'price_not_reached' && coveredUntil < access.endMs) {
    checkCurrent(access);
    coveredUntil = Math.min(access.endMs, coveredUntil + FORWARD_CHUNK_MS);
    candles = await access.ensure(coveredUntil);
    checkCurrent(access);
    result = resolve(request);
  }
  return result;
}

/** Same request shares work; a newer request invalidates only the older commit. */
export class ReplayDataRequestCoordinator {
  private generation = 0;
  private active: { key: string; promise: Promise<void> } | null = null;

  get pending(): boolean { return this.active !== null; }

  cancel(): void {
    this.generation += 1;
    this.active = null;
  }

  run<T>(
    key: string,
    task: (isCurrent: () => boolean) => Promise<T>,
    commit: (value: T) => void,
    fail: (reason: unknown) => void,
    settled?: () => void,
  ): Promise<void> {
    if (this.active?.key === key) return this.active.promise;
    const generation = ++this.generation;
    const isCurrent = () => generation === this.generation;
    const promise = Promise.resolve().then(() => task(isCurrent)).then(value => {
      if (isCurrent()) commit(value);
    }).catch(reason => {
      if (isCurrent()) fail(reason);
    }).finally(() => {
      if (!isCurrent()) return;
      this.active = null;
      settled?.();
    });
    this.active = { key, promise };
    return promise;
  }
}

/** Load the missing revealed session prefix before asking for older context. */
export function backtestOlderHistoryRange(params: {
  requestedBeforeMs: number;
  loadedFromMs?: number;
  sessionStartMs: number;
  sessionLoadedFromMs: number;
  schema: MarketDataSchema;
}): { startMs: number; endMs: number; kind: 'session' | 'context' } {
  const sourceBoundary = Math.max(params.sessionStartMs, params.sessionLoadedFromMs);
  // Aggregated 4h/daily timestamps can precede the first underlying minute.
  // Use the source coverage boundary on the first request, not that label.
  const endMs = params.loadedFromMs ?? sourceBoundary;
  if (endMs > params.sessionStartMs) {
    return { startMs: Math.max(params.sessionStartMs, endMs - 7 * DAY_MS), endMs, kind: 'session' };
  }
  // `requestedBeforeMs` is a chart hint and may be rounded to an earlier
  // 4h/day label. Coverage boundaries must remain contiguous on every prepend.
  const contextEnd = Math.min(endMs, params.sessionStartMs);
  return {
    startMs: contextEnd - (params.schema === 'ohlcv-1h' ? 365 : 7) * DAY_MS,
    endMs: contextEnd,
    kind: 'context',
  };
}
