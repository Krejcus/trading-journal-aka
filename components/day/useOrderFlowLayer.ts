import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { ISeriesApi } from 'lightweight-charts';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { orderFlowLink } from '../../lib/orderFlowLink';
import { OrderFlowArchiveView, OrderFlowCombined } from '../../lib/orderFlowArchive';
import type { OrderFlowReadable } from '../../lib/orderFlowStore';
import { indicatorVisibleOnTimeframe, type AlphaTradeIndicatorSettings } from '../../services/chartIndicatorSettings';
import { tradingDayKey } from '../../services/liquidityLevels';
import type { MarketTimeframe } from '../../services/marketDataCalculations';
import { createOrderFlowPrimitives, type OrderFlowPrimitives, type OrderFlowRange } from '../../services/orderFlowPrimitive';
import { orderFlowPriceRange } from '../../services/orderFlowProfile';

/** Kreslicí nástroj nataženého volume profilu (vlastní nástroj v liště kreslení, Měření → Volume profil). */
const RANGE_TOOL = 'VolumeProfile';
/** Za jak dlouho po poslední změně vybrané kresby se rámeček přichytí k cenovému rozsahu dat. */
const SNAP_DELAY_MS = 400;
/** Nejvýš tolik obchodních dnů archivu najednou (oddálený graf, mobilní data). */
const MAX_ARCHIVE_DAYS = 10;

/** Odkud graf bere order flow: `live` = služba + starší dny z archivu, `history` = jen archiv, null = nic. */
export type OrderFlowMode = 'live' | 'history' | null;

/** Obchodní dny (`tradingDayKey`) pokrývající úsek [fromSec, toSec], nejvýš `max` posledních. */
export function tradingDaysIn(fromSec: number, toSec: number, max = MAX_ARCHIVE_DAYS): string[] {
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec < fromSec) return [];
  const out = new Set<string>();
  const start = Math.max(fromSec, toSec - (max + 4) * 86_400);
  for (let t = start; t <= toSec; t += 6 * 3_600) out.add(tradingDayKey(t));
  out.add(tradingDayKey(toSec));
  const days = [...out].sort();
  return days.slice(Math.max(0, days.length - max));
}

/**
 * Indikátory Bubliny a Volume profil (PC i telefon) a natažený profil (nástroj Volume profil v liště kreslení).
 *  - `live`: data ze služby Rithmicu stávajícím spojením appky; odběr se přihlásí, jen když je některý indikátor
 *    zapnutý nebo je v grafu natažený úsek. Dny před začátkem dat služby doplní archiv.
 *  - `history` (deník, backtest, přehrávání): jen archiv ze Supabase; u přehrávání jen to, co je před kurzorem.
 * Vrstvy se připojí jednou a čtou přes refy — s tickem, se změnou nastavení ani při tažení úseku se
 * nepřestavují a graf se kvůli nim nepřekresluje v Reactu.
 *
 * JEN ZOBRAZENÍ (INV-UI-04): nic odsud nevstupuje do cen ani stavu pro příkazy.
 */
