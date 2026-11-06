import { describe, expect, it, vi } from 'vitest';
import { DrawingController, DrawingEngine, type Drawing } from '@getcandlekit/charts';

// Záplata knihovny (patches/@getcandlekit+charts): nástroj Path s libovolným
// počtem bodů a režimy kurzoru jako v TradingView (guma maže kliknutím).
const controllerFor = (engine: DrawingEngine) => {
  const controller = new DrawingController({ engine }) as any;
  controller.unproject = (x: number, y: number) => ({ time: x, price: y });
  controller.project = (point: { time: number; price: number }) => ({ x: point.time, y: point.price });
  controller.chart = { applyOptions: vi.fn() };
  controller.setCursor = vi.fn();
  controller.primitive = { setHovered: vi.fn() };
  return controller;
};

const click = (controller: any, x: number, y: number, button = 0) => controller.onDown({
  offsetX: x,
  offsetY: y,
  button,
  preventDefault: vi.fn(),
  stopPropagation: vi.fn(),
});

const line = (id: string): Drawing => ({
  id,
  tool: 'TrendLine',
  points: [{ time: 10, price: 10 }, { time: 50, price: 10 }],
  style: { color: '#2962ff', width: 1, dashed: false, fill: 'transparent' },
});

describe('CandleKit Path', () => {
  it('sbírá body, dokud ho dvojklik neukončí, a druhý klik dvojkliku bod nepřidá', () => {
    const engine = new DrawingEngine();
    const controller = controllerFor(engine);
    engine.startTool('Path');

    click(controller, 10, 10);
    controller.onMove({ offsetX: 40, offsetY: 30 });
    click(controller, 40, 30);
    click(controller, 70, 5);
    click(controller, 100, 20);
    // Druhý klik dvojkliku nemusí trefit stejný pixel — stačí okruh 8 px.
    click(controller, 105, 24);

    const [path] = engine.getDrawings();
    expect(path.tool).toBe('Path');
    expect(path.points).toEqual([
      { time: 10, price: 10 },
      { time: 40, price: 30 },
      { time: 70, price: 5 },
      { time: 100, price: 20 },
    ]);
    expect(engine.getActiveTool()).toBeNull();
  });

  it('pomalý druhý klik nebo klik dál než 8 px je další bod', () => {
    const engine = new DrawingEngine();
    const controller = controllerFor(engine);
    engine.startTool('Path');
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    click(controller, 10, 10);
    now.mockReturnValue(1_100);
    click(controller, 30, 10);
    now.mockReturnValue(2_000);
    click(controller, 32, 12);
    expect(engine.getDrawings()).toHaveLength(0);
    now.mockReturnValue(2_100);
    click(controller, 34, 13);
    now.mockRestore();
    // Body 30/10 a 32/12 jsou blíž než 4 px — při ukončení se sloučí.
    expect(engine.getDrawings()[0]?.points).toEqual([
      { time: 10, price: 10 },
      { time: 30, price: 10 },
    ]);
  });

  it('pravé tlačítko cestu ukončí a spolkne kontextové menu grafu', () => {
    const engine = new DrawingEngine();
    const controller = controllerFor(engine);
    engine.startTool('Path');
    click(controller, 10, 10);
    click(controller, 60, 40);
    click(controller, 90, 10, 2);
    expect(engine.getDrawings()[0]?.points).toEqual([
      { time: 10, price: 10 },
      { time: 60, price: 40 },
    ]);
    expect(controller.swallowContextUntil).toBeGreaterThan(Date.now());
  });

  it('Enter dokončí cestu, jeden bod se zahodí', () => {
    const engine = new DrawingEngine();
    const controller = controllerFor(engine);
    engine.startTool('Path');
    click(controller, 10, 10);
    controller.onKey({ key: 'Enter', preventDefault: vi.fn(), target: null });
    expect(engine.getDrawings()).toHaveLength(0);
    expect(engine.getDraft()).toBeNull();

    engine.startTool('Path');
    click(controller, 10, 10);
    click(controller, 60, 40);
    controller.onKey({ key: 'Enter', preventDefault: vi.fn(), target: null });
    expect(engine.getDrawings()[0]?.points).toHaveLength(2);
  });

  it('nástroje s pevným počtem bodů dvojklik neukončí', () => {
    const engine = new DrawingEngine();
    const controller = controllerFor(engine);
    engine.startTool('Triangle');
    click(controller, 10, 10);
    expect(controller.finishOpenDraft()).toBe(false);
    expect(engine.getDraft()).not.toBeNull();
  });

  it('trefí každý úsek cesty, ne jen první', () => {
    const engine = new DrawingEngine();
    engine.commit({
      id: 'path',
      tool: 'Path',
      points: [{ time: 0, price: 0 }, { time: 100, price: 0 }, { time: 100, price: 100 }],
      style: { color: '#2962ff', width: 1, dashed: false, fill: 'transparent' },
    });
    engine.select(null);
    const controller = controllerFor(engine);
    expect(controller.hitTest(100, 60)).toMatchObject({ id: 'path', kind: 'move' });
    expect(controller.hitTest(50, 50)).toBeNull();
  });
});

describe('CandleKit režim kurzoru', () => {
  it('guma smaže kresbu kliknutím a klik do prázdna nechá být', () => {
    const engine = new DrawingEngine();
    engine.commit(line('a'));
    engine.select(null);
    const controller = controllerFor(engine);
    controller.setPointerMode('eraser', 'pointer');

    click(controller, 200, 200);
    expect(engine.getDrawings()).toHaveLength(1);
    expect(controller.chart.applyOptions).not.toHaveBeenCalled();

    click(controller, 30, 10);
    expect(engine.getDrawings()).toHaveLength(0);
  });

  it('mimo gumu klik kresbu jen vybere', () => {
    const engine = new DrawingEngine();
    engine.commit(line('a'));
    engine.select(null);
    const controller = controllerFor(engine);
    controller.setPointerMode('arrow', 'default');
    click(controller, 30, 10);
    expect(engine.getDrawings()).toHaveLength(1);
    expect(engine.getSelectedId()).toBe('a');
  });

  it('výchozí kurzor nahradí CSS kurzorem režimu', () => {
    const engine = new DrawingEngine();
    const controller = new DrawingController({ engine }) as any;
    const setProperty = vi.fn();
    controller.el = { style: { setProperty }, querySelectorAll: () => [] };
    controller.setPointerMode('dot', 'url(dot.svg) 6 6, crosshair');
    expect(setProperty).toHaveBeenLastCalledWith('cursor', 'url(dot.svg) 6 6, crosshair', 'important');
    expect(controller.getPointerMode()).toBe('dot');
  });
});

describe('CandleKit Emoji', () => {
  it('položí emoji jedním klikem a trefí ho v okolí znaku', () => {
    const engine = new DrawingEngine();
    const controller = controllerFor(engine);
    engine.setDefaultStyle({ ...engine.getDefaultStyle(), text: '🚀', fontSize: 28 });
    engine.startTool('Emoji');
    click(controller, 100, 100);
    const [emoji] = engine.getDrawings();
    expect(emoji).toMatchObject({ tool: 'Emoji', points: [{ time: 100, price: 100 }] });
    expect(emoji.style.text).toBe('🚀');
    engine.select(null);
    expect(controller.hitTest(112, 92)).toMatchObject({ id: emoji.id });
    expect(controller.hitTest(140, 100)).toBeNull();
  });
});
