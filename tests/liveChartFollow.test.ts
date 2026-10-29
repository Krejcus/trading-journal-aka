import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { followLiveEdge, LIVE_FOLLOW_GAP_BARS, liveFollowShift, type LiveFollowMemory } from '../lib/liveChartFollow';

describe('liveFollowShift', () => {
  it('svíčka dojíždí, dokud je od okraje aspoň 10 svíček', () => {
    expect(liveFollowShift({ previousLastIndex: 100, lastIndex: 101, range: { from: 20, to: 115 } })).toBe(0);
    expect(liveFollowShift({ previousLastIndex: 100, lastIndex: 101, range: { from: 20, to: 111 } })).toBe(0);
  });

  it('pod 10 svíček od okraje graf posune tak, aby odstup držel', () => {
    expect(liveFollowShift({ previousLastIndex: 100, lastIndex: 101, range: { from: 20, to: 110 } })).toBe(1);
    // Výchozí záběr (pravý okraj 6 svíček) se s první novou svíčkou srovná na 10.
    expect(liveFollowShift({ previousLastIndex: 100, lastIndex: 101, range: { from: 20, to: 106 } })).toBe(5);
    // Svíčka u samého okraje (ještě vidět) se taky vrátí na 10.
    expect(liveFollowShift({ previousLastIndex: 100, lastIndex: 101, range: { from: 20, to: 100.2 } })).toBeCloseTo(LIVE_FOLLOW_GAP_BARS + 0.8);
    // Po návratu ze skryté karty (rAF stál) přijde víc svíček naráz — graf dojede za nimi.
    expect(liveFollowShift({ previousLastIndex: 100, lastIndex: 130, range: { from: 20, to: 104 } })).toBe(36);
  });

  it('v přiblíženém grafu drží odstup nejvýš 40 % záběru a zbytky nepočítá', () => {
    expect(liveFollowShift({ previousLastIndex: 100, lastIndex: 101, range: { from: 95, to: 103 } })).toBeCloseTo(1.2);
    expect(liveFollowShift({ previousLastIndex: 100, lastIndex: 101, range: { from: 20, to: 110.9999999 } })).toBe(0);
  });

  it('pohled do historie, nesmyslný skok ani beze změny záběrem nehýbe', () => {
    expect(liveFollowShift({ previousLastIndex: 100, lastIndex: 101, range: { from: 10, to: 80 } })).toBe(0);
    expect(liveFollowShift({ previousLastIndex: 100, lastIndex: 101, range: { from: 101, to: 180 } })).toBe(0);
    expect(liveFollowShift({ previousLastIndex: 100, lastIndex: 700, range: { from: 20, to: 104 } })).toBe(0);
    expect(liveFollowShift({ previousLastIndex: 100, lastIndex: 100, range: { from: 20, to: 104 } })).toBe(0);
    expect(liveFollowShift({ previousLastIndex: 100, lastIndex: 99, range: { from: 20, to: 104 } })).toBe(0);
  });
});

/**
 * Graf jako lightweight-charts 5: nová svíčka nemění logický záběr (CandleKit
 * neposouvá, knihovna vyrovná odsazení hned) a `scrollToPosition` se jen
 * zařadí — provede se až při vykreslení (`draw`).
 */
