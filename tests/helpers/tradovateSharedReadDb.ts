import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
export const OWNER = '10000000-0000-4000-8000-000000000001';
export const OTHER_OWNER = '10000000-0000-4000-8000-000000000002';
export const CONNECTION = '20000000-0000-4000-8000-000000000001';
export const SECOND_CONNECTION = '20000000-0000-4000-8000-000000000002';
export const OTHER_CONNECTION = '20000000-0000-4000-8000-000000000003';
export async function sharedReadDb() {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    insert into auth.users values ('${OWNER}'),('${OTHER_OWNER}');
    create table public.tradovate_oauth_connections (
      id uuid primary key, user_id uuid, environment text, connection_status text,
      encrypted_access_token text, tradovate_user_id bigint, scope text, connected_at timestamptz
    );
    insert into public.tradovate_oauth_connections values
      ('${CONNECTION}','${OWNER}','demo','connected','test-only',42,'read','2026-01-01'),
      ('${SECOND_CONNECTION}','${OWNER}','demo','connected','test-only',42,'read','2026-01-01'),
      ('${OTHER_CONNECTION}','${OTHER_OWNER}','demo','connected','test-only',42,'read','2026-01-01');
    grant usage on schema public to service_role, anon, authenticated;
    grant select on public.tradovate_oauth_connections to service_role;`);
  await pg.exec(readFileSync(new URL('../../supabase/migrations/20261112055954_tradovate_shared_read_state.sql', import.meta.url), 'utf8'));
  const client = () => ({ rpc: async (name: string, args: Record<string, unknown>) => {
    if (name !== 'tradovate_shared_read_v1') throw new Error(`unexpected RPC ${name}`);
    try {
      const result = await pg.query<{ result: unknown }>(`select public.tradovate_shared_read_v1(
        $1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text,$7::uuid,$8::jsonb,$9::integer,$10::integer) as result`,
      [args.p_user_id, args.p_connection_id, args.p_environment, args.p_route_key, args.p_channel, args.p_action,
        args.p_lease_id ?? null, args.p_payload == null ? null : JSON.stringify(args.p_payload), args.p_ttl_ms ?? 0, args.p_retry_ms ?? 0]);
      return { data: result.rows[0].result, error: null };
    } catch (error) { return { data: null, error }; }
  } } as unknown as SupabaseClient);
  return { pg, client, context: () => ({ db: client(), userId: OWNER, connectionId: CONNECTION, environment: 'demo' as const, route: 'https://broker.test/v1' }) };
}
