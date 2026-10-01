import type { IChartApi } from 'lightweight-charts';

/**
 * Telefon: tah prstem po cenové ose má graf roztáhnout nahoru/dolů (jako
 * v TradingView). Lightweight-charts ale v cenové ose bere svislý dotykový
 * tah jako scroll stránky, dokud je `handleScroll.vertTouchDrag` vypnutý —
 * a vypnutý zůstat musí, jinak by svislý tah přes graf přestal scrollovat
 * stránku. Zapne se proto jen na dobu dotyku, který začal na cenové ose.
 */
export function attachTouchPriceAxisScale(chart: Pick<IChartApi, 'chartElement' | 'priceScale' | 'applyOptions'>): () => void {
  const element = chart.chartElement();
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
    onEnd();
  };
}
