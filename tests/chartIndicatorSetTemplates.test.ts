import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  describeIndicatorSetTemplate,
  indicatorSetTemplateBadge,
  indicatorSetTemplateMeta,
  normalizeIndicatorSetTemplate,
  withIndicatorSetTemplateMeta,
} from '../services/chartIndicatorSetTemplates';
import { isChartEmoji } from '../services/chartEmoji';
import {
  chartCursorCss,
  chartCursorShowsCrosshairLines,
  getChartCursorMode,
  setChartCursorMode,
} from '../services/chartCursorMode';

describe('šablony sady indikátorů', () => {
  it('převezme platnou sadu i s parametry knihovních indikátorů', () => {
    expect(normalizeIndicatorSetTemplate({
      custom: { fvg: true, levels: false, structure: true },
      library: [{ name: 'EMA', params: { length: 21 } }, { name: '', params: {} }, 'x'],
    })).toEqual({
      custom: { fvg: true, levels: false, structure: true },
      library: [{ name: 'EMA', params: { length: 21 } }],
    });
  });

  it('neplatnou hodnotu z cloudu odmítne', () => {
    expect(normalizeIndicatorSetTemplate(null)).toBeNull();
    expect(normalizeIndicatorSetTemplate({ custom: {}, library: 'EMA' })).toBeNull();
    expect(normalizeIndicatorSetTemplate([1, 2])).toBeNull();
  });

  it('popíše šablonu výčtem indikátorů', () => {
    const state = {
      custom: { fvg: true, levels: true, structure: false },
      library: [{ name: 'VWAP', params: {} }],
    };
    expect(describeIndicatorSetTemplate(state, name => `${name}!`)).toBe('FVG, Levely, VWAP!');
    expect(describeIndicatorSetTemplate({ custom: { fvg: false, levels: false, structure: false }, library: [] })).toBe('Bez indikátorů');
  });
});

describe('režim kurzoru grafu', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('pamatuje si volbu a neznámou hodnotu vrátí na kříž', () => {
    const stored = new Map<string, string>();
    const events: string[] = [];
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => { stored.set(key, value); },
      },
      dispatchEvent: (event: CustomEvent) => { events.push(String(event.detail)); return true; },
    });
    vi.stubGlobal('CustomEvent', class { constructor(public type: string, public init: { detail: unknown }) {} get detail() { return this.init.detail; } });
    setChartCursorMode('demonstration');
    expect(getChartCursorMode()).toBe('demonstration');
    expect(stored.get('alphatrade:chart-cursor-mode')).toBe('demonstration');
    expect(events).toEqual(['demonstration']);
    expect(setChartCursorMode('nonsense' as never)).toBe('cross');
  });

  it('čáry crosshairu má jen kříž a tečka', () => {
    expect(chartCursorShowsCrosshairLines('cross')).toBe(true);
    expect(chartCursorShowsCrosshairLines('dot')).toBe(true);
    expect(chartCursorShowsCrosshairLines('arrow')).toBe(false);
    expect(chartCursorShowsCrosshairLines('demonstration')).toBe(false);
    expect(chartCursorShowsCrosshairLines('eraser')).toBe(false);
    expect(chartCursorCss('arrow')).toBe('default');
    expect(chartCursorCss('dot')).toMatch(/^url\("data:image\/svg\+xml,.+ 6 6, crosshair$/);
  });
});

describe('oblíbené šablony a emoji', () => {
  it('čte hvězdičku a ikonu, neplatnou ikonu zahodí', () => {
    expect(indicatorSetTemplateMeta({ favorite: true, icon: '🚀' })).toEqual({ favorite: true, icon: '🚀' });
    expect(indicatorSetTemplateMeta({ favorite: 'yes', icon: 'abc' })).toEqual({ favorite: false, icon: null });
    expect(indicatorSetTemplateMeta(null)).toEqual({ favorite: false, icon: null });
  });

  it('metadata přežijí normalizaci stavu a neruší ji', () => {
    const state = { custom: { fvg: true, levels: false, structure: false }, library: [] };
    const stored = withIndicatorSetTemplateMeta(state, { favorite: true, icon: '🔥' });
    expect(normalizeIndicatorSetTemplate(stored)).toEqual(state);
    expect(indicatorSetTemplateMeta(stored)).toEqual({ favorite: true, icon: '🔥' });
    expect(withIndicatorSetTemplateMeta(state, { favorite: false, icon: null })).toEqual(state);
  });

  it('bez emoji ukáže první písmeno názvu', () => {
    expect(indicatorSetTemplateBadge('  nasdaq ráno', null)).toBe('N');
    expect(indicatorSetTemplateBadge('čistý graf', null)).toBe('Č');
    expect(indicatorSetTemplateBadge('x', '💎')).toBe('💎');
    expect(indicatorSetTemplateBadge('   ', null)).toBe('?');
  });

  it('emoji pozná i se sekvencí, text odmítne', () => {
    expect(isChartEmoji('⚠️')).toBe(true);
    expect(isChartEmoji('👍🏽')).toBe(true);
    expect(isChartEmoji('🧑‍💻')).toBe(true);
    expect(isChartEmoji('A')).toBe(false);
    expect(isChartEmoji('🚀 raketa')).toBe(false);
  });
});
