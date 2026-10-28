import { beforeEach, describe, expect, it } from 'vitest';
import { LIVE_IBKR_FALLBACK_MEMORY_MS, observeLivePriceSource, resetLivePriceSourceFallback } from '../lib/livePriceSourceFallback';

beforeEach(() => resetLivePriceSourceFallback());

describe('záloha TradingView místo IBKR (jen štítek)', () => {
  it('TV bez předchozího IBKR není záloha (worker jen s TV)', () => {
    expect(observeLivePriceSource('CME_MINI:MNQ1!', 1_000)).toBe(false);
  });

  it('TV po IBKR = záloha; po návratu IBKR zase ne; po 6 h bez IBKR už ne', () => {
    expect(observeLivePriceSource('IBKR:MNQZ2026', 1_000)).toBe(false);
    expect(observeLivePriceSource('CME_MINI:MNQ1!', 2_000)).toBe(true);
    expect(observeLivePriceSource('IBKR:MNQZ2026', 3_000)).toBe(false);
    expect(observeLivePriceSource('CME_MINI:MNQ1!', 3_000 + LIVE_IBKR_FALLBACK_MEMORY_MS + 1)).toBe(false);
    expect(observeLivePriceSource(null, 4_000)).toBe(false);
  });
});
