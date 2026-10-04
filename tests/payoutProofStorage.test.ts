import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ patch: Record<string, unknown>; filters: Array<[string, unknown]> }>,
  uploads: [] as Array<{ path: string; type?: string }>,
  removed: [] as string[][],
  signed: [] as string[][],
}));

vi.mock('../services/supabase', () => {
  const from = (table: string) => {
    if (table !== 'business_payouts') throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({ eq: async () => ({ data: db.rows, error: null }) }),
      update: (patch: Record<string, unknown>) => {
        const filters: Array<[string, unknown]> = [];
        const chain = {
          eq: (column: string, value: unknown) => { filters.push([column, value]); return chain; },
          select: () => ({ maybeSingle: async () => { db.updates.push({ patch, filters }); return { data: { id: 'x' }, error: null }; } }),
        };
        return chain;
      },
    };
  };
  const bucket = {
    upload: async (path: string, _blob: Blob, options: { contentType?: string }) => { db.uploads.push({ path, type: options.contentType }); return { error: null }; },
    createSignedUrls: async (paths: string[]) => { db.signed.push(paths); return { data: paths.map(path => ({ path, signedUrl: `https://cdn.test/${path}?sig`, error: null })), error: null }; },
    remove: async (paths: string[]) => { db.removed.push(paths); return { data: [], error: null }; },
  };
  return {
    supabase: {
      auth: { onAuthStateChange: vi.fn(), getSession: async () => ({ data: { session: { user: { id: 'u1' } } } }) },
      from,
      storage: { from: () => bucket },
    },
  };
});

import { storageService } from '../services/storageService';
import { dataUrlToBlob } from '../services/payoutProofStorage';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('payout proofs in storage', () => {
  beforeEach(() => { db.rows = []; db.updates = []; db.uploads = []; db.removed = []; db.signed = []; });

  it('nové důkazy vrací jako podepsané odkazy podle imagePath', async () => {
    db.rows = [{ id: 'p1', description: JSON.stringify({ imagePath: 'u1/a.png', notes: 'x' }), updated_at: '2026-10-01' }];
    await expect(storageService.prefetchPayoutImages()).resolves.toEqual(new Map([['p1', 'https://cdn.test/u1/a.png?sig']]));
    expect(db.signed).toEqual([['u1/a.png']]);
    expect(db.uploads).toEqual([]);
  });

  it('starý base64 důkaz zobrazí hned a na pozadí ho přesune do úložiště bez ztráty dat', async () => {
    const image = 'data:image/png;base64,cHJvb2Y=';
    db.rows = [{ id: 'p2', description: JSON.stringify({ image, accountId: 'acc', grossAmount: 926 }), updated_at: '2026-07-26T15:55:48+00:00' }];
    await expect(storageService.prefetchPayoutImages()).resolves.toEqual(new Map([['p2', image]]));
    await flush(); await flush();
    expect(db.uploads).toHaveLength(1);
    expect(db.uploads[0].path).toMatch(/^u1\/[0-9a-f-]+\.png$/);
    expect(db.uploads[0].type).toBe('image/png');
    expect(db.updates).toHaveLength(1);
    const written = JSON.parse(String(db.updates[0].patch.description));
    expect(written).toEqual({ accountId: 'acc', grossAmount: 926, imagePath: db.uploads[0].path });
    // přepis jen když se řádek mezitím nezměnil
    expect(db.updates[0].filters).toEqual([['id', 'p2'], ['user_id', 'u1'], ['updated_at', '2026-07-26T15:55:48+00:00']]);
  });

  it('rozloží data URL na typ a bajty', async () => {
    const { blob, type, ext } = dataUrlToBlob('data:image/jpeg;base64,/9j/4A==');
    expect(type).toBe('image/jpeg');
    expect(ext).toBe('jpg');
    expect(blob.size).toBe(4);
    expect(() => dataUrlToBlob('data:application/pdf;base64,AAAA')).toThrow(/Nepodporovaný/);
  });
});
