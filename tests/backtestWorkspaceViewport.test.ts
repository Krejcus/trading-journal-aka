import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('backtest workspace viewport stability', () => {
  it('does not couple chart trade metadata to runtime P&L updates', () => {
    const source = readFileSync('components/BacktestWorkspace.tsx', 'utf8');
    const syntheticTrade = source.slice(
      source.indexOf('const syntheticTrade = useMemo<Trade>'),
      source.indexOf('const closeWorkspace = useCallback'),
    );

    expect(syntheticTrade).toContain('pnl: 0');
    expect(syntheticTrade).not.toContain('run.runtimeState');
  });

  it('handles price-axis wheel zoom with a native non-passive listener', () => {
    const source = readFileSync('components/CandleKitTradeChart.tsx', 'utf8');

    expect(source).toContain("addEventListener('wheel', handlePriceScaleWheel, { capture: true, passive: false })");
    expect(source).not.toContain('handlePriceScaleWheel(event);');
  });
});
