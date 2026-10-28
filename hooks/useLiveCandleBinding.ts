import { useEffect, useRef } from 'react';
import type { Bar } from '@getcandlekit/charts';
import type { ChartViewApi } from '@getcandlekit/charts/react';
import { LIVE_CANDLE_MAX_GAP_SEC, planLiveCandleUpdate, type LiveCandleFeed } from '../lib/liveCandleFeed';
import { timeframeMinutes, type MarketCandle, type MarketTimeframe } from '../services/marketData';

/**
 * Napojí živou svíčku na grafy: při každé změně zdroje (nejvýš 1× za snímek)
 * přepíše jejich poslední bar přímo v grafu — mimo React, bez překreslení
 * stránky. Jen zobrazení: data grafu (`rawCandles`) ani nic uloženého se
 * nemění; další obnova dat svíčku přepíše a hook ji hned vrátí. Když živá
 * cena zmizí (stojí, kanál vypnut), graf se vrátí přesně na svá data —
 * stará „živá“ svíčka nesmí zůstat nakreslená jako skutečná (INV-UI-01).
 */

export interface LiveCandleTarget {
  api: ChartViewApi | null;
  root: string;
  timeframe: MarketTimeframe;
  /** 1m svíčky, ze kterých graf skládá svůj timeframe. */
  rawCandles: readonly MarketCandle[];
}

type ChartController = ChartViewApi['controller'];

/** Co živá svíčka v grafu změnila — aby šlo vrátit přesně data grafu. */
export interface LiveCandleDrawn {
  appended: Set<number>;
  originals: Map<number, Bar>;
  last: string | null;
  /** Naposled nakreslené živé bary podle času — pro přenos přes výměnu dat. */
  bars: Map<number, Bar>;
}

const emptyDrawn = (): LiveCandleDrawn => ({ appended: new Set(), originals: new Map(), last: null, bars: new Map() });

/** Vrátí graf na jeho data (odebere připsané bary, obnoví přepsané). */
export function revertLiveCandle(controller: ChartController, drawn: LiveCandleDrawn): void {
  try {
    const bars = controller.getBars()
      .filter(bar => !drawn.appended.has(bar.ts))
      .map(bar => drawn.originals.get(bar.ts) ?? bar);
    // Záběr nechat přesně, jak je — knihovna by při setData držela pravý okraj.
    const timeScale = controller.getChart().timeScale();
    const range = timeScale.getVisibleLogicalRange();
    controller.setData(bars);
    if (range) timeScale.setVisibleLogicalRange({ from: range.from, to: range.to });
  } catch {
    // Graf už neexistuje.
  }
}