const fakeChart = (count: number, range: { from: number; to: number }) => {
  const MINUTE = Date.UTC(2026, 9, 29, 13, 0) / 1_000;
  let bars = Array.from({ length: count }, (_, index) => ({ ts: (MINUTE + index * 60) * 1_000, open: 1, high: 1, low: 1, close: 1 }));
  let offset = range.to - (count - 1);
  const width = range.to - range.from;
  let queued: number | null = null;
  const handlers = new Map<string, Set<() => void>>();
  const element = {
    contains: (node: unknown) => node === element,
    addEventListener: (type: string, fn: () => void) => { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type)!.add(fn); },
    removeEventListener: (type: string, fn: () => void) => { handlers.get(type)?.delete(fn); },
    fire: (type: string) => [...(handlers.get(type) ?? [])].forEach(fn => fn()),
    listeners: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  };
  const timeScale = {
    getVisibleLogicalRange: () => ({ from: bars.length - 1 + offset - width, to: bars.length - 1 + offset }),
    timeToIndex: (time: number) => {
      const index = bars.findIndex(bar => bar.ts === time * 1_000);
      return index < 0 ? null : index;
    },
    scrollPosition: () => offset,
    scrollToPosition: (position: number) => { queued = position; },
  };
  const chart = { timeScale: () => timeScale, chartElement: () => element };
  const controller = { getBars: () => bars, getChart: () => chart };
  return {
    api: { controller } as never,
    element,
    draw: () => { if (queued !== null) offset = queued; queued = null; },
    gap: () => offset,
    push: (n = 1) => {
      for (let i = 0; i < n; i += 1) bars = [...bars, { ts: bars.at(-1)!.ts + 60_000, open: 1, high: 1, low: 1, close: 1 }];
      offset -= n;
    },
  };
};

/** Snímky prohlížeče: nejdřív kreslí graf, pak běží zaregistrované callbacky. */
const frames = (reducedMotion: boolean) => {
  let now = 0;
  let nextId = 1;
  let pending: Array<[number, (time: number) => void]> = [];
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('window', {
    matchMedia: () => ({ matches: reducedMotion }),
    requestAnimationFrame: (fn: (time: number) => void) => { const id = nextId++; pending.push([id, fn]); return id; },
    cancelAnimationFrame: (id: number) => { pending = pending.filter(([key]) => key !== id); },
  });
  return {
    pending: () => pending.length,
    run: (chart: { draw: () => void }, count = 1) => {
      for (let i = 0; i < count; i += 1) {
        now += 16;
        chart.draw();
        const due = pending;
        pending = [];
        due.forEach(([, fn]) => fn(now));
      }
      chart.draw();
    },
  };
};

