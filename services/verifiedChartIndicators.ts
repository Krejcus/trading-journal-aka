import { updateFairValueGapAccumulator, updateMarketStructureAccumulator, type FairValueGapAccumulator, type MarketStructureAccumulator, type MarketCandle } from './marketDataCalculations';
export interface VerifiedFvgState { state: FairValueGapAccumulator; input: Float64Array }
export interface VerifiedStructureState { state: MarketStructureAccumulator; input: Float64Array }

/** Tail checkpoints are safe only after verifying the complete unchanged prefix. */
function verifyPrefix(previous: { input: Float64Array } | null, candles: MarketCandle[]) {
  let reusable = !!previous && candles.length >= previous.input.length / 6;
  const input = new Float64Array(candles.length * 6);
  const prefixLength = Math.max(0, Math.min(candles.length, (previous?.input.length ?? 0) / 6) - 1);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const row = [c.time, c.open, c.high, c.low, c.close, c.volume];
    for (let j = 0; j < 6; j++) {
      input[i * 6 + j] = row[j];
      if (reusable && i < prefixLength && row[j] !== previous!.input[i * 6 + j]) reusable = false;
    }
  }
  return { reusable, input };
}
export function updateVerifiedFvg(previous: VerifiedFvgState | null, candles: MarketCandle[]): VerifiedFvgState {
  const { reusable, input } = verifyPrefix(previous, candles);
  return { state: updateFairValueGapAccumulator(reusable ? previous!.state : null, candles), input };
}
export function updateVerifiedStructure(previous: VerifiedStructureState | null, candles: MarketCandle[]): VerifiedStructureState {
  const { reusable, input } = verifyPrefix(previous, candles);
  return { state: updateMarketStructureAccumulator(reusable ? previous!.state : null, candles), input };
}
