import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ISeriesApi } from 'lightweight-charts';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { orderFlowLink } from '../../lib/orderFlowLink';
import { indicatorVisibleOnTimeframe, type AlphaTradeIndicatorSettings } from '../../services/chartIndicatorSettings';
import type { MarketTimeframe } from '../../services/marketDataCalculations';
import { createOrderFlowPrimitives, type OrderFlowPrimitives, type OrderFlowRange } from '../../services/orderFlowPrimitive';
import { orderFlowPriceRange } from '../../services/orderFlowProfile';

/** Kreslicí nástroj nataženého volume profilu (vlastní nástroj v liště kreslení, Měření → Volume profil). */
const RANGE_TOOL = 'VolumeProfile';
/** Za jak dlouho po poslední změně vybrané kresby se rámeček přichytí k cenovému rozsahu dat. */
const SNAP_DELAY_MS = 400;

/**
 * Indikátory Bubliny a Volume profil v LIVE grafu (PC i telefon) a natažený profil (nástroj Volume
 * profil v liště kreslení). Data jdou z místní služby Rithmicu stávajícím spojením appky; odběr se přihlásí,
 * jen když je některý indikátor zapnutý nebo je v grafu natažený úsek, a odhlásí, když je nikdo
 * nechce. Vrstvy se připojí jednou a čtou přes refy — s tickem, se změnou nastavení ani při tažení
 * úseku se nepřestavují a graf se kvůli nim nepřekresluje v Reactu.
 *
 * JEN ZOBRAZENÍ (INV-UI-04): nic odsud nevstupuje do cen ani stavu pro příkazy.
 */
export function useOrderFlowLayer({ apiRef, apiEpoch, live, settings, timeframe, candlesRef, isDark, phone, leftInset = 0 }: {
  apiRef: MutableRefObject<ChartViewApi | null>;
  /** Roste, když je graf (znovu) připravený. */
  apiEpoch: number;
  /** Graf s živým tokem a bez přehrávání — jinde order flow data nejsou. */
  live: boolean;
  settings: AlphaTradeIndicatorSettings;
  timeframe: MarketTimeframe;
  candlesRef: MutableRefObject<ReadonlyArray<{ time: number; high: number; low: number }>>;
  isDark: boolean;
  phone: boolean;
  /** Šířka pruhu vlevo pod lištou kreslení (px). */
  leftInset?: number;
}) {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  const darkRef = useRef(isDark);
  darkRef.current = isDark;
  const insetRef = useRef(leftInset);
  insetRef.current = leftInset;
  const primitivesRef = useRef<OrderFlowPrimitives | null>(null);
  const rangesRef = useRef<readonly OrderFlowRange[]>([]);
  // Jen „je v grafu nějaký úsek“ — mění se zřídka. Samotné úseky (i při tažení) jdou přes ref.
  const [hasRanges, setHasRanges] = useState(false);

  const rangeTool = live;
  useEffect(() => {
    const engine = rangeTool ? apiRef.current?.drawing?.engine : null;
    if (!engine) { rangesRef.current = []; setHasRanges(false); primitivesRef.current?.invalidate(); return undefined; }
    let snapTimer: ReturnType<typeof setTimeout> | null = null;
    /**
     * Rámeček kresby si uživatel natáhne přes čas; výška se po chvíli klidu přichytí k nejvyšší a nejnižší
     * ceně, na které se v úseku obchodovalo — tak jde profil vybrat a posouvat klepnutím kamkoli do něj.
     * Jen u kresby vybrané TADY (právě nakreslená nebo upravovaná): kresby z jiného zařízení se nepřepisují,
     * aby se dvě zařízení s různě dlouhou historií o výšku nepřetahovala.
     */
    const snap = () => {
      snapTimer = null;
      if (engine.getDraft() !== null || engine.getActiveTool() !== null) return;
      const id = engine.getSelectedId();
      const drawing = id ? engine.getById(id) : undefined;
      if (!drawing || drawing.tool !== RANGE_TOOL || drawing.points.length < 2) return;
      const store = orderFlowLink.store;
      const a = Number(drawing.points[0].time); const b = Number(drawing.points[1].time);
      if (!store.symbol || !Number.isFinite(a) || !Number.isFinite(b)) return;
      const range = orderFlowPriceRange(store, Math.floor(Math.min(a, b) / 60) * 60, Math.floor(Math.max(a, b) / 60) * 60 + 60);
      if (!range) return;
      const tick = store.tickSize;
      const top = range.high + tick / 2; const bottom = range.low - tick / 2;
      const current = [Number(drawing.points[0].price), Number(drawing.points[1].price)];
      if (Math.abs(Math.max(...current) - top) < tick / 2 && Math.abs(Math.min(...current) - bottom) < tick / 2) return;
      engine.setPoints(drawing.id, [{ ...drawing.points[0], price: top }, { ...drawing.points[1], price: bottom }]);
    };
    const sync = () => {
      const selected = engine.getSelectedId();
      const draft = engine.getDraft();
      const ranges: OrderFlowRange[] = [];
      for (const drawing of [...engine.getDrawings(), ...(draft ? [draft] : [])]) {
        if (drawing.tool !== RANGE_TOOL || drawing.points.length < 2) continue;
        const a = Number(drawing.points[0].time); const b = Number(drawing.points[1].time);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) continue;
        ranges.push({ id: drawing.id, from: Math.min(a, b), to: Math.max(a, b), selected: drawing.id === selected });
      }
      rangesRef.current = ranges;
      setHasRanges(ranges.length > 0);
      primitivesRef.current?.invalidate();
      if (ranges.some((range) => range.selected)) {
        if (snapTimer !== null) clearTimeout(snapTimer);
        snapTimer = setTimeout(snap, SNAP_DELAY_MS);
      }
    };
    sync();
    const unsubscribe = engine.onChange(sync);
    // Data k právě nakreslenému úseku můžou dorazit až po něm (snímek) — přichytit i potom.
    const unsubscribeData = orderFlowLink.store.subscribe(() => {
      if (snapTimer === null && rangesRef.current.some((range) => range.selected)) snapTimer = setTimeout(snap, SNAP_DELAY_MS);
    });
    return () => { unsubscribe(); unsubscribeData(); if (snapTimer !== null) clearTimeout(snapTimer); };
  }, [apiRef, apiEpoch, rangeTool]);

  const bubblesOn = live && settings.bubbles.enabled;
  const profileOn = live && settings.volumeProfile.enabled;
  const wanted = bubblesOn || profileOn || (rangeTool && hasRanges);
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
        // Natažené úseky se řídí viditelností profilu podle timeframu.
        ranges: () => (indicatorVisibleOnTimeframe(timeframeRef.current, settingsRef.current.volumeProfile.visibility) ? rangesRef.current : []),
        isDark: () => darkRef.current,
        leftInset: () => insetRef.current,
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
  }, [apiRef, apiEpoch, wanted, candlesRef]);

  // Změna nastavení, timeframu nebo vzhledu: jen překreslit.
  useEffect(() => { primitivesRef.current?.invalidate(); }, [settings.bubbles, settings.volumeProfile, settings.levels, timeframe, isDark, leftInset]);
}
