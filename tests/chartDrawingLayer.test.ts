import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '6fd09385-2400-4643-b6dc-9ab3b4a827cd';

const server = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  upserts: [] as Record<string, unknown>[][],
  authCallback: null as null | ((event: string, session: { user: { id: string } } | null) => void),
  clock: 0,
}));

vi.mock('../services/supabase', () => {
  const query = () => {
    let since: string | null = null;
    let ids: string[] | null = null;
    const builder = {
      select: () => builder,
      order: () => builder,
      limit: () => builder,
      gt: (_column: string, value: string) => { since = value; return builder; },
      in: (_column: string, value: string[]) => { ids = value; return builder; },
      then: (resolve: (value: unknown) => void) => {
        const rows = [...server.rows.values()]
          .filter(row => (since === null || String(row.updated_at) > since) && (ids === null || ids.includes(String(row.id))))
          .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)));
        resolve({ data: rows, error: null });
      },
      upsert: async (rows: Record<string, unknown>[]) => {
        server.upserts.push(rows);
        rows.forEach(row => {
          const existing = server.rows.get(String(row.id));
          // Stejně jako trigger: starší úprava nepřepíše novější.
          if (existing && String(row.edited_at) < String(existing.edited_at)) return;
          server.clock += 1;
          server.rows.set(String(row.id), { ...row, updated_at: new Date(Date.UTC(2026, 9, 17, 8, 0, server.clock)).toISOString() });
        });
        return { error: null };
      },
    };
    return builder;
  };
  return {
    supabase: {
      auth: {
        onAuthStateChange: (callback: typeof server.authCallback) => {
          server.authCallback = callback;
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
      },
      from: () => query(),
    },
  };
});

const memoryStorage = () => {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, String(value)); },
    removeItem: (key: string) => { data.delete(key); },
  };
};

// 15. 10. 2026 10:00 Praha.
const T = Date.UTC(2026, 9, 15, 8, 0) / 1_000;
const line = (id: string, time = T, price = 29_500) => ({
  id, tool: 'TrendLine', points: [{ time, price }, { time: time + 600, price: price + 10 }],
  style: { color: '#2962ff', width: 2, dashed: false, fill: null },
});

describe('vrstva kreseb — čisté funkce', () => {
  beforeEach(() => { vi.resetModules(); });

  it('kresba patří do svého dne; přenesená úroveň i do dalších dnů', async () => {
    const { rowForDrawing, rowInWindow } = await import('../services/chartDrawingLayer');
    const row = rowForDrawing(line('dw_1'), 1);
    expect(row.day).toBe('2026-10-15');
    expect(rowInWindow(row, '2026-10-15', '2026-10-15')).toBe(true);
    expect(rowInWindow(row, '2026-10-16', '2026-10-16')).toBe(false);
    const carried = rowForDrawing({ ...line('dw_2'), style: { ...line('dw_2').style, carryForward: true } }, 1);
    expect(rowInWindow(carried, '2026-10-16', '2026-10-16')).toBe(true);
    expect(rowInWindow(carried, '2026-10-14', '2026-10-14')).toBe(false);
    expect(rowInWindow({ ...row, deletedAt: 5 }, '2026-10-15', '2026-10-15')).toBe(false);
  });

  it('rozdíl exportu: nové a změněné, smazané jen z toho, co graf měl', async () => {
    const { diffWindowExport, rowForDrawing } = await import('../services/chartDrawingLayer');
    const a = rowForDrawing(line('dw_a'), 1);
    const b = rowForDrawing(line('dw_b'), 1);
    const remote = rowForDrawing(line('dw_remote'), 1);
    const { upserts, deletions } = diffWindowExport(
      [a, b, remote],
      [line('dw_a'), line('dw_c'), line('auto-structure-1')],
      100,
      new Set(['dw_a', 'dw_b']),
    );
    expect(upserts.map(row => row.id)).toEqual(['dw_c']);
    // dw_b graf měl a už nemá → smazaná; dw_remote ještě v grafu nebyla → zůstává.
    expect(deletions.map(row => row.id)).toEqual(['dw_b']);
    expect(deletions[0]).toMatchObject({ deletedAt: 100, dirty: true });
  });

  it('neodeslaná novější místní úprava vyhraje nad starší ze serveru', async () => {
    const { mergeServerRow, rowForDrawing } = await import('../services/chartDrawingLayer');
    const local = rowForDrawing(line('dw_a', T, 1), 200);
    const older = { ...rowForDrawing(line('dw_a', T, 2), 100), dirty: false };
    const newer = { ...rowForDrawing(line('dw_a', T, 3), 300), dirty: false };
    expect(mergeServerRow(local, older)).toBe(local);
    expect(mergeServerRow(local, newer).drawing.points[0].price).toBe(3);
  });
});

describe('vrstva kreseb — synchronizace se serverem', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-17T08:00:00Z'));
    server.rows.clear();
    server.upserts = [];
    server.clock = 0;
    vi.stubGlobal('window', { localStorage: memoryStorage(), addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  const start = async () => {
    const layer = await import('../services/chartDrawingLayer');
    layer.startChartDrawingLayer();
    server.authCallback?.('SIGNED_IN', { user: { id: USER } });
    await vi.advanceTimersByTimeAsync(10);
    return layer;
  };

  it('kresba z grafu se nahraje a smazání se propíše měkce', async () => {
    const layer = await start();
    const kv = layer.drawingLayerKV('2026-10-15', '2026-10-15');
    expect(kv.get()).toBe('[]');
    kv.set('x', JSON.stringify([line('dw_a'), line('auto-risk-1')]));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.rows.get('dw_a')).toMatchObject({ user_id: USER, market: 'NQ', day: '2026-10-15', deleted_at: null });
    expect(server.rows.has('auto-risk-1')).toBe(false);

    vi.setSystemTime(new Date('2026-10-17T08:05:00Z'));
    kv.set('x', JSON.stringify([]));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.rows.get('dw_a')?.deleted_at).not.toBeNull();
    expect(layer.windowDrawings('2026-10-15', '2026-10-15')).toEqual([]);
  });

  it('kresba z jiného zařízení dorazí do vrstvy a dá vědět grafům', async () => {
    server.rows.set('dw_remote', {
      id: 'dw_remote', day: '2026-10-15', start_time: new Date(T * 1_000).toISOString(), end_time: new Date((T + 600) * 1_000).toISOString(),
      carry_forward: false, drawing: line('dw_remote'), edited_at: '2026-10-17T07:00:00Z', deleted_at: null, updated_at: '2026-10-17T07:00:00Z',
    });
    const layer = await start();
    const listener = vi.fn();
    layer.subscribeDrawingLayer(listener);
    await vi.advanceTimersByTimeAsync(200);
    expect(layer.windowDrawings('2026-10-15', '2026-10-15').map(drawing => drawing.id)).toEqual(['dw_remote']);
  });

  it('převod starých kreseb přeskočí ty, které už ve vrstvě jsou', async () => {
    const layer = await start();
    expect(layer.importDrawingsIntoLayer([line('dw_a'), line('dw_b')])).toBe(2);
    expect(layer.importDrawingsIntoLayer([line('dw_a'), line('dw_c')])).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect([...server.rows.keys()].sort()).toEqual(['dw_a', 'dw_b', 'dw_c']);
  });
});
