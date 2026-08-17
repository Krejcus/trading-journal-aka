import { describe, expect, it } from 'vitest';
import { DrawingEngine } from '@getcandlekit/charts';
import { protectGeneratedDrawings } from '../services/chartDrawingProtection';
import { DRAFT_PREVIEW_ID } from '../services/chartDrawingSync';

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

  it('náhled rozkreslené kresby zůstává pohyblivý i pod ochranou', () => {
    // Sync posouvá náhled při každém pohybu kreslící myši. Ochrana ho nesmí
    // vracet zpět, jinak náhled na ostatních panelech zamrzne v prvním kliku.
    const engine = new DrawingEngine();
    engine.commit({ id: 'auto-risk-trade', tool: 'Rectangle', points: [point(1, 100), point(2, 90)], style });
    engine.commit({ id: DRAFT_PREVIEW_ID, tool: 'Rectangle', points: [point(5, 100), point(5, 100)], style });
    const unsubscribe = protectGeneratedDrawings(engine);

    engine.setPoints(DRAFT_PREVIEW_ID, [point(5, 100), point(8, 130)]);
    expect(engine.getById(DRAFT_PREVIEW_ID)?.points).toEqual([point(5, 100), point(8, 130)]);

    engine.setPoints('auto-risk-trade', [point(3, 120), point(4, 115)]);
    expect(engine.getById('auto-risk-trade')?.points).toEqual([point(1, 100), point(2, 90)]);
    unsubscribe();
  });
});
