import { beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  user: 'user-a' as string | null,
  auth: null as null | ((event: string, session: any) => void),
  select: vi.fn(), upsert: vi.fn(), writes: new Map<string, any>(), mutation: null as null | ((value: any, filters: Record<string, string>, op: string) => any),
}));
vi.mock('../services/storageService', () => ({ getUserId: async () => fake.user }));
vi.mock('../services/supabase', () => ({ supabase: {
  auth: { onAuthStateChange: (callback: typeof fake.auth) => { fake.auth = callback; return { data: { subscription: { unsubscribe() {} } } }; } },
  from: () => ({
    select: () => {
      const filters: Record<string, string> = {};
      const query = { eq: (key: string, value: string) => { filters[key] = value; return query; }, then: (resolve: any, reject: any) => fake.select(filters).then(resolve, reject) };
      return query;
    },
    ...Object.fromEntries(['insert', 'update'].map(op => [op, (value: any) => {
      const filters: Record<string, string> = {};
      const query = { eq: (key: string, v: string) => { filters[key] = v; return query; }, select: () => query,
        maybeSingle: async () => {
          if (fake.mutation) return fake.mutation(value, filters, op);
          const response = await fake.upsert(value);
          if (response.error) return response;
          fake.writes.set(value.id, value);
          return { data: { id: value.id }, error: null };
        } };
      return query;
    }])),
  }),
} }));
import {
  CHART_TEMPLATE_STORAGE_KEY, chartTemplateUserStorageKey, chartTemplates,
  chartTemplateSyncStatus, deleteChartTemplate, importLegacyChartTemplates,
  legacyChartTemplates, resetChartTemplateCache, saveChartTemplate, syncChartTemplates,
  type ChartTemplateRecord,
} from '../services/chartTemplateStore';

