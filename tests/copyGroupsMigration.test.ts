import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../supabase/migrations/20260828174530_copy_groups_cloud_sync.sql', import.meta.url),
  'utf8',
);

describe('copy groups Supabase migration', () => {
  it('vynucuje vlastnictví řádků ve všech CRUD RLS politikách', () => {
    expect(migration).toContain('alter table public.copy_groups enable row level security');
    expect(migration.match(/\(select auth\.uid\(\)\) = user_id/g)).toHaveLength(5);
    for (const operation of ['select', 'insert', 'update', 'delete']) {
      expect(migration).toContain(`for ${operation} to authenticated`);
    }
    expect(migration).toContain('revoke all on table public.copy_groups from public, anon');
    expect(migration).toContain('grant select, insert, update, delete on table public.copy_groups to authenticated');
  });

  it('zakazuje přenést do databáze stav aktivního copieru', () => {
    expect(migration).toContain("config ?& array['id', 'name', 'enabled', 'leaderAccountId', 'followers', 'safety']");
    expect(migration).toContain("config -> 'enabled' = 'false'::jsonb");
    expect(migration).toContain("not (config ? 'localOnly')");
    expect(migration).not.toMatch(/grant .*service_role/i);
  });
});
