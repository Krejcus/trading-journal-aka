import { describe, expect, it, vi } from 'vitest';
import { createLivePositionBoxFollower, endedBoxPoints, LIVE_BOX_MAX_AGE_SECONDS, pickLivePositionBox, stretchedBoxPoints, type LiveBoxLink } from '../lib/livePositionBox';
import { ChartWorkspaceHistory, withoutChartHistory } from '../services/chartWorkspaceHistory';
import { createLiveExitAlertDetector } from '../lib/liveExitAlerts';
import { parseLiveChartAutomation } from '../services/liveChartAutomation';

const NOW = 1_800_000_000;
const box = (id: string, tool: string, entry: number, target: number, stop: number, time = NOW - 600, style: Record<string, unknown> = {}) => ({
  id,
  tool,
  style,
  points: [{ time, price: entry }, { time: time + 360, price: target }, { time: time + 360, price: stop }],
}) as never;

describe('pickLivePositionBox', () => {
  const long = { side: 'long' as const, entry: 100 };
  it('bere box stejného směru se vstupem mezi SL a TP', () => {
    const picked = pickLivePositionBox([box('short', 'ShortPosition', 100, 90, 110), box('long', 'LongPosition', 99, 120, 90)], long, NOW);
    expect((picked as unknown as { id: string }).id).toBe('long');
  });
  it('vstup mimo box, ukončený, automatický a starý box se nepoužijí', () => {
    expect(pickLivePositionBox([box('a', 'LongPosition', 150, 170, 140)], long, NOW)).toBeNull();
    expect(pickLivePositionBox([box('a', 'LongPosition', 99, 120, 90, NOW - 600, { liveEndedAt: NOW - 300 })], long, NOW)).toBeNull();
    expect(pickLivePositionBox([box('auto-1', 'LongPosition', 99, 120, 90)], long, NOW)).toBeNull();
    expect(pickLivePositionBox([box('a', 'LongPosition', 99, 120, 90, NOW - LIVE_BOX_MAX_AGE_SECONDS - 1)], long, NOW)).toBeNull();
  });
  it('z více boxů vyhraje nejbližší vstup, při shodě novější', () => {
    const near = box('near', 'LongPosition', 100, 120, 90);
    const far = box('far', 'LongPosition', 95, 120, 90);
    expect((pickLivePositionBox([far, near], long, NOW) as unknown as { id: string }).id).toBe('near');
    const newer = box('newer', 'LongPosition', 100, 120, 90, NOW - 60);
    expect((pickLivePositionBox([near, newer], long, NOW) as unknown as { id: string }).id).toBe('newer');
  });
});

describe('okraj boxu', () => {
  const points = [{ time: 1000, price: 100 }, { time: 1360, price: 120 }, { time: 1360, price: 90 }] as never[];
  it('roste s pozicí, plánovanou šířku nezkrátí a ceny nemění', () => {
    expect(stretchedBoxPoints(points, 1300)).toBeNull();
    const next = stretchedBoxPoints(points, 1500)! as { time: number; price: number }[];
    expect(next.map(point => point.time)).toEqual([1000, 1500, 1500]);
    expect(next.map(point => point.price)).toEqual([100, 120, 90]);
  });
  it('zavření okraj nastaví přesně, i kratší než plán, ale nikdy před vstup', () => {
    expect((endedBoxPoints(points, 1200)! as { time: number }[]).map(point => point.time)).toEqual([1000, 1200, 1200]);
    expect(endedBoxPoints(points, 900)).toBeNull();
    expect(endedBoxPoints(points, 1360)).toBeNull();
  });
});

