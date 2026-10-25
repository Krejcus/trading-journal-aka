import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const USER = '6fd09385-2400-4643-b6dc-9ab3b4a827cd';

/** Simulovaný server tabulky chart_drawings (trigger: starší úprava nepřepíše novější). */
const server = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  upserts: [] as Record<string, unknown>[][],
  authCallback: null as null | ((event: string, session: { user: { id: string } } | null) => void),
  clock: 0,
  /** Všechny řádky jedné dávky mají stejný updated_at (now() transakce). */
  rejectIds: new Set<string>(),
}));

vi.mock('../services/supabase', () => {
  const stamp = () => { server.clock += 1; return new Date(Date.UTC(2026, 9, 17, 8, 0, server.clock)).toISOString(); };
  const query = () => {
    let since: string | null = null;
    let range: [number, number] | null = null;
    let limit: number | null = null;
    let after: { updatedAt: string; id: string } | null = null;
    let pendingUpsert: Record<string, unknown>[] | null = null;
    const run = () => {
      if (pendingUpsert) {
        if (pendingUpsert.some(row => server.rejectIds.has(String(row.id)))) {
          return { data: null, error: { code: '23514', message: 'check violation' } };
        }
        server.upserts.push(pendingUpsert);
        const updatedAt = stamp();
        const result = pendingUpsert.map(row => {
          const existing = server.rows.get(String(row.id));
          if (existing && String(row.edited_at) < String(existing.edited_at)) return existing;
          const next = { ...row, updated_at: updatedAt };
          server.rows.set(String(row.id), next);
          return next;
        });
        return { data: result, error: null };
      }
      let rows = [...server.rows.values()]
        .filter(row => since === null || String(row.updated_at) >= since)
        .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)) || String(a.id).localeCompare(String(b.id)));
      if (after) rows = rows.filter(row => String(row.updated_at) > after!.updatedAt || (String(row.updated_at) === after!.updatedAt && String(row.id) > after!.id));
      if (range) rows = rows.slice(range[0], range[1] + 1);
      if (limit !== null) rows = rows.slice(0, limit);
      return { data: rows, error: null };
    };
    const builder = {
      select: () => builder,
      order: () => builder,
      range: (from: number, to: number) => { range = [from, to]; return builder; },
      limit: (value: number) => { limit = value; return builder; },
      or: (filter: string) => {
        const match = /^updated_at\.gt\."([^"]+)",and\(updated_at\.eq\."([^"]+)",id\.gt\."([^"]+)"\)$/.exec(filter);
        if (!match) throw new Error(`neočekávaný filtr ${filter}`);
        after = { updatedAt: match[1], id: match[3] };
        return builder;
      },
      gte: (_column: string, value: string) => { since = value; return builder; },
      upsert: (rows: Record<string, unknown>[]) => { pendingUpsert = rows; return builder; },
      then: (resolve: (value: unknown) => void) => resolve(run()),
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
const line = (id: string, time = T, price = 29_500, span = 600) => ({
  id, tool: 'TrendLine', points: [{ time, price }, { time: time + span, price: price + 10 }],
  style: { color: '#2962ff', width: 2, dashed: false, fill: null },
});

