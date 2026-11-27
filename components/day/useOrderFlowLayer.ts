import { useEffect, useRef, type MutableRefObject } from 'react';
import type { ISeriesApi } from 'lightweight-charts';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { orderFlowLink } from '../../lib/orderFlowLink';
import { indicatorVisibleOnTimeframe, type AlphaTradeIndicatorSettings } from '../../services/chartIndicatorSettings';
import type { MarketTimeframe } from '../../services/marketDataCalculations';
import { createOrderFlowPrimitives, type OrderFlowPrimitives, type OrderFlowRange } from '../../services/orderFlowPrimitive';

/**
 * Indikátory Bubliny a Volume profil v LIVE grafu (PC i telefon). Data jdou z místní služby Rithmicu
 * stávajícím spojením appky; odběr se přihlásí, jen když je některý indikátor zapnutý (nebo je v grafu
 * natažený profil), a odhlásí, když je nikdo nechce. Vrstvy se připojí jednou a čtou přes refy —
 * s tickem ani se změnou nastavení se nepřestavují.
 *
 * JEN ZOBRAZENÍ (INV-UI-04): nic odsud nevstupuje do cen ani stavu pro příkazy.
 */
export function useOrderFlowLayer({ apiRef, apiEpoch, live, settings, timeframe, candlesRef, rangesRef, rangesKey = '', isDark, phone }: {
  apiRef: MutableRefObject<ChartViewApi | null>;
  /** Roste, když je graf (znovu) připravený. */
  apiEpoch: number;
  /** Graf s živým tokem a bez přehrávání — jinde order flow data nejsou. */
  live: boolean;
  settings: AlphaTradeIndicatorSettings;
  timeframe: MarketTimeframe;
  candlesRef: MutableRefObject<ReadonlyArray<{ time: number; high: number; low: number }>>;
  /** Natažené profily (kreslicí nástroj). */
  rangesRef?: MutableRefObject<readonly OrderFlowRange[]>;
  /** Mění se s úseky natažených profilů (počet a hranice) — spustí překreslení a případně odběr. */
  rangesKey?: string;
  isDark: boolean;
  phone: boolean;
}) {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  const darkRef = useRef(isDark);
  darkRef.current = isDark;
  const primitivesRef = useRef<OrderFlowPrimitives | null>(null);

  const bubblesOn = live && settings.bubbles.enabled;
  const profileOn = live && settings.volumeProfile.enabled;
  const rangesOn = live && rangesKey !== '';
  const wanted = bubblesOn || profileOn || rangesOn;
  const source = settings.bubbles.source;

  // Odběr u služby: jen dokud data někdo chce. Telefon si bere jen dnešek (mobilní data).
  useEffect(() => {
    if (!wanted) return undefined;
    return orderFlowLink.demand({ source, days: phone ? 1 : 7 });
  }, [wanted, source, phone]);

  useEffect(() => {
    if (!wanted) return undefined;
    const api = apiRef.current;
    if (!api) return undefined;
    let series: ISeriesApi<'Candlestick'>;
    let primitives: OrderFlowPrimitives;
    try {
      const chart = api.controller.getChart();
      series = api.controller.getSeries() as ISeriesApi<'Candlestick'>;
      primitives = createOrderFlowPrimitives({
        chart, series, store: orderFlowLink.store,
        bubbles: () => settingsRef.current.bubbles,
        profile: () => settingsRef.current.volumeProfile,
        levels: () => settingsRef.current.levels,
        timeframe: () => timeframeRef.current,
        showBubbles: () => settingsRef.current.bubbles.enabled && indicatorVisibleOnTimeframe(timeframeRef.current, settingsRef.current.bubbles.visibility),
        showProfile: () => settingsRef.current.volumeProfile.enabled && indicatorVisibleOnTimeframe(timeframeRef.current, settingsRef.current.volumeProfile.visibility),
        candles: () => candlesRef.current,
        ranges: () => rangesRef?.current ?? [],
        isDark: () => darkRef.current,
      });
      series.attachPrimitive(primitives.profile);
      series.attachPrimitive(primitives.bubbles);
    } catch {
      return undefined;
    }
    primitivesRef.current = primitives;
    return () => {
      primitivesRef.current = null;
      try { series.detachPrimitive(primitives.profile); } catch { /* graf už je pryč */ }
      try { series.detachPrimitive(primitives.bubbles); } catch { /* graf už je pryč */ }
      primitives.dispose();
    };
  }, [apiRef, apiEpoch, wanted, candlesRef, rangesRef]);

  // Změna nastavení, timeframu, vzhledu nebo natažených úseků: jen překreslit.
  useEffect(() => { primitivesRef.current?.invalidate(); }, [settings.bubbles, settings.volumeProfile, settings.levels, timeframe, isDark, rangesKey]);
}
