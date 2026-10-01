import type { IChartApi } from 'lightweight-charts';

/**
 * Dotyková gesta grafu na telefonu.
 *
 * 1) Prst na grafu = stránka stojí. Lightweight-charts brání scrollu stránky
 *    až přes `preventDefault` v touchmove; když stránka ještě dojíždí po
 *    scrollu nebo je tah rychlý a šikmý, iOS gesto převezme dřív a pohne se
 *    stránka místo grafu. `touch-action: none` to rozhodne už v prohlížeči —
 *    nad grafem nikdy nezačne scroll stránky (ani pinch zoom celé stránky).
 *    Svislý tah po ploše grafu tak nedělá nic (graf drží automatické měřítko).
 *
 * 2) Tah po cenové ose roztahuje graf (jako v TradingView). Lightweight-charts
 *    ho v ose bere jako scroll stránky, dokud je `handleScroll.vertTouchDrag`
 *    vypnutý — ten zůstává vypnutý (svislý tah po grafu by ho jinak posouval)
 *    a zapne se jen na dobu dotyku, který začal na cenové ose.
 */
export function attachTouchPriceAxisScale(chart: Pick<IChartApi, 'chartElement' | 'priceScale' | 'applyOptions'>): () => void {
  const element = chart.chartElement();
  const previousTouchAction = element.style.touchAction;
  element.style.touchAction = 'none';
  let active = false;
  const onStart = (event: TouchEvent) => {
    if (event.touches.length !== 1) return;
    let width = 0;
    try { width = chart.priceScale('right').width(); } catch { return; }
    if (!(width > 0)) return;
    const rect = element.getBoundingClientRect();
    const x = event.touches[0].clientX;
    if (x < rect.right - width || x > rect.right) return;
    active = true;
    chart.applyOptions({ handleScroll: { vertTouchDrag: true } });
  };
  const onEnd = () => {
    if (!active) return;
    active = false;
    chart.applyOptions({ handleScroll: { vertTouchDrag: false } });
  };
  // Capture: přepnout dřív, než dotyk zpracuje cenová osa grafu.
  element.addEventListener('touchstart', onStart, { capture: true, passive: true });
  element.addEventListener('touchend', onEnd, { capture: true, passive: true });
  element.addEventListener('touchcancel', onEnd, { capture: true, passive: true });
  return () => {
    element.removeEventListener('touchstart', onStart, { capture: true });
    element.removeEventListener('touchend', onEnd, { capture: true });
    element.removeEventListener('touchcancel', onEnd, { capture: true });
    element.style.touchAction = previousTouchAction;
    onEnd();
  };
}
