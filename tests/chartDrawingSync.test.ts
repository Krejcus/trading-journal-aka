import { describe, expect, it, vi } from 'vitest';
import type { Drawing } from '@getcandlekit/charts';
import { DRAFT_PREVIEW_ID, installWorkspaceDrawingSync } from '../services/chartDrawingSync';

const drawing = (id: string, price = 100): Drawing => ({
  id,
  tool: 'TrendLine',
  points: [{ time: 60, price }, { time: 120, price: price + 1 }],
  style: { color: '#2962ff', width: 1, dashed: false, fill: 'transparent' },
});

const engine = (initial: Drawing[] = []) => {
  let drawings = initial;
  let draft: Drawing | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(listener => listener());
  return {
    getDrawings: () => drawings,
    getDraft: () => draft,
    getById: (id: string) => drawings.find(item => item.id === id),
    setPoints: vi.fn((id: string, points: Drawing['points']) => {
      const found = drawings.find(item => item.id === id);
      if (!found) return;
      found.points = points;
      emit();
    }),
    remove: (id: string) => {
      drawings = drawings.filter(item => item.id !== id);
      emit();
    },
    import: vi.fn((json: string) => {
      drawings = JSON.parse(json) as Drawing[];
      emit();
    }),
    onChange: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    mutate(next: Drawing[]) {
      drawings = next;
      emit();
    },
    /** Napodobuje rozkreslenou kresbu: engine emituje při každém pohybu. */
    setDraft(next: Drawing | null) {
      draft = next;
      emit();
    },
  };
};