describe('vrstva kreseb — čisté funkce', () => {
  beforeEach(() => { vi.resetModules(); });

  it('kresba patří do okna, když se s ním časově překrývá; přenesená úroveň i dál', async () => {
    const { rowForDrawing, rowInWindow } = await import('../services/chartDrawingLayer');
    const row = rowForDrawing(line('dw_1'), 1);
    expect(row.day).toBe('2026-10-15');
    expect(rowInWindow(row, '2026-10-15', '2026-10-15')).toBe(true);
    expect(rowInWindow(row, '2026-10-16', '2026-10-16')).toBe(false);
    // Čára z 14. 10. 23:30 do 15. 10. 00:30 (Praha) patří i do grafu 15. 10.
    const overnight = rowForDrawing(line('dw_n', Date.UTC(2026, 9, 14, 21, 30) / 1_000, 29_500, 3_600), 1);
    expect(overnight.day).toBe('2026-10-14');
    expect(rowInWindow(overnight, '2026-10-15', '2026-10-15')).toBe(true);
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
    expect(deletions.map(row => row.id)).toEqual(['dw_b']);
    expect(deletions[0]).toMatchObject({ deletedAt: 100, dirty: true });
  });

  it('kresba ze serveru s jinak seřazenými klíči (jsonb) není změna — žádný nekonečný upsert', async () => {
    const { diffWindowExport, fromServerRow, rowForDrawing } = await import('../services/chartDrawingLayer');
    const exported = {
      id: 'dw_pos', tool: 'ShortPosition', points: [{ time: T, price: 30_080 }, { time: T + 360, price: 30_076 }, { time: T + 360, price: 30_089 }],
      style: { color: '#f23645', width: 1, dashed: false, lineStyle: 'solid', fill: null, fib: { levels: [0, 1], show: true }, position: { qty: 1, risk: 'fixed' } },
    };
    const sent = rowForDrawing(exported, 1);
    // jsonb řadí klíče objektu podle délky a pak abecedy — tak se kresba vrátí ze serveru.
    const server = fromServerRow({
      id: 'dw_pos', day: sent.day, start_time: new Date(sent.startTime * 1_000).toISOString(), end_time: new Date(sent.endTime * 1_000).toISOString(),
      carry_forward: false, edited_at: new Date(1).toISOString(), deleted_at: null, updated_at: new Date(2).toISOString(),
      drawing: { id: 'dw_pos', tool: 'ShortPosition', style: { fib: { show: true, levels: [0, 1] }, fill: null, color: '#f23645', width: 1, dashed: false, position: { qty: 1, risk: 'fixed' }, lineStyle: 'solid' }, points: exported.points },
    })!;
    const { upserts, deletions } = diffWindowExport([server], [exported], 100, new Set(['dw_pos']));
    expect(upserts).toEqual([]);
    expect(deletions).toEqual([]);
  });

  it('zastaralý graf nevzkřísí kresbu smazanou po svém načtení; dřív smazanou (Zpět) ano', async () => {
    const { diffWindowExport, rowForDrawing } = await import('../services/chartDrawingLayer');
    const deletedLater = { ...rowForDrawing(line('dw_x'), 1), deletedAt: 500 };
    const deletedEarlier = { ...rowForDrawing(line('dw_y'), 1), deletedAt: 50 };
    const deleted = new Map([['dw_x', deletedLater], ['dw_y', deletedEarlier]]);
    const { upserts } = diffWindowExport([], [line('dw_x'), line('dw_y')], 600, new Set(), deleted, 100);
    expect(upserts.map(row => row.id)).toEqual(['dw_y']);
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
    server.rejectIds.clear();
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

  it('vrstva se na zařízení zapne až po převodu', async () => {
    const layer = await start();
    expect(layer.drawingLayerPulled()).toBe(true);
    expect(layer.drawingLayerReady()).toBe(false);
    layer.activateDrawingLayer();
    expect(layer.drawingLayerReady()).toBe(true);
  });

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

  it('opakovaný export bez změny ručních kreseb nic nezapisuje', async () => {
    const layer = await start();
    const kv = layer.drawingLayerKV('2026-10-15', '2026-10-15');
    kv.get();
    kv.set('x', JSON.stringify([line('dw_a')]));
    await vi.advanceTimersByTimeAsync(2_000);
    const pushes = server.upserts.length;
    kv.set('x', JSON.stringify([line('dw_a'), line('auto-structure-9')]));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.upserts.length).toBe(pushes);
  });

  it('Zpět po vlastním smazání kresbu vrátí i na server', async () => {
    const layer = await start();
    const kv = layer.drawingLayerKV('2026-10-15', '2026-10-15');
    kv.get();
    kv.set('x', JSON.stringify([line('dw_u')]));
    await vi.advanceTimersByTimeAsync(2_000);
    vi.setSystemTime(new Date('2026-10-17T08:01:00Z'));
    kv.set('x', JSON.stringify([]));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.rows.get('dw_u')?.deleted_at).not.toBeNull();
    vi.setSystemTime(new Date('2026-10-17T08:02:00Z'));
    kv.set('x', JSON.stringify([line('dw_u')]));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.rows.get('dw_u')?.deleted_at).toBeNull();
    expect(layer.windowDrawings('2026-10-15', '2026-10-15').map(drawing => drawing.id)).toEqual(['dw_u']);
  });

  it('stránkování nepřeskočí řádky se stejným updated_at', async () => {
    const stamp = '2026-10-17T07:00:00.000Z';
    for (let index = 0; index < 650; index += 1) {
      const id = `dw_${String(index).padStart(4, '0')}`;
      server.rows.set(id, {
        id, day: '2026-10-15', start_time: new Date(T * 1_000).toISOString(), end_time: new Date((T + 600) * 1_000).toISOString(),
        carry_forward: false, drawing: line(id), edited_at: stamp, deleted_at: null, updated_at: stamp,
      });
    }
    const layer = await start();
    expect(layer.windowDrawings('2026-10-15', '2026-10-15')).toHaveLength(650);
  });

  it('převod starých kreseb: server vyhraje, nové se přidají', async () => {
    server.rows.set('dw_a', {
      id: 'dw_a', day: '2026-10-15', start_time: new Date(T * 1_000).toISOString(), end_time: new Date((T + 600) * 1_000).toISOString(),
      carry_forward: false, drawing: line('dw_a', T, 31_000), edited_at: '2026-10-16T10:00:00Z', deleted_at: '2026-10-16T10:00:00Z', updated_at: '2026-10-16T10:00:00Z',
    });
    const layer = await start();
    // dw_a je ve vrstvě (smazaná jinde) — převod ji nevzkřísí; dw_b přibude.
    expect(layer.importDrawingsIntoLayer([line('dw_a'), line('dw_b')])).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.rows.get('dw_a')?.deleted_at).not.toBeNull();
    expect(server.rows.get('dw_b')?.deleted_at).toBeNull();
  });

  it('vadný řádek se odloží a nezablokuje ostatní', async () => {
    server.rejectIds.add('dw_bad');
    const layer = await start();
    layer.importDrawingsIntoLayer([line('dw_ok'), line('dw_bad')]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.rows.has('dw_ok')).toBe(true);
    expect(server.rows.has('dw_bad')).toBe(false);
    const before = server.upserts.length;
    await vi.advanceTimersByTimeAsync(120_000);
    // Odložený řádek se neposílá dokola.
    expect(server.upserts.length).toBe(before);
  });

  it('odhlášený graf do vrstvy nezapisuje', async () => {
    const layer = await start();
    server.authCallback?.('SIGNED_OUT', null);
    await vi.advanceTimersByTimeAsync(10);
    const kv = layer.drawingLayerKV('2026-10-15', '2026-10-15');
    kv.set('x', JSON.stringify([line('dw_z')]));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(server.rows.has('dw_z')).toBe(false);
  });
});
