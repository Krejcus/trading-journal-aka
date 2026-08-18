import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  new URL('../supabase/migrations/20260814172719_tradovate_oauth_connections.sql', import.meta.url),
  'utf8',
);
const environmentSql = readFileSync(
  new URL('../supabase/migrations/20260814204500_tradovate_oauth_environment.sql', import.meta.url),
  'utf8',
);
const multipleConnectionsSql = readFileSync(
  new URL('../supabase/migrations/20260815070500_tradovate_multiple_oauth_connections.sql', import.meta.url),
  'utf8',
);
const persistentDisconnectSql = readFileSync(
  new URL('../supabase/migrations/20260815052416_preserve_disconnected_tradovate_connections.sql', import.meta.url),
  'utf8',
);
const accountCreationWindowSql = readFileSync(
  new URL('../supabase/migrations/20260815135753_tradovate_account_creation_history_window.sql', import.meta.url),
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

  it('váže uložený token na explicitní LIVE nebo DEMO prostředí', () => {
    expect(environmentSql).toContain("environment text not null default 'live'");
    expect(environmentSql).toContain("check (environment in ('demo', 'live'))");
  });

  it('zachová tokeny a změní identitu na více připojení pod jedním uživatelem', () => {
    expect(multipleConnectionsSql).toContain('add column if not exists id uuid');
    expect(multipleConnectionsSql).toContain('primary key (id)');
    expect(multipleConnectionsSql).toContain('(user_id, environment, tradovate_user_id)');
    expect(multipleConnectionsSql).not.toMatch(/drop table/i);
    expect(multipleConnectionsSql).not.toMatch(/delete from/i);
  });

  it('po odpojení zachová identitu připojení, ale dovolí bezpečně odstranit broker tokeny', () => {
    expect(persistentDisconnectSql).toContain('alter column encrypted_access_token drop not null');
    expect(persistentDisconnectSql).toContain('alter column access_token_expires_at drop not null');
    expect(persistentDisconnectSql).toContain("connection_status in ('connected', 'disconnected')");
    expect(persistentDisconnectSql).not.toMatch(/drop table/i);
    expect(persistentDisconnectSql).not.toMatch(/delete from/i);
  });

  it('zálohuje frontu a nahrazuje jen prázdné historické scany 12měsíčním fallbackem', () => {
    expect(accountCreationWindowSql).toContain('tradovate_history_syncs_pre_account_origin_20260815');
    expect(accountCreationWindowSql).toContain("history_start_basis in ('account_created_at', 'rolling_12_months')");
    expect(accountCreationWindowSql).toContain('where rows_imported = 0');
    expect(accountCreationWindowSql).toContain("requested_end::date - interval '1 year'");
    expect(accountCreationWindowSql).not.toMatch(/delete from/i);
    expect(accountCreationWindowSql).not.toMatch(/drop table/i);
  });
});