describe('workspace drawing sync', () => {
  it('merges existing manual drawings when sync is enabled', () => {
    const first = engine([drawing('first')]);
    const second = engine([drawing('second')]);

    const cleanup = installWorkspaceDrawingSync([first, second]);

    expect(first.getDrawings().map(item => item.id)).toEqual(['first', 'second']);
    expect(second.getDrawings().map(item => item.id)).toEqual(['first', 'second']);
    cleanup();
  });

  it('mirrors create, edit and delete changes to every chart', () => {
    const first = engine();
    const second = engine();
    const cleanup = installWorkspaceDrawingSync([first, second]);

    first.mutate([drawing('shared')]);
    expect(second.getDrawings()).toEqual([drawing('shared')]);

    second.mutate([drawing('shared', 125)]);
    expect(first.getDrawings()).toEqual([drawing('shared', 125)]);

    first.mutate([]);
    expect(second.getDrawings()).toEqual([]);
    cleanup();
  });

  it('preserves generated overlays independently on each chart', () => {
    const firstAuto = drawing('auto-first');
    const secondAuto = drawing('auto-second');
    const first = engine([firstAuto]);
    const second = engine([secondAuto]);
    const cleanup = installWorkspaceDrawingSync([first, second]);

    first.mutate([firstAuto, drawing('manual')]);

    expect(first.getDrawings().map(item => item.id)).toEqual(['auto-first', 'manual']);
    expect(second.getDrawings().map(item => item.id)).toEqual(['auto-second', 'manual']);
    cleanup();
  });

  it('ukazuje rozkreslenou kresbu v ostatních panelech už během kreslení', () => {
    const first = engine();
    const second = engine();
    const cleanup = installWorkspaceDrawingSync([first, second]);

    first.setDraft({ ...drawing('draft-1'), points: [{ time: 60, price: 100 }, { time: 90, price: 105 }] });

    expect(second.getDrawings().map(item => item.id)).toEqual([DRAFT_PREVIEW_ID]);
    expect(second.getDrawings()[0].points).toEqual([{ time: 60, price: 100 }, { time: 90, price: 105 }]);

    // Další pohyb myší už jen posune body, panel se nepřenačítá celý.
    second.import.mockClear();
    first.setDraft({ ...drawing('draft-1'), points: [{ time: 60, price: 100 }, { time: 120, price: 111 }] });

    expect(second.setPoints).toHaveBeenCalledWith(DRAFT_PREVIEW_ID, [{ time: 60, price: 100 }, { time: 120, price: 111 }]);
    expect(second.import).not.toHaveBeenCalled();
    cleanup();
  });

  it('po dokreslení nahradí náhled skutečnou kresbou', () => {
    const first = engine();
    const second = engine();
    const cleanup = installWorkspaceDrawingSync([first, second]);

    first.setDraft(drawing('draft-1'));
    expect(second.getDrawings().map(item => item.id)).toEqual([DRAFT_PREVIEW_ID]);

    // Engine při commitu zahodí draft a přidá hotovou kresbu.
    first.mutate([drawing('hotova')]);
    first.setDraft(null);

    expect(second.getDrawings().map(item => item.id)).toEqual(['hotova']);
    cleanup();
  });

  it('zrušené kreslení náhled odstraní', () => {
    const first = engine();
    const second = engine([drawing('vlastni')]);
    const cleanup = installWorkspaceDrawingSync([first, second]);

    first.setDraft(drawing('draft-1'));
    expect(second.getDrawings().map(item => item.id)).toEqual(['vlastni', DRAFT_PREVIEW_ID]);

    first.setDraft(null);

    expect(second.getDrawings().map(item => item.id)).toEqual(['vlastni']);
    cleanup();
  });

  it('náhled se nesynchronizuje zpět jako kresba uživatele', () => {
    const first = engine();
    const second = engine();
    const third = engine();
    const cleanup = installWorkspaceDrawingSync([first, second, third]);

    first.setDraft(drawing('draft-1'));

    expect(first.getDrawings()).toEqual([]);
    expect(second.getDrawings().map(item => item.id)).toEqual([DRAFT_PREVIEW_ID]);
    expect(third.getDrawings().map(item => item.id)).toEqual([DRAFT_PREVIEW_ID]);
    cleanup();
  });

  it('úklid synchronizace smaže i zapomenutý náhled', () => {
    const first = engine();
    const second = engine();
    const cleanup = installWorkspaceDrawingSync([first, second]);

    first.setDraft(drawing('draft-1'));
    cleanup();

    expect(second.getDrawings()).toEqual([]);
  });

  it('rozdílný intervalSeconds u pozic nespustí kolotoč mezi panely', () => {
    // Každý panel si interval srovnává na svůj timeframe. Kdyby ho otisk bral
    // jako změnu kresby, panely by si úpravu donekonečna přeposílaly.
    const positionAt = (intervalSeconds: number): Drawing => ({
      id: 'pozice',
      tool: 'LongPosition',
      points: [{ time: 60, price: 100 }],
      style: {
        color: '#787b86', width: 1, dashed: false, fill: null,
        position: { intervalSeconds, initialBars: 6 },
      },
    } as unknown as Drawing);

    const first = engine([positionAt(60)]);
    const second = engine([positionAt(300)]);
    const cleanup = installWorkspaceDrawingSync([first, second]);

    (second.import as ReturnType<typeof vi.fn>).mockClear();
    // Panel si po synchronizaci srovnal interval na svůj — to druhý panel
    // zajímat nesmí.
    first.mutate([positionAt(60)]);

    expect(second.import).not.toHaveBeenCalled();
    cleanup();
  });

  it('skutečná změna pozice se přenese i tak', () => {
    const positionAt = (price: number): Drawing => ({
      id: 'pozice',
      tool: 'LongPosition',
      points: [{ time: 60, price }],
      style: {
        color: '#787b86', width: 1, dashed: false, fill: null,
        position: { intervalSeconds: 60, initialBars: 6 },
      },
    } as unknown as Drawing);

    const first = engine([positionAt(100)]);
    const second = engine([positionAt(100)]);
    const cleanup = installWorkspaceDrawingSync([first, second]);

    (second.import as ReturnType<typeof vi.fn>).mockClear();
    first.mutate([positionAt(250)]);

    expect(second.import).toHaveBeenCalled();
    expect(second.getDrawings()[0].points[0].price).toBe(250);
    cleanup();
  });
});