import React, { useEffect, useState } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { ChevronsRight } from 'lucide-react';
import { isAwayFromNow, jumpToNow } from '../../lib/liveChartFollow';

const FALLBACK_SCALE_WIDTH = 60;
const FALLBACK_AXIS_HEIGHT = 28;
const EDGE_GAP = 8;

/**
 * Zobáček vpravo dole (Filip podle TradingView, 7. 11.): vidět jen s poslední
 * svíčkou mimo záběr, klepnutí plynule vrátí graf na ni. Jen zobrazení.
 */
const ChartJumpToNow: React.FC<{
  api: ChartViewApi | null;
  barCount: number;
  /** Místo nad spodními prvky grafu (obchodní lišta v LIVE). */
  liftPx?: number;
}> = ({ api, barCount, liftPx = 0 }) => {
  const [away, setAway] = useState(false);

  useEffect(() => {
    if (!api) {
      setAway(false);
      return;
    }
    const update = () => setAway(isAwayFromNow(api));
    update();
    const timeScale = api.controller.getChart().timeScale();
    timeScale.subscribeVisibleLogicalRangeChange(update);
    return () => {
      try { timeScale.unsubscribeVisibleLogicalRangeChange(update); } catch { /* graf už zanikl */ }
    };
  }, [api, barCount]);

  if (!away || !api) return null;
  let right = FALLBACK_SCALE_WIDTH;
  let bottom = FALLBACK_AXIS_HEIGHT;
  try {
    const chart = api.controller.getChart();
    right = chart.priceScale('right').width() || FALLBACK_SCALE_WIDTH;
    bottom = chart.timeScale().height() || FALLBACK_AXIS_HEIGHT;
  } catch { /* zůstává odhad */ }
  return (
    <button
      type="button"
      className="dj-btn"
      aria-label="Na aktuální cenu"
      onClick={() => jumpToNow(api)}
      style={{
        position: 'absolute', right: right + EDGE_GAP, bottom: bottom + EDGE_GAP + liftPx, zIndex: 21,
        width: 32, height: 32, padding: 0, borderRadius: 9, display: 'grid', placeItems: 'center',
        border: '1px solid var(--dj-line)', background: 'var(--dj-card)', color: 'var(--dj-text-2)',
        boxShadow: '0 1px 5px rgba(0,0,0,0.16)',
      }}
    >
      <ChevronsRight size={18} />
    </button>
  );
};

export default ChartJumpToNow;