describe('createLiveExitAlertDetector', () => {
  const t = 1_800_000_000_000;
  const exit = (id: string, exitReason: 'sl' | 'tp' | 'manual', at = t) => ({ id, kind: 'exit', at, exitReason });
  it('první seznam mlčí, nový zásah zazní jednou', () => {
    const detector = createLiveExitAlertDetector();
    expect(detector.step({ now: t, active: true, events: [exit('old', 'sl')] })).toBeNull();
    const events = [exit('old', 'sl'), exit('new', 'tp')];
    expect(detector.step({ now: t, active: true, events })).toBe('tp');
    expect(detector.step({ now: t, active: true, events })).toBeNull();
  });
  it('událost opravená z manual na SL zazní až po opravě', () => {
    const detector = createLiveExitAlertDetector();
    detector.step({ now: t, active: true, events: [] });
    expect(detector.step({ now: t, active: true, events: [exit('a', 'manual')] })).toBeNull();
    expect(detector.step({ now: t + 800, active: true, events: [exit('a', 'sl')] })).toBe('sl');
  });
  it('ruční zavření, staré události a doba vypnutí mlčí', () => {
    const detector = createLiveExitAlertDetector();
    detector.step({ now: t, active: true, events: [] });
    expect(detector.step({ now: t, active: true, events: [exit('m', 'manual')] })).toBeNull();
    expect(detector.step({ now: t + 31_000, active: true, events: [exit('stale', 'sl', t)] })).toBeNull();
    expect(detector.step({ now: t, active: false, events: [exit('off', 'tp')] })).toBeNull();
    expect(detector.step({ now: t, active: true, events: [exit('off', 'tp')] })).toBeNull();
  });
});

describe('parseLiveChartAutomation', () => {
  it('výchozí stav a poškozená data', () => {
    expect(parseLiveChartAutomation(null)).toEqual({ boxFollow: true, fillTone: null, slTone: null, tpTone: null });
    expect(parseLiveChartAutomation('{')).toEqual({ boxFollow: true, fillTone: null, slTone: null, tpTone: null });
  });
  it('neznámý tón zahodí, známý a vlastní nechá', () => {
    expect(parseLiveChartAutomation(JSON.stringify({ boxFollow: false, fillTone: 'confirmation_002', slTone: 'nic', tpTone: 'confirmation_001' })))
      .toEqual({ boxFollow: false, fillTone: 'confirmation_002', slTone: null, tpTone: 'confirmation_001' });
    expect(parseLiveChartAutomation(JSON.stringify({ slTone: 'custom:abc' })).slTone).toBe('custom:abc');
  });
});

const START = Date.UTC(2026, 10, 9, 15, 0, 30);
const minute = (ms: number) => Math.floor(ms / 60_000) * 60;
const longBox = () => {
  const time = minute(START) - 60;
  return { id: 'box', tool: 'LongPosition', style: {} as Record<string, unknown>, points: [{ time, price: 100 }, { time: time + 120, price: 120 }, { time: time + 120, price: 90 }] };
};
const OPEN = { key: 'open', summary: { kind: 'position', side: 'long', entry: 101 } } as never;
const FLAT = { key: 'none', summary: null } as never;
const UNVERIFIED = { key: 'issue:Pozice neověřené', summary: null } as never;

function follow(box: ReturnType<typeof longBox>) {
  let link: LiveBoxLink | null = null;
  const follower = createLivePositionBoxFollower({
    readLink: () => link,
    writeLink: value => { link = value; },
    silently: change => change(),
  });
  const engine = {
    getDrawings: () => [box],
    setPoints: (_id: string, points: unknown) => { box.points = points as typeof box.points; },
    setStyle: (_id: string, patch: never) => { box.style = { ...box.style, ...(patch as object) }; },
  };
  const panes = [{ engine, since: START }];
  return {
    link: () => link,
    step: (position: never, at: number, target = 'group', events?: { kind: string; at: number }[]) => follower.step({ now: at, position, target, events, panes }),
  };
}

