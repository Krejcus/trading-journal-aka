import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260812050246_copier_runtime_state.sql',
  'utf8',
).replace(/\s+/g, ' ').toLowerCase();

describe('copier runtime Supabase migration contract', () => {
  it('zapíná RLS a povoluje klientovi pouze vlastní SELECT', () => {
    expect(migration).toContain('enable row level security');
    expect(migration).toContain('for select to authenticated');
    expect(migration).toContain('(select auth.uid()) is not null');
    expect(migration).toContain('revoke all on table public.copier_runtime_state from public, anon, authenticated');
    expect(migration).toContain('grant select on table public.copier_runtime_state to authenticated');
    expect(migration).not.toMatch(/grant\s+[^;]*(insert|update)[^;]*copier_runtime_state/);
  });

  it('vynucuje všechny zápisy přes zamčenou CAS RPC funkci', () => {
    expect(migration).toContain('security definer set search_path =');
    expect(migration).toContain("raise exception 'auth_required'");
    expect(migration).toContain('and revision = p_expected_revision');
    expect(migration).toContain('revoke all on function public.commit_copier_runtime_state(uuid, bigint, jsonb) from public, anon');
    expect(migration).toContain('grant execute on function public.commit_copier_runtime_state(uuid, bigint, jsonb) to authenticated');
  });

  it('odmítne snapshot bez povinných kolekcí už databázovým constraintem', () => {
    for (const field of [
      'replicated', 'outbox', 'canceloutbox', 'links', 'leadercumqty', 'followerfilltargets',
    ]) {
      expect(migration).toContain(`jsonb_typeof(snapshot -> '${field}') = 'array'`);
    }
    expect(migration).toContain("jsonb_typeof(snapshot -> 'lastsequence') = 'number'");
  });
});