describe('followLiveEdge', () => {
  afterEach(() => vi.unstubAllGlobals());
  const notHeld = () => false;

  describe('bez animace', () => {
    let tick: ReturnType<typeof frames>;
    beforeEach(() => { tick = frames(true); });

    it('svíčky dojedou k odstupu 10 a pak graf jede s nimi', () => {
      const chart = fakeChart(100, { from: 20, to: 99 + 13 });
      const memory: LiveFollowMemory = new WeakMap();
      followLiveEdge(chart.api, '1m', memory, notHeld);
      const gaps: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        chart.push();
        followLiveEdge(chart.api, '1m', memory, notHeld);
        // Živá svíčka se během minuty překresluje — posun se nesmí opakovat.
        followLiveEdge(chart.api, '1m', memory, notHeld);
        tick.run(chart);
        gaps.push(chart.gap());
      }
      expect(gaps).toEqual([12, 11, 10, 10, 10]);
    });

    it('výchozí záběr s okrajem 6 svíček se s první novou svíčkou srovná na 10', () => {
      const chart = fakeChart(100, { from: 20, to: 99 + 6 });
      const memory: LiveFollowMemory = new WeakMap();
      followLiveEdge(chart.api, '1m', memory, notHeld);
      chart.push();
      followLiveEdge(chart.api, '1m', memory, notHeld);
      tick.run(chart);
      expect(chart.gap()).toBe(LIVE_FOLLOW_GAP_BARS);
    });

    it('pohled do historie ani změna timeframe záběrem nehýbou', () => {
      const memory: LiveFollowMemory = new WeakMap();
      const history = fakeChart(100, { from: 10, to: 60 });
      followLiveEdge(history.api, '1m', memory, notHeld);
      history.push();
      followLiveEdge(history.api, '1m', memory, notHeld);
      tick.run(history);
      expect(history.gap()).toBe(60 - 100);

      const switched = fakeChart(100, { from: 20, to: 104 });
      followLiveEdge(switched.api, '5m', memory, notHeld);
      switched.push();
      followLiveEdge(switched.api, '1m', memory, notHeld);
      tick.run(switched);
      expect(switched.gap()).toBe(4);
    });

    it('graf držený myší se neposune a dožene to s další svíčkou', () => {
      const chart = fakeChart(100, { from: 20, to: 99 + 10 });
      const memory: LiveFollowMemory = new WeakMap();
      followLiveEdge(chart.api, '1m', memory, notHeld);
      chart.push();
      followLiveEdge(chart.api, '1m', memory, element => element === (chart.element as unknown));
      tick.run(chart);
      expect(chart.gap()).toBe(9);
      chart.push();
      followLiveEdge(chart.api, '1m', memory, notHeld);
      tick.run(chart);
      expect(chart.gap()).toBe(LIVE_FOLLOW_GAP_BARS);
    });
  });

  describe('s animací', () => {
    let tick: ReturnType<typeof frames>;
    beforeEach(() => { tick = frames(false); });

    it('posune plynule po krocích až na odstup 10 a uklidí po sobě', () => {
      const chart = fakeChart(100, { from: 20, to: 99 + 10 });
      const memory: LiveFollowMemory = new WeakMap();
      followLiveEdge(chart.api, '1m', memory, notHeld);
      chart.push();
      followLiveEdge(chart.api, '1m', memory, notHeld);
      const seen: number[] = [];
      for (let i = 0; i < 20; i += 1) {
        tick.run(chart);
        seen.push(chart.gap());
      }
      expect(new Set(seen.map(gap => gap.toFixed(3))).size).toBeGreaterThan(3);
      expect(seen.every((gap, index) => index === 0 || gap >= seen[index - 1])).toBe(true);
      expect(chart.gap()).toBeCloseTo(LIVE_FOLLOW_GAP_BARS, 9);
      expect(chart.element.listeners()).toBe(0);
      expect(tick.pending()).toBe(0);
    });

    it('chycení grafu myší posun zastaví', () => {
      const chart = fakeChart(100, { from: 20, to: 99 + 10 });
      const memory: LiveFollowMemory = new WeakMap();
      followLiveEdge(chart.api, '1m', memory, notHeld);
      chart.push(3);
      followLiveEdge(chart.api, '1m', memory, notHeld);
      tick.run(chart, 3);
      chart.element.fire('pointerdown');
      const stopped = chart.gap();
      tick.run(chart, 20);
      expect(chart.gap()).toBe(stopped);
      expect(stopped).toBeGreaterThan(7);
      expect(stopped).toBeLessThan(LIVE_FOLLOW_GAP_BARS);
      expect(chart.element.listeners()).toBe(0);
    });

    it('nová svíčka uprostřed posunu skončí přesně na odstupu 10', () => {
      const chart = fakeChart(100, { from: 20, to: 99 + 6 });
      const memory: LiveFollowMemory = new WeakMap();
      followLiveEdge(chart.api, '1m', memory, notHeld);
      chart.push();
      followLiveEdge(chart.api, '1m', memory, notHeld);
      tick.run(chart, 4);
      chart.push();
      followLiveEdge(chart.api, '1m', memory, notHeld);
      tick.run(chart, 30);
      expect(chart.gap()).toBeCloseTo(LIVE_FOLLOW_GAP_BARS, 9);
      expect(chart.element.listeners()).toBe(0);
    });

    it('dohnání po skryté kartě skočí rovnou, bez animace', () => {
      const chart = fakeChart(100, { from: 20, to: 99 + 10 });
      const memory: LiveFollowMemory = new WeakMap();
      followLiveEdge(chart.api, '1m', memory, notHeld);
      chart.push(30);
      followLiveEdge(chart.api, '1m', memory, notHeld);
      tick.run(chart);
      expect(chart.gap()).toBe(LIVE_FOLLOW_GAP_BARS);
      expect(chart.element.listeners()).toBe(0);
    });
  });
});
