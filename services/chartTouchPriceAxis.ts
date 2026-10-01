import type { IChartApi } from 'lightweight-charts';

/**
 * Dotyková gesta grafu na telefonu: prst na grafu hýbe jen grafem.
 *
 * - `touch-action: none` — prohlížeč nad grafem nikdy nezačne scroll stránky
 *   (ani když stránka ještě dojíždí, ani pinch zoom celé stránky).
 *   Lightweight-charts sám brání scrollu až `preventDefault` v touchmove,
 *   což iOS u rozjetého gesta ignoruje.
 * - Svislé tahy patří grafu (`handleScroll.vertTouchDrag`). Lightweight-charts
 *   jinak bere každý tah strmější než ~27° jako scroll stránky a celé gesto
 *   zahodí — rychlé opakované šoupání palcem (do oblouku) pak „na chvíli
 *   přestane fungovat“. S automatickým měřítkem svislá složka cenou nehýbe;
 *   tah po cenové ose graf roztahuje.
 */
export function attachChartTouchGestures(chart: Pick<IChartApi, 'chartElement' | 'applyOptions'>): () => void {
  const element = chart.chartElement();
  const previousTouchAction = element.style.touchAction;
  element.style.touchAction = 'none';
  chart.applyOptions({ handleScroll: { vertTouchDrag: true } });
  return () => {
    element.style.touchAction = previousTouchAction;
  };
}
