import { describe, expect, it, vi } from 'vitest';
import { attachChartTouchGestures } from '../services/chartTouchPriceAxis';

describe('attachChartTouchGestures', () => {
  it('keeps the page still under the chart and gives every drag direction to the chart', () => {
    const element = { style: { touchAction: '' } };
    const applyOptions = vi.fn();
    const detach = attachChartTouchGestures({ chartElement: () => element as never, applyOptions });
    expect(element.style.touchAction).toBe('none');
    expect(applyOptions).toHaveBeenCalledWith({ handleScroll: { vertTouchDrag: true } });
    detach();
    expect(element.style.touchAction).toBe('');
  });
});
