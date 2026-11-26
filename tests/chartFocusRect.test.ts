import { describe, expect, it } from 'vitest';
import { FOCUS_LINE_BAND_PX, FOCUS_PADDING_PX, FOCUS_POSITION_PAD_X_PX, FOCUS_POSITION_PAD_Y_PX, focusRectForDrawing, focusRectForPrice } from '../services/chartFocusRect';

describe('okno zaostření na vybranou kresbu', () => {
  it('obdélník dostane okno kolem svých bodů s okrajem', () => {
    const rect = focusRectForDrawing('Rectangle', [{ x: 100, y: 200 }, { x: 180, y: 120 }], 300, 600);
    expect(rect).toEqual({ left: 100 - FOCUS_PADDING_PX, top: 120 - FOCUS_PADDING_PX, width: 80 + 2 * FOCUS_PADDING_PX, height: 80 + 2 * FOCUS_PADDING_PX });
  });

  it('position box má širší okno kvůli štítkům cíle a stopu', () => {
    const rect = focusRectForDrawing('LongPosition', [{ x: 100, y: 200 }, { x: 180, y: 120 }, { x: 180, y: 260 }], 400, 600);
    expect(rect).toEqual({ left: 100 - FOCUS_POSITION_PAD_X_PX, top: 120 - FOCUS_POSITION_PAD_Y_PX, width: 80 + 2 * FOCUS_POSITION_PAD_X_PX, height: 140 + 2 * FOCUS_POSITION_PAD_Y_PX });
  });

  it('vodorovná čára dostane pruh přes celou šířku', () => {
    expect(focusRectForDrawing('HorizontalLine', [{ x: 50, y: 300 }], 300, 600)).toEqual({ left: 0, top: 300 - FOCUS_LINE_BAND_PX, width: 300, height: 2 * FOCUS_LINE_BAND_PX });
  });

  it('svislá čára dostane pruh přes celou výšku', () => {
    expect(focusRectForDrawing('VerticalLine', [{ x: 150, y: null }], 300, 600)).toEqual({ left: 150 - FOCUS_LINE_BAND_PX, top: 0, width: 2 * FOCUS_LINE_BAND_PX, height: 600 });
  });

  it('bod mimo načtená data roztáhne okno přes celou šířku', () => {
    const rect = focusRectForDrawing('TrendLine', [{ x: null, y: 100 }, { x: 200, y: 180 }], 300, 600);
    expect(rect?.left).toBe(0);
    expect(rect?.width).toBe(300);
  });

  it('okno se ořízne do grafu a kresba bez ceny v měřítku neztmaví nic', () => {
    expect(focusRectForDrawing('Rectangle', [{ x: -50, y: -40 }, { x: 40, y: 30 }], 300, 600)).toEqual({ left: 0, top: 0, width: 40 + FOCUS_PADDING_PX, height: 30 + FOCUS_PADDING_PX });
    expect(focusRectForDrawing('Rectangle', [{ x: 10, y: null }, { x: 40, y: null }], 300, 600)).toBeNull();
    expect(focusRectForDrawing('Rectangle', [{ x: 10, y: 10 }], 0, 600)).toBeNull();
  });

  it('upozornění dostane pruh kolem své ceny', () => {
    expect(focusRectForPrice(250, 300, 600)).toEqual({ left: 0, top: 250 - FOCUS_LINE_BAND_PX, width: 300, height: 2 * FOCUS_LINE_BAND_PX });
    expect(focusRectForPrice(null, 300, 600)).toBeNull();
  });
});
