import { describe, expect, it } from 'vitest';
import {
  emptyOverlayArtifacts,
  releaseOverlayArtifacts,
  restartOverlayArtifacts,
  type OverlayArtifacts,
} from '../services/chartOverlayArtifacts';

type Primitive = { name: string };
type Line = { name: string };

/** Graf, který si pamatuje, co je k němu právě připojené. */
const fakeChart = () => {
  const primitives = new Set<Primitive>();
  const lines = new Set<Line>();
  const markers = new Set<string>();
  let destroyed = false;
  const series = {
    attachPrimitive: (primitive: Primitive) => { primitives.add(primitive); },
    detachPrimitive: (primitive: Primitive) => {
      if (destroyed) throw new Error('chart destroyed');
      primitives.delete(primitive);
    },
  };
  const chart = {
    addLine: (line: Line) => { lines.add(line); },
    removeSeries: (line: Line) => {
      if (destroyed) throw new Error('chart destroyed');
      lines.delete(line);
    },
  };
  const controller = { getChart: () => chart, getSeries: () => series };
  return {
    primitives, lines, markers, series, chart, controller,
    destroy: () => { destroyed = true; },
    /** ChartView vydává nový objekt api nad stejným controllerem. */
    newApi: () => ({ controller }),
  };
};

type Api = ReturnType<ReturnType<typeof fakeChart>['newApi']>;

/** Jedna přestavba vrstev tak, jak ji dělá graf po `onReady`. */
const rebuild = (
  graph: ReturnType<typeof fakeChart>,
  current: OverlayArtifacts<Api, Line, Primitive>,
  api: Api,
  round: number,
) => {
  const next = restartOverlayArtifacts(current, api);
  ['fvg', 'levels', 'position-progress'].forEach(name => {
    const primitive = { name: `${name}-${round}` };
    graph.series.attachPrimitive(primitive);
    next.primitives.push(primitive);
  });
  const line = { name: `vwap-${round}` };
  graph.chart.addLine(line);
  next.lines.push(line);
  const markerId = `markers-${round}`;
  graph.markers.add(markerId);
  next.markers.push({ detach: () => { graph.markers.delete(markerId); } });
  return next;
};

describe('chartOverlayArtifacts', () => {
  it('nové api nad stejným grafem nenechá staré vrstvy připojené (přepnutí timeframu v LIVE)', () => {
    const graph = fakeChart();
    let artifacts = emptyOverlayArtifacts<Api, Line, Primitive>();
    // 1m → 5m → 1m → 5m: pokaždé nový kreslicí ovladač = nový objekt api, graf zůstává.
    for (let round = 0; round < 4; round += 1) {
      artifacts = rebuild(graph, artifacts, graph.newApi(), round);
      expect([...graph.primitives].map(item => item.name)).toEqual([
        `fvg-${round}`, `levels-${round}`, `position-progress-${round}`,
      ]);
      expect([...graph.lines].map(item => item.name)).toEqual([`vwap-${round}`]);
      expect([...graph.markers]).toEqual([`markers-${round}`]);
    }
  });

  it('přestavba se stejným api taky nic nezdvojí', () => {
    const graph = fakeChart();
    const api = graph.newApi();
    let artifacts = emptyOverlayArtifacts<Api, Line, Primitive>();
    artifacts = rebuild(graph, artifacts, api, 0);
    artifacts = rebuild(graph, artifacts, api, 1);
    expect(graph.primitives.size).toBe(3);
    expect(graph.lines.size).toBe(1);
    expect(graph.markers.size).toBe(1);
  });

  it('zaniklý starý graf přestavbu nového neshodí', () => {
    const old = fakeChart();
    let artifacts = rebuild(old, emptyOverlayArtifacts<Api, Line, Primitive>(), old.newApi(), 0);
    old.destroy();
    const fresh = fakeChart();
    expect(() => { artifacts = rebuild(fresh, artifacts, fresh.newApi(), 1); }).not.toThrow();
    expect(fresh.primitives.size).toBe(3);
  });

  it('uvolnění bez grafu nic nedělá', () => {
    expect(() => releaseOverlayArtifacts(emptyOverlayArtifacts<Api, Line, Primitive>())).not.toThrow();
  });
});
