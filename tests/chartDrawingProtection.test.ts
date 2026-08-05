import { describe, expect, it } from 'vitest';
import { DrawingEngine } from '@getcandlekit/charts';
import { protectGeneratedDrawings } from '../services/chartDrawingProtection';

const point = (time: number, price: number) => ({ time, price });
const style = { color: '#fff', width: 1, dashed: false, fill: null };

describe('protectGeneratedDrawings', () => {
  it('restores generated trade drawings but leaves manual drawings editable', () => {
    const engine = new DrawingEngine();
    engine.commit({ id: 'auto-risk-trade', tool: 'Rectangle', points: [point(1, 100), point(2, 90)], style });
    engine.commit({ id: 'manual-zone', tool: 'Rectangle', points: [point(1, 110), point(2, 105)], style });
    const unsubscribe = protectGeneratedDrawings(engine);

    engine.setPoints('auto-risk-trade', [point(3, 120), point(4, 115)]);
    expect(engine.getById('auto-risk-trade')?.points).toEqual([point(1, 100), point(2, 90)]);

    engine.select('auto-risk-trade');
    expect(engine.getSelectedId()).toBeNull();

    engine.setPoints('manual-zone', [point(3, 111), point(4, 106)]);
    expect(engine.getById('manual-zone')?.points).toEqual([point(3, 111), point(4, 106)]);
    unsubscribe();
  });
});
