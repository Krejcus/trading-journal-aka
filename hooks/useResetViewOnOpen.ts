import { useEffect, useRef } from 'react';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { resetChartView } from '../services/chartContextMenu';

/**
 * Po otevření grafu (backtest session, deník dneška) jednou srovnat záběr
 * jako „Reset chart view“: poslední svíčka u pravého okraje, výchozí šířka,
 * autoscale. Až po usazení grafu — výchozí záběr nastavuje graf v `onReady`
 * přes setTimeout(0). Rozhoduje se jen při otevření: pozdější změna
 * podmínky (výběr obchodu, jiný timeframe) už záběr nemění.
 */
export function useResetViewOnOpen(api: ChartViewApi | null, enabled: boolean, hasCandles: boolean): void {
  const decidedRef = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    if (decidedRef.current || !api || !hasCandles) return;
    let frame = 0;
    const timer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        decidedRef.current = true;
        if (!enabledRef.current) return;
        try { resetChartView(api); } catch { /* graf mezitím zanikl */ }
      });
    }, 0);
    return () => { window.clearTimeout(timer); window.cancelAnimationFrame(frame); };
  }, [api, hasCandles]);
}