export function useOrderFlowLayer({ apiRef, apiEpoch, mode, cutoffMs = null, settings, timeframe, candlesRef, isDark, phone, leftInset = 0, onArchiveNote }: {
  apiRef: MutableRefObject<ChartViewApi | null>;
  /** Roste, když je graf (znovu) připravený. */
  apiEpoch: number;
  mode: OrderFlowMode;
  /** Přehrávání / backtest: hranice v ms, za kterou se nic neukáže. */
  cutoffMs?: number | null;
  settings: AlphaTradeIndicatorSettings;
  timeframe: MarketTimeframe;
  candlesRef: MutableRefObject<ReadonlyArray<{ time: number; high: number; low: number }>>;
  isDark: boolean;
  phone: boolean;
  /** Šířka pruhu vlevo pod lištou kreslení (px). */
  leftInset?: number;
  /** Poznámka do legendy (např. „bubliny přibližné“, „bez dat pro tento den“), null = nic. */
  onArchiveNote?: (note: string | null) => void;
}) {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  const darkRef = useRef(isDark);
  darkRef.current = isDark;
  const insetRef = useRef(leftInset);
  insetRef.current = leftInset;
  const noteRef = useRef(onArchiveNote);
  noteRef.current = onArchiveNote;
  const primitivesRef = useRef<OrderFlowPrimitives | null>(null);
  const rangesRef = useRef<readonly OrderFlowRange[]>([]);
  // Jen „je v grafu nějaký úsek“ — mění se zřídka. Samotné úseky (i při tažení) jdou přes ref.
  const [hasRanges, setHasRanges] = useState(false);

  // Archiv: jeden pohled na graf (vlastní výběr dnů a kurzor), společná mezipaměť dnů pro celou appku.
  const archive = useMemo(() => new OrderFlowArchiveView(), []);
  useEffect(() => archive.attach(), [archive]);
  const source: OrderFlowReadable | null = useMemo(
    () => (mode === 'live' ? new OrderFlowCombined(orderFlowLink.store, archive) : mode === 'history' ? archive : null),
    [mode, archive],
  );
  const sourceRef = useRef(source);
  sourceRef.current = source;
  useEffect(() => { archive.setCutoff(mode === 'history' ? cutoffMs : null); }, [archive, mode, cutoffMs]);

  const rangeTool = mode !== null;
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
      const store = sourceRef.current;
      const a = Number(drawing.points[0].time); const b = Number(drawing.points[1].time);
      if (!store?.symbol || !Number.isFinite(a) || !Number.isFinite(b)) return;
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
    // Data k právě nakreslenému úseku můžou dorazit až po něm (snímek, den archivu) — přichytit i potom.
    const unsubscribeData = source?.subscribe(() => {
      if (snapTimer === null && rangesRef.current.some((range) => range.selected)) snapTimer = setTimeout(snap, SNAP_DELAY_MS);
    });
    return () => { unsubscribe(); unsubscribeData?.(); if (snapTimer !== null) clearTimeout(snapTimer); };
  }, [apiRef, apiEpoch, rangeTool, source]);

  const bubblesOn = mode !== null && settings.bubbles.enabled;
  const profileOn = mode !== null && settings.volumeProfile.enabled;
  const wanted = bubblesOn || profileOn || (rangeTool && hasRanges);
  const sourceId = settings.bubbles.source;

  // Odběr u služby: jen v LIVE a jen dokud data někdo chce. Telefon si bere jen dnešek (mobilní data).
  useEffect(() => {
    if (!wanted || mode !== 'live') return undefined;
    return orderFlowLink.demand({ source: sourceId, days: phone ? 1 : 7 });
  }, [wanted, mode, sourceId, phone]);

  // Archiv: obchodní dny ve viditelné části grafu (v LIVE jen ty, které služba nemá).
  useEffect(() => {
    if (!wanted || mode === null) { archive.setDates([]); noteRef.current?.(null); return undefined; }
    const api = apiRef.current;
    if (!api) return undefined;
    let timeScale: ReturnType<ReturnType<typeof api.controller.getChart>['timeScale']>;
    try { timeScale = api.controller.getChart().timeScale(); } catch { return undefined; }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const visible = (): [number, number] | null => {
      const range = timeScale.getVisibleRange();
      if (!range) return null;
      return [Number(range.from), Number(range.to)];
    };
    const update = () => {
      timer = null;
      const span = visible();
      if (!span) return;
      let days = tradingDaysIn(span[0] - 86_400, span[1]);
      if (mode === 'live') {
        const live = orderFlowLink.store;
        if (live.complete && live.symbol) { const firstLive = tradingDayKey(live.from); days = days.filter((d) => d <= firstLive); }
      }
      if (phone) days = days.slice(-3);
      archive.setDates(days);
      // Poznámka do legendy podle toho, co je vidět.
      const [from, to] = span;
      const missing = archive.missingDates().filter((d) => days.includes(d));
      const loaded = archive.loadedDates();
      let note: string | null = null;
      if (mode === 'history' && loaded.length === 0 && missing.length > 0) note = 'bez dat pro tento den';
      else if (loaded.length > 0 && archive.approximateIn(from * 1_000, to * 1_000)) note = 'historie · bubliny přibližné';
      else if (loaded.length > 0) note = 'historie';
      noteRef.current?.(note);
    };
    const schedule = () => { if (timer === null) timer = setTimeout(update, 250); };
    update();
    timeScale.subscribeVisibleTimeRangeChange(schedule);
    const unsubscribeArchive = archive.subscribe(schedule);
    const unsubscribeLive = mode === 'live' ? orderFlowLink.store.subscribe(() => { if (orderFlowLink.store.complete) schedule(); }) : undefined;
    return () => {
      if (timer !== null) clearTimeout(timer);
      try { timeScale.unsubscribeVisibleTimeRangeChange(schedule); } catch { /* graf už je pryč */ }
      unsubscribeArchive(); unsubscribeLive?.();
    };
  }, [apiRef, apiEpoch, wanted, mode, archive, phone]);

  useEffect(() => {
    if (!wanted || !source) return undefined;
    const api = apiRef.current;
    if (!api) return undefined;
    let series: ISeriesApi<'Candlestick'>;
    let primitives: OrderFlowPrimitives;
    try {
      const chart = api.controller.getChart();
      series = api.controller.getSeries() as ISeriesApi<'Candlestick'>;
      primitives = createOrderFlowPrimitives({
        chart, series, store: source,
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
  }, [apiRef, apiEpoch, wanted, source, candlesRef]);

  // Změna nastavení, timeframu, vzhledu nebo kurzoru přehrávání: jen překreslit.
  useEffect(() => { primitivesRef.current?.invalidate(); }, [settings.bubbles, settings.volumeProfile, settings.levels, timeframe, isDark, leftInset, cutoffMs]);
}
