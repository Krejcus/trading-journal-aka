import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('../supabase/migrations/20260814172719_tradovate_oauth_connections.sql', import.meta.url),
  'utf8',
);

describe('Tradovate OAuth migration security', () => {
  it('zapíná RLS a nedává browser rolím žádný přístup k tokenům', () => {
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('revoke all on table public.tradovate_oauth_connections from public, anon, authenticated');
    expect(sql).not.toMatch(/grant\s+(select|insert|update|delete|all).*tradovate_oauth_connections.*authenticated/i);
    expect(sql).toContain('encrypted_access_token');
    expect(sql).toContain('encrypted_refresh_token');
  });
});