export function applyLiveCandle(feed: LiveCandleFeed, target: LiveCandleTarget, drawnByController: Map<ChartController, LiveCandleDrawn>): void {
  const api = target.api;
  if (!api) return;
  try {
    const controller = api.controller;
    const drawn = drawnByController.get(controller);
    const live = feed.current(target.root);
    if (!live) {
      if (drawn) {
        drawnByController.delete(controller);
        revertLiveCandle(controller, drawn);
      }
      return;
    }
    const lastBar = controller.getBars().at(-1);
    const bar = planLiveCandleUpdate({ lastBar, live, timeframe: target.timeframe, rawCandles: target.rawCandles });
    if (!bar || !lastBar) return;
    // Beze změny baru nic nepřekreslovat (emit storu jen s čítači, heartbeat).
    const signature = `${bar.time}:${bar.open}:${bar.high}:${bar.low}:${bar.close}:${bar.volume}`;
    const state = drawn ?? emptyDrawn();
    if (state.last === signature) return;
    const ts = bar.time * 1_000;
    let written: Bar = { ts, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
    if (lastBar.ts === ts) {
      if (!state.originals.has(ts) && !state.appended.has(ts)) {
        state.originals.set(ts, { ...lastBar });
        // Vyšší timeframe: bar dat už obsahuje dokončené minuty, které
        // `rawCandles` cíle ještě nemusí znát (cíle jdou ve workspace o
        // commit později) — rozsah z dat se nesmí ztratit.
        if (timeframeMinutes(target.timeframe) !== 1) {
          written = { ...written, open: lastBar.open, high: Math.max(written.high, lastBar.high), low: Math.min(written.low, lastBar.low) };
        }
      }
    } else {
      state.appended.add(ts);
    }
    controller.updateBar(written);
    state.bars.set(ts, written);
    state.last = signature;
    drawnByController.set(controller, state);
  } catch {
    // Graf se právě přestavuje (jiný timeframe, nová data).
  }
}

/**
 * Nová data ještě nemají dokončené živé bary: na přelomu minuty server minutu
 * dodá až za desítky sekund a jeho poslední bar bývá nedokončený (naměřeno
 * 28. 10.: minuta 12:18 v datech s low o 5,75 bodu výš než skutečné, opravená
 * až další obnovou). Živé bary od posledního baru dat dál se proto vrátí —
 * jinak by v grafu chyběla svíčka nebo se zkrátil knot a FVG z nich
 * přeskakovalo. Poslední bar dat přebije živý jen na 1m (vyšší timeframe
 * skládá bar z minut dat). Jen navazující bary a jen při živé ceně; záznam
 * je vrací na data při výpadku ceny, data vyhrají, jakmile mají novější bar
 * (INV-UI-01).
 */
function carryFinishedLiveBars(
  feed: LiveCandleFeed,
  target: LiveCandleTarget,
  controller: ChartController,
  previous: LiveCandleDrawn,
  drawnByController: Map<ChartController, LiveCandleDrawn>,
): void {
  try {
    if (!feed.current(target.root)) return;
    const dataLast = controller.getBars().at(-1);
    if (!dataLast) return;
    const minutes = timeframeMinutes(target.timeframe);
    if (!Number.isFinite(minutes)) return;
    const replaceLast = minutes === 1;
    const carried = [...previous.bars.values()]
      .filter(bar => bar.ts > dataLast.ts || (replaceLast && bar.ts === dataLast.ts))
      .sort((a, b) => a.ts - b.ts);
    if (!carried.length) return;
    const maxStep = (minutes * 60 + LIVE_CANDLE_MAX_GAP_SEC) * 1_000;
    const state = emptyDrawn();
    let lastTs = dataLast.ts;
    for (const bar of carried) {
      if (bar.ts === dataLast.ts) {
        const written = { ...bar, volume: dataLast.volume ?? bar.volume };
        state.originals.set(bar.ts, { ...dataLast });
        controller.updateBar(written);
        state.bars.set(bar.ts, written);
        continue;
      }
      if (bar.ts - lastTs > maxStep) break;
      controller.updateBar(bar);
      state.appended.add(bar.ts);
      state.bars.set(bar.ts, bar);
      lastTs = bar.ts;
    }
    if (state.bars.size) drawnByController.set(controller, state);
  } catch {
    // Graf se právě přestavuje.
  }
}

/**
 * Graf nastavil data znovu (obnova dat, `setData`) a živou svíčku tím zahodil:
 * záznam změn pro něj neplatí. Svíčka se vrátí hned v témže kroku — počkat na
 * další snímek znamenalo, že graf aspoň na snímek ukázal data bez ní a svíčka
 * i FVG z ní problikly. `active` je vypnuté, když se grafy vrací na data
 * (vypnutý feed) — návrat dat svíčku zpátky kreslit nesmí.
 */
export function bindLiveCandleDataResets(
  feed: LiveCandleFeed,
  targets: () => readonly LiveCandleTarget[],
  drawnByController: Map<ChartController, LiveCandleDrawn>,
  active: () => boolean,
): () => void {
  const offs = targets().map(target => {
    const controller = target.api?.controller;
    if (!controller) return () => undefined;
    return controller.bus.on('data', () => {
      const previous = drawnByController.get(controller);
      drawnByController.delete(controller);
      if (!active()) return;
      const current = targets().find(item => item.api?.controller === controller) ?? target;
      if (previous) carryFinishedLiveBars(feed, current, controller, previous, drawnByController);
      applyLiveCandle(feed, current, drawnByController);
    });
  });
  return () => offs.forEach(off => off());
}

/**
 * Nové cíle (jiná data, jiný graf): přepočítat živou svíčku s nimi. Záznam
 * změn grafů, které zůstaly, platí dál — jejich data mění jen `setData`
 * (viz `bindLiveCandleDataResets`). Smazat ho by po výpadku ceny nechalo
 * živou svíčku nakreslenou jako skutečnou (INV-UI-01). Graf, který z cílů
 * vypadl, se vrátí na svá data (zrušený graf návrat tiše přeskočí).
 */
export function refreshLiveCandleTargets(targets: readonly LiveCandleTarget[], drawnByController: Map<ChartController, LiveCandleDrawn>): void {
  const controllers = new Set(targets.map(target => target.api?.controller).filter(Boolean));
  drawnByController.forEach((drawn, controller) => {
    if (controllers.has(controller)) {
      drawn.last = null;
      return;
    }
    drawnByController.delete(controller);
    revertLiveCandle(controller, drawn);
  });
}

// Identita grafu a jeho dat: nová data (i se stejnou délkou) graf nastaví znovu.
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
const objectId = (value: object | null) => {
  if (!value) return 0;
  let id = objectIds.get(value);
  if (!id) {
    id = nextObjectId++;
    objectIds.set(value, id);
  }
  return id;
};

export function useLiveCandleBinding(feed: LiveCandleFeed | null, targets: readonly LiveCandleTarget[]): void {
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const scheduleRef = useRef<() => void>(() => undefined);
  const drawnRef = useRef(new Map<ChartController, LiveCandleDrawn>());
  const activeFeedRef = useRef<LiveCandleFeed | null>(null);
  useEffect(() => {
    if (!feed) return;
    activeFeedRef.current = feed;
    let frame = 0;
    const apply = () => {
      frame = 0;
      for (const target of targetsRef.current) applyLiveCandle(feed, target, drawnRef.current);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(apply);
    };
    scheduleRef.current = schedule;
    const unsubscribe = feed.subscribe(schedule);
    schedule();
    return () => {
      activeFeedRef.current = null;
      unsubscribe();
      if (frame) window.cancelAnimationFrame(frame);
      scheduleRef.current = () => undefined;
      // Feed vypnut (přehrávání, konec dne): grafy zpět na jejich data.
      drawnRef.current.forEach((drawn, controller) => revertLiveCandle(controller, drawn));
      drawnRef.current.clear();
    };
  }, [feed]);
  // Nový graf nebo nová data: překreslit živou svíčku hned, ne až s další cenou.
  const key = targets.map(target => `${objectId(target.api)}:${target.root}:${target.timeframe}:${objectId(target.rawCandles)}`).join('|');
  useEffect(() => {
    refreshLiveCandleTargets(targetsRef.current, drawnRef.current);
    scheduleRef.current();
  }, [feed, key]);
  // Odběr jen podle grafů, ne podle dat: React ruší efekty celého stromu dřív,
  // než graf (potomek) nastaví nová data — odběr navázaný na data by u
  // `setData` ve stejném commitu chyběl.
  const chartsKey = targets.map(target => objectId(target.api?.controller ?? null)).join('|');
  useEffect(() => {
    if (!feed) return undefined;
    return bindLiveCandleDataResets(feed, () => targetsRef.current, drawnRef.current, () => activeFeedRef.current === feed);
  }, [feed, chartsKey]);
}