const idA = '00000000-0000-4000-8000-000000000001';
const idB = '00000000-0000-4000-8000-000000000002';
const record = (patch: Partial<ChartTemplateRecord> = {}): ChartTemplateRecord => ({ id: idA, indicator: 'levels', name: 'Private A', value: { showVwap: true }, updatedAt: '2026-08-01T00:00:00.000Z', ...patch });
const row = (item: ChartTemplateRecord) => ({ id: item.id, indicator: item.indicator, name: item.name, value: item.deleted ? { __alphatradeChartTemplateDeleted: 1 } : item.value, updated_at: item.updatedAt });
const deferred = () => {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(done => { resolve = done; });
  return { promise, resolve };
};
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
let storage: Map<string, string>;
const seed = (user: string, values: ChartTemplateRecord[]) => storage.set(chartTemplateUserStorageKey(user), JSON.stringify(values));
beforeEach(() => {
  resetChartTemplateCache();
  fake.user = 'user-a';
  fake.writes.clear(); fake.mutation = null;
  fake.select.mockReset().mockImplementation(async (filters: Record<string, string>) => ({ data: [...fake.writes.values()].filter(row => row.user_id === filters.user_id), error: null }));
  fake.upsert.mockReset().mockResolvedValue({ error: null });
  storage = new Map();
  vi.stubGlobal('window', { localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('template persistence with delayed network and auth boundaries', () => {
  it('never exposes or uploads unowned legacy data until explicit import', async () => {
    storage.set(CHART_TEMPLATE_STORAGE_KEY, JSON.stringify([record({ id: 'legacy' })]));
    expect(chartTemplates()).toEqual([]);
    await syncChartTemplates();
    expect(chartTemplates()).toEqual([]);
    expect(fake.upsert).not.toHaveBeenCalled();
    expect(legacyChartTemplates()).toHaveLength(1);
    expect(storage.has(CHART_TEMPLATE_STORAGE_KEY)).toBe(true);
    await importLegacyChartTemplates();
    expect(chartTemplates()).toHaveLength(1);
    expect(chartTemplates()[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.upsert.mock.calls[0][0].user_id).toBe('user-a');
    expect(legacyChartTemplates()).toEqual([]);
  });

  it('clears memory on logout and loads only the next user’s own cache', async () => {
    seed('user-a', [record()]);
    seed('user-b', [record({ id: idB, name: 'Private B' })]);
    await syncChartTemplates();
    fake.auth?.('SIGNED_OUT', null);
    expect(chartTemplates()).toEqual([]);
    fake.user = 'user-b';
    fake.auth?.('SIGNED_IN', { user: { id: 'user-b' } });
    expect(chartTemplates().map(item => item.name)).toEqual(['Private B']);
    await syncChartTemplates();
    expect(fake.upsert.mock.calls.filter(([value]) => value.user_id === 'user-b').map(([value]) => value.name)).toEqual(['Private B']);
    expect(chartTemplateSyncStatus()).toBe('synced');
  });

  it('discards a previous user’s delayed response', async () => {
    const pending = deferred();
    fake.select.mockReturnValueOnce(pending.promise);
    const syncing = syncChartTemplates();
    await tick();
    fake.user = 'user-b';
    fake.auth?.('SIGNED_IN', { user: { id: 'user-b' } });
    pending.resolve({ data: [row(record())], error: null });
    await syncing;
    expect(chartTemplates()).toEqual([]);
    expect(fake.upsert).not.toHaveBeenCalled();
  });

  it('preserves a save made while an older cloud read is pending', async () => {
    const pending = deferred();
    fake.select.mockReturnValueOnce(pending.promise);
    const syncing = syncChartTemplates();
    await tick();
    const saving = saveChartTemplate(record({ id: idB, name: 'New B' }));
    await tick();
    expect(chartTemplates().map(item => item.name)).toEqual(['New B']);
    pending.resolve({ data: [], error: null });
    await Promise.all([syncing, saving]);
    expect(chartTemplates().map(item => item.name)).toEqual(['New B']);
    expect(JSON.parse(storage.get(chartTemplateUserStorageKey('user-a'))!)[0].name).toBe('New B');
  });

  it('keeps a deletion made during an old cloud read as a tombstone', async () => {
    seed('user-a', [record()]);
    const pending = deferred();
    fake.select.mockReturnValueOnce(pending.promise);
    const syncing = syncChartTemplates();
    await tick();
    const deleting = deleteChartTemplate(idA);
    await tick();
    pending.resolve({ data: [row(record())], error: null });
    await Promise.all([syncing, deleting]);
    expect(chartTemplates()).toEqual([]);
    expect(fake.upsert.mock.calls.at(-1)?.[0].value).toEqual({ __alphatradeChartTemplateDeleted: 1 });
  });

  it('a stale device respects a newer remote deletion rather than re-uploading', async () => {
    seed('user-a', [record()]);
    fake.select.mockResolvedValue({ data: [row(record({ deleted: true, updatedAt: '2026-08-02T00:00:00.000Z' }))], error: null });
    await syncChartTemplates();
    expect(chartTemplates()).toEqual([]);
    expect(fake.upsert).not.toHaveBeenCalled();
    resetChartTemplateCache();
    await syncChartTemplates();
    expect(chartTemplates()).toEqual([]);
  });

  it('an offline deletion survives reload and is uploaded on retry', async () => {
    seed('user-a', [record()]);
    fake.select.mockResolvedValue({ data: null, error: { code: 'network' } });
    await deleteChartTemplate(idA);
    expect(chartTemplateSyncStatus()).toBe('offline');
    resetChartTemplateCache();
    fake.select.mockResolvedValue({ data: [row(record())], error: null });
    await syncChartTemplates();
    expect(chartTemplates()).toEqual([]);
    expect(fake.upsert.mock.calls.at(-1)?.[0].value).toEqual({ __alphatradeChartTemplateDeleted: 1 });
    expect(chartTemplateSyncStatus()).toBe('synced');
  });

  it('normalizes legacy UUID once and keeps the identical ID on save/delete', async () => {
    seed('user-a', [record({ id: 'old-local-id' })]);
    await syncChartTemplates();
    const id = chartTemplates()[0].id;
    expect(fake.upsert.mock.calls[0][0].id).toBe(id);
    await deleteChartTemplate(id);
    expect(fake.upsert.mock.calls.at(-1)?.[0].id).toBe(id);
  });

  it('preserves a same-name concurrent creation without overwriting the new winner', async () => {
    seed('user-a', [record({ name: 'Risk_%', updatedAt: '2026-08-03T00:00:00.000Z' })]);
    fake.upsert.mockResolvedValueOnce({ error: { code: '23505' } });
    await syncChartTemplates();
    expect(fake.upsert).toHaveBeenCalledTimes(1);
    expect(chartTemplates().some(item => item.name.includes('obnovená kopie'))).toBe(true);
    expect(chartTemplateSyncStatus()).toBe('offline');
  });

  it('reports sync failure and retries missing-table/permission failures later', async () => {
    fake.select.mockResolvedValueOnce({ data: null, error: { code: '42P01' } });
    await saveChartTemplate(record());
    expect(chartTemplateSyncStatus()).toBe('offline');
    expect(chartTemplates()).toHaveLength(1);
    await syncChartTemplates();
    expect(chartTemplateSyncStatus()).toBe('synced');
    expect(fake.upsert).toHaveBeenCalled();
  });

  it('does not erase another tab’s offline edit when writing its own cache', async () => {
    await syncChartTemplates();
    seed('user-a', [record({ name: 'Other tab' })]);
    fake.select.mockResolvedValue({ data: null, error: { code: 'network' } });
    await saveChartTemplate(record({ id: idB, name: 'This tab' }));
    expect(chartTemplates().map(item => item.name).sort()).toEqual(['Other tab', 'This tab']);
    expect(JSON.parse(storage.get(chartTemplateUserStorageKey('user-a'))!)).toHaveLength(2);
  });

  it('does not retarget a pending save to another account', async () => {
    await syncChartTemplates();
    const saving = saveChartTemplate(record());
    fake.user = 'user-b';
    fake.auth?.('SIGNED_IN', { user: { id: 'user-b' } });
    await saving;
    expect(chartTemplates()).toEqual([]);
    expect(fake.upsert).not.toHaveBeenCalled();
  });

  it('does not discard legacy data or claim local durability when both storage and cloud fail', async () => {
    storage.set(CHART_TEMPLATE_STORAGE_KEY, JSON.stringify([record()]));
    window.localStorage.setItem = () => { throw new Error('quota'); };
    fake.select.mockResolvedValue({ data: null, error: { code: 'network' } });
    await importLegacyChartTemplates();
    expect(chartTemplates()).toHaveLength(1);
    expect(legacyChartTemplates()).toHaveLength(1);
    expect(chartTemplateSyncStatus()).toBe('memory-only');
  });

  it('can explicitly recreate a deleted name with the canonical ID', async () => {
    seed('user-a', [record({ deleted: true })]);
    await saveChartTemplate(record({ id: idB, value: { enabled: false } }));
    expect(chartTemplates()).toMatchObject([{ id: idA, value: { enabled: false } }]);
    expect(fake.upsert.mock.calls.at(-1)?.[0].value).toEqual({ enabled: false });
  });
  it('uses the exact cloud timestamp as a CAS filter and never overwrites an intervening deletion', async () => {
    const old = { ...row(record()), user_id: 'user-a', updated_at: '2026-08-01T00:00:00.000123Z' };
    seed('user-a', [record({ updatedAt: '2026-08-03T00:00:00.000Z' })]);
    fake.select.mockResolvedValue({ data: [old], error: null });
    fake.mutation = (value, filters, op) => {
      expect(op).toBe('update'); expect(filters.updated_at).toBe(old.updated_at); expect(filters.user_id).toBe('user-a');
      return { data: null, error: null }; // Another writer changed that exact version.
    };
    await syncChartTemplates();
    expect(chartTemplateSyncStatus()).toBe('offline');
    expect(chartTemplates().find(item => item.name.includes('obnovená kopie'))?.value).toEqual({ showVwap: true });
  });
  it('does not let a successful new-owner sync erase the failed old-owner legacy import', async () => {
    storage.set(CHART_TEMPLATE_STORAGE_KEY, JSON.stringify([record()]));
    window.localStorage.setItem = () => { throw new Error('quota'); };
    const pending = deferred(); fake.select.mockReturnValueOnce(pending.promise);
    const importing = importLegacyChartTemplates(); await tick(); await tick();
    fake.user = 'user-b'; fake.auth?.('SIGNED_IN', { user: { id: 'user-b' } });
    const syncing = syncChartTemplates();
    pending.resolve({ data: null, error: { code: 'network' } });
    await Promise.all([importing, syncing]);
    expect(storage.has(CHART_TEMPLATE_STORAGE_KEY)).toBe(true);
    expect(storage.has(chartTemplateUserStorageKey('user-a'))).toBe(false);
  });
  it('imports a same-name differing legacy variant as a separate recoverable template', async () => {
    seed('user-a', [record({ value: { color: 'account' } })]);
    storage.set(CHART_TEMPLATE_STORAGE_KEY, JSON.stringify([record({ value: { color: 'legacy' } })]));
    await importLegacyChartTemplates();
    expect(chartTemplates().map(item => item.value)).toContainEqual({ color: 'account' });
    expect(chartTemplates().map(item => item.value)).toContainEqual({ color: 'legacy' });
    expect(chartTemplates().some(item => item.name.includes('obnovená kopie'))).toBe(true);
    expect(storage.has(CHART_TEMPLATE_STORAGE_KEY)).toBe(false);
  });
  it('retains a legacy source modified by another tab during import', async () => {
    storage.set(CHART_TEMPLATE_STORAGE_KEY, JSON.stringify([record()]));
    const pending = deferred(); fake.select.mockReturnValueOnce(pending.promise);
    const importing = importLegacyChartTemplates(); await tick(); await tick();
    const changed = JSON.stringify([record(), record({ id: idB, name: 'Added while importing' })]);
    storage.set(CHART_TEMPLATE_STORAGE_KEY, changed);
    pending.resolve({ data: [], error: null }); await importing;
    expect(storage.get(CHART_TEMPLATE_STORAGE_KEY)).toBe(changed);
  });

  it('retains a later local edit while its previous write awaits acknowledgement', async () => {
    const pending = deferred(); let first = true;
    fake.mutation = async (value, _filters, _op) => {
      if (first) { first = false; await pending.promise; }
      fake.writes.set(value.id, value);
      return { data: { id: value.id }, error: null };
    };
    const initialSave = saveChartTemplate(record({ value: { color: 'first' } }));
    await tick(); await tick();
    const laterSave = saveChartTemplate(record({ value: { color: 'second' } }));
    await tick(); pending.resolve(undefined); await Promise.all([initialSave, laterSave]);
    expect(chartTemplates()).toHaveLength(1);
    expect(chartTemplates()[0].value).toEqual({ color: 'second' });
    expect(chartTemplateSyncStatus()).toBe('synced');
    expect(fake.writes.get(idA).value).toEqual({ color: 'second' });
  });
  it('does not overwrite a newer cloud winner on retry when the local clock is ahead', async () => {
    const baseline = record({ value: { color: 'baseline' } });
    const local = record({ value: { color: 'local' }, updatedAt: '2099-01-01T00:00:00.000Z', cloudUpdatedAt: baseline.updatedAt });
    const winner = record({ value: { color: 'remote' }, updatedAt: '2026-08-03T00:00:00.000Z' });
    seed('user-a', [local]);
    fake.writes.set(idA, { ...row(winner), user_id: 'user-a' });
    await syncChartTemplates();
    expect(fake.upsert).not.toHaveBeenCalled();
    expect(chartTemplates().find(item => item.id === idA)?.value).toEqual({ color: 'remote' });
    expect(chartTemplates().find(item => item.name.includes('obnovená kopie'))?.value).toEqual({ color: 'local' });
    await syncChartTemplates();
    expect(fake.writes.get(idA).value).toEqual({ color: 'remote' });
  });

  it('keeps unsupported entries in a partly importable legacy backup', async () => {
    const source = JSON.stringify([record(), { futureVersion: 2, nestedSettings: { preserve: true } }]);
    storage.set(CHART_TEMPLATE_STORAGE_KEY, source);
    await importLegacyChartTemplates();
    expect(chartTemplates().some(item => item.name === record().name)).toBe(true);
    expect(storage.get(CHART_TEMPLATE_STORAGE_KEY)).toBe(source);
  });

});
