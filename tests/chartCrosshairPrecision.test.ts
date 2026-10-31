import { describe, expect, it } from 'vitest';
import { crosshairCssLineStyle, exactCrosshairLabelLeft, exactCrosshairPoint, exactCrosshairPriceLabelTop, exactCrosshairX } from '../services/chartCrosshairPrecision';

describe('exact chart crosshair', () => {
  it('uses the physical pointer x instead of the bar-centre fallback', () => {
    expect(exactCrosshairX({ sourceX: 104.75, fallbackX: 108, plotWidth: 900 })).toBe(104.75);
  });

  it('keeps programmatic pane synchronisation when no physical event exists', () => {
    expect(exactCrosshairX({ fallbackX: 420, plotWidth: 900 })).toBe(420);
  });

  it('refuses coordinates outside the plot', () => {
    expect(exactCrosshairX({ sourceX: -1, fallbackX: 20, plotWidth: 900 })).toBeNull();
    expect(exactCrosshairX({ sourceX: 901, fallbackX: 20, plotWidth: 900 })).toBeNull();
    expect(exactCrosshairX({ sourceX: 20, plotWidth: 0 })).toBeNull();
  });

  it('keeps the time label inside both plot edges', () => {
    expect(exactCrosshairLabelLeft(5, 900)).toBe(64);
    expect(exactCrosshairLabelLeft(450, 900)).toBe(450);
    expect(exactCrosshairLabelLeft(895, 900)).toBe(836);
  });

  it('maps the newest client pointer through a left price scale into plot coordinates', () => {
    expect(exactCrosshairPoint({
      clientX: 390,
      clientY: 240,
      chartLeft: 100,
      chartTop: 40,
      plotLeft: 70,
      plotWidth: 800,
      plotHeight: 500,
    })).toEqual({ x: 220, y: 200 });
  });

  it('rejects pointer samples on either price axis and clamps the price label', () => {
    expect(exactCrosshairPoint({ clientX: 120, clientY: 240, chartLeft: 100, chartTop: 40, plotLeft: 70, plotWidth: 800, plotHeight: 500 })).toBeNull();
    expect(exactCrosshairPriceLabelTop(2, 500)).toBe(0);
    expect(exactCrosshairPriceLabelTop(499, 500)).toBe(478);
  });

  it('maps extended chart dash styles to supported CSS border styles', () => {
    expect(crosshairCssLineStyle('solid')).toBe('solid');
    expect(crosshairCssLineStyle('dotted')).toBe('dotted');
    expect(crosshairCssLineStyle('sparse-dotted')).toBe('dotted');
    expect(crosshairCssLineStyle('large-dashed')).toBe('dashed');
  });
});
