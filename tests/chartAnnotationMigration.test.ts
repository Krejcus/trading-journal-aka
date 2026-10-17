import { describe, expect, it } from 'vitest';
import { buildDrawingMigrationPreview, classifyDrawingKey, normalizeDrawingForLayer } from '../services/chartAnnotationMigration';

const TRADE = '9ee1131e-6f69-45c5-9a40-979dce5c7411';
const drawing = (id: string, time = 1_792_169_400, extra: Record<string, unknown> = {}) => ({
  id, tool: 'TrendLine', points: [{ time, price: 29_500 }, { time: time + 600, price: 29_510 }],
  style: { color: '#2962ff', width: 2, dashed: false, fill: null, ...extra },
});

describe('classifyDrawingKey — odkud kresba pochází', () => {
  it('pozná všechny obrazovky', () => {
    expect(classifyDrawingKey(`alphatrade:candlekit:${TRADE}:1m`)?.kind).toBe('trade-detail');
    expect(classifyDrawingKey(`alphatrade:candlekit:${TRADE}:workspace:alphatrade-chart-1:MNQ:1m`)).toMatchObject({ kind: 'trade-fullscreen', root: 'MNQ', timeframe: '1m' });
    expect(classifyDrawingKey('alphatrade:candlekit:review-1791756000000:workspace:alphatrade-chart-2:NQ:5m')).toMatchObject({ kind: 'weekly-review', root: 'NQ' });
    expect(classifyDrawingKey('alphatrade:candlekit:day:2026-10-15:workspace:alphatrade-chart-1:MNQ:1m')?.kind).toBe('day-desktop');
    expect(classifyDrawingKey('alphatrade:candlekit:day:2026-10-15:day')?.kind).toBe('day-phone');
    expect(classifyDrawingKey(`alphatrade:candlekit:${TRADE}:backtest:s1:alphatrade-chart-1:MNQ:1m`)?.kind).toBe('backtest');
    expect(classifyDrawingKey('alphatrade:chart-settings:shared')).toBeNull();
  });
});

describe('buildDrawingMigrationPreview — co by se slilo', () => {
  it('vynechá automatické vrstvy a backtest, sloučí kopie z panelů', () => {
    const shared = drawing('dw_a');
    const preview = buildDrawingMigrationPreview([
      [`alphatrade:candlekit:${TRADE}:1m`, JSON.stringify([drawing('auto-structure-1'), drawing('auto-risk-x')])],
      [`alphatrade:candlekit:${TRADE}:workspace:alphatrade-chart-1:MNQ:1m`, JSON.stringify([shared])],
      [`alphatrade:candlekit:${TRADE}:workspace:alphatrade-chart-2:MNQ:5m`, JSON.stringify([shared])],
      ['alphatrade:candlekit:day:2026-10-15:day', JSON.stringify([drawing('dw_b', 1_792_100_000)])],
      [`alphatrade:candlekit:${TRADE}:backtest:s1:alphatrade-chart-1:MNQ:1m`, JSON.stringify([drawing('dw_bt')])],
      ['alphatrade:candlekit:empty:1m', '[]'],
      ['alphatrade:candlekit:broken:1m', '{nope'],
    ]);
    expect(preview.drawings.map(item => item.drawing.id).sort()).toEqual(['dw_a', 'dw_b']);
    expect(preview.autoOverlaysSkipped).toBe(2);
    expect(preview.backtestSkipped).toBe(1);
    expect(preview.duplicateCopies).toBe(1);
    expect(preview.unreadableKeys).toEqual(['alphatrade:candlekit:broken:1m']);
    expect(preview.drawings.find(item => item.drawing.id === 'dw_a')?.root).toBe('MNQ');
    expect(preview.conflicts).toBe(0);
  });

  it('stejné ID s jiným obsahem označí jako konflikt', () => {
    const preview = buildDrawingMigrationPreview([
      [`alphatrade:candlekit:${TRADE}:workspace:alphatrade-chart-1:MNQ:1m`, JSON.stringify([drawing('dw_a')])],
      [`alphatrade:candlekit:${TRADE}:workspace:alphatrade-chart-2:MNQ:5m`, JSON.stringify([drawing('dw_a', 1_792_169_460)])],
    ]);
    expect(preview.conflicts).toBe(1);
  });

  it('při konfliktu vyhraje kopie z obrazovky, kde se kreslí', () => {
    const preview = buildDrawingMigrationPreview([
      [`alphatrade:candlekit:${TRADE}:1m`, JSON.stringify([drawing('dw_a')])],
      [`alphatrade:candlekit:${TRADE}:workspace:alphatrade-chart-1:MNQ:1m`, JSON.stringify([drawing('dw_a', 1_792_169_460)])],
    ]);
    expect(preview.conflicts).toBe(1);
    expect(preview.drawings[0].drawing.points[0].time).toBe(1_792_169_460);
  });

  it('rozdíl jen v runtime polích panelu konflikt není', () => {
    const one = drawing('dw_p', 1_792_169_400, { position: { intervalSeconds: 60, risk: 1 } });
    const two = drawing('dw_p', 1_792_169_400, { position: { intervalSeconds: 300, risk: 1 } });
    const preview = buildDrawingMigrationPreview([
      [`alphatrade:candlekit:${TRADE}:workspace:alphatrade-chart-1:MNQ:1m`, JSON.stringify([one])],
      [`alphatrade:candlekit:${TRADE}:workspace:alphatrade-chart-2:MNQ:5m`, JSON.stringify([two])],
    ]);
    expect(preview.conflicts).toBe(0);
    expect(normalizeDrawingForLayer(one).style?.position).toEqual({ risk: 1 });
  });
});
