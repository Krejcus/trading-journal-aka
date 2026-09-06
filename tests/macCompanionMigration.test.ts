import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260901101932_mac_companion_devices_v1.sql',
  'utf8',
).replace(/\s+/g, ' ').toLowerCase();

describe('mac companion Supabase migration contract', () => {
  it('creates isolated server-only tables without changing copier runtime tables', () => {
    expect(migration).toContain('create table public.mac_companion_devices');
    expect(migration).toContain('create table public.mac_companion_pairing_rate_limits');
    expect(migration).not.toContain('alter table public.tradovate_copier_device_runtime');
    expect(migration).not.toContain('alter table public.tradovate_copier_devices');
    expect(migration).not.toContain('create trigger');
  });

  it('enables RLS and grants no browser role direct access', () => {
    expect(migration).toContain('alter table public.mac_companion_devices enable row level security');
    expect(migration).toContain('revoke all on table public.mac_companion_devices from public, anon, authenticated');
    expect(migration).toContain('grant select, insert, update, delete on table public.mac_companion_devices to service_role');
    expect(migration).toContain(
      'alter table public.mac_companion_pairing_rate_limits enable row level security',
    );
    expect(migration).toContain(
      'revoke all on table public.mac_companion_pairing_rate_limits from public, anon, authenticated',
    );
    expect(migration).toContain(
      'grant select, insert, update, delete on table public.mac_companion_pairing_rate_limits to service_role',
    );
    expect(migration).not.toMatch(/grant\s+[^;]+\s+to\s+(anon|authenticated)/);
    expect(migration).not.toContain('create policy');
  });

  it('fixes platform, audience and least-privilege scope and stores digests only', () => {
    expect(migration).toContain("platform = 'macos'");
    expect(migration).toContain("audience = 'mac-companion'");
    expect(migration).toContain("scope = 'copier.status.read'");
    expect(migration).toContain("secret_hash ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("pairing_code_hash is null or pairing_code_hash ~ '^[0-9a-f]{64}$'");
    expect(migration).not.toMatch(/\b(device_secret|pairing_code)\b(?!_hash)/);
  });

  it('requires trimmed names and a non-revoked pending pairing state', () => {
    expect(migration).toContain('device_name = btrim(device_name)');
    expect(migration).toContain('char_length(device_name) between 1 and 120');
    expect(migration).toContain('and revoked_at is null');
  });

  it('rate-limits pairing globally and per HMAC bucket with bounded retention', () => {
    expect(migration).toContain('consume_mac_companion_pairing_start_limit(target_ip_hash text)');
    expect(migration).toContain("bucket_key = 'global' or bucket_key ~ '^ip:[0-9a-f]{64}$'");
    expect(migration).toContain('cardinality(global_hits) >= 120');
    expect(migration).toContain('cardinality(ip_hits) >= 10');
    expect(migration).toContain("pairing_expires_at < observed_at - interval '1 hour'");
    expect(migration).toContain("updated_at < observed_at - interval '1 hour'");
    expect(migration).toContain('limit 200');
    const globalLock = migration.indexOf("where bucket_key = 'global' for update");
    const globalReject = migration.indexOf('cardinality(global_hits) >= 120');
    const globalRejectReturn = migration.indexOf(
      "return jsonb_build_object( 'allowed', false, 'retryafterseconds', retry_after_seconds );",
      globalReject,
    );
    const ipRow = migration.indexOf(
      "insert into public.mac_companion_pairing_rate_limits (bucket_key, hits, updated_at) values (ip_bucket_key",
    );
    expect(globalLock).toBeGreaterThan(-1);
    expect(globalReject).toBeGreaterThan(globalLock);
    expect(globalRejectReturn).toBeGreaterThan(globalReject);
    expect(ipRow).toBeGreaterThan(globalRejectReturn);
    expect(migration).not.toMatch(/consume_mac_companion_pairing_start_limit\([^)]*limit/i);
    expect(migration).toContain(
      'revoke all on function public.consume_mac_companion_pairing_start_limit(text) from public, anon, authenticated',
    );
    expect(migration).toContain(
      'grant execute on function public.consume_mac_companion_pairing_start_limit(text) to service_role',
    );
  });
});