describe('createLivePositionBoxFollower', () => {
  it('roste s pozicí a skončí s jejím zavřením', () => {
    const box = longBox();
    const run = follow(box);
    const during = START + 5 * 60_000;
    run.step(OPEN, during);
    expect(box.points[1].time).toBe(minute(during));
    expect(box.points[2].time).toBe(minute(during));
    const closed = during + 2 * 60_000;
    run.step(FLAT, closed);
    expect(box.points[1].time).toBe(minute(closed));
    expect(box.style.liveEndedAt).toBe(minute(closed));
    expect(run.link()).toBeNull();
    run.step(FLAT, closed + 5 * 60_000);
    expect(box.points[1].time).toBe(minute(closed));
  });

  it('neověřený stav box neukončí a po ověření roste dál', () => {
    const box = longBox();
    const run = follow(box);
    run.step(OPEN, START + 60_000);
    run.step(UNVERIFIED, START + 3 * 60_000);
    expect(box.style.liveEndedAt).toBeUndefined();
    run.step(OPEN, START + 4 * 60_000);
    expect(box.points[1].time).toBe(minute(START + 4 * 60_000));
  });

  it('přepnutí pohledu na účet bez pozice není zavření', () => {
    const box = longBox();
    const run = follow(box);
    run.step(OPEN, START + 60_000);
    run.step(FLAT, START + 2 * 60_000, '123');
    expect(box.style.liveEndedAt).toBeUndefined();
    run.step(FLAT, START + 3 * 60_000);
    expect(box.style.liveEndedAt).toBeDefined();
  });

  it('čas zavření z události jen čerstvé, stará událost je z minulého obchodu', () => {
    const fresh = longBox();
    const runFresh = follow(fresh);
    const at = START + 10 * 60_000;
    runFresh.step(OPEN, at);
    runFresh.step(FLAT, at + 60_000, 'group', [{ kind: 'exit', at: at - 30_000 }]);
    expect(fresh.points[1].time).toBe(minute(at - 30_000));
    const stale = longBox();
    const runStale = follow(stale);
    runStale.step(OPEN, at);
    runStale.step(FLAT, at + 60_000, 'group', [{ kind: 'exit', at: at - 600_000 }]);
    expect(stale.points[1].time).toBe(minute(at + 60_000));
  });

  it('otočení pozice ukončí starý box a nový long box se nepoužije pro short', () => {
    const box = longBox();
    const run = follow(box);
    run.step(OPEN, START + 60_000);
    run.step({ key: 'flip', summary: { kind: 'position', side: 'short', entry: 101 } } as never, START + 2 * 60_000);
    expect(box.style.liveEndedAt).toBeDefined();
    expect(run.link()).toBeNull();
  });

  it('čekající příkaz bez vazby na box nic nedělá', () => {
    const box = longBox();
    const run = follow(box);
    const edge = box.points[1].time;
    run.step({ key: 'p', summary: { kind: 'pending', side: 'long', entry: 101 } } as never, START + 10 * 60_000);
    expect(box.points[1].time).toBe(edge);
    expect(box.style.liveEndedAt).toBeUndefined();
  });
});

describe('withoutChartHistory', () => {
  it('programová změna kresby nezabere krok Zpět, uživatelská ano', () => {
    vi.useFakeTimers();
    const listeners = new Set<() => void>();
    const drawings = [longBox()];
    const engine = {
      getDrawings: () => drawings,
      onChange: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const history = new ChartWorkspaceHistory();
    history.updatePanels(new Map([['day', { drawingEngine: engine, chartApi: null }]]) as never);
    withoutChartHistory(() => {
      drawings[0] = { ...drawings[0], points: drawings[0].points.map(point => ({ ...point, time: point.time + 60 })) };
      listeners.forEach(listener => listener());
    });
    vi.advanceTimersByTime(5_000);
    expect(history.getState().canUndo).toBe(false);
    drawings[0] = { ...drawings[0], points: drawings[0].points.map(point => ({ ...point, price: point.price + 1 })) };
    listeners.forEach(listener => listener());
    vi.advanceTimersByTime(5_000);
    expect(history.getState().canUndo).toBe(true);
    vi.useRealTimers();
  });
});
