-- Trvalá vazba broker profilu na journal účet. Migrace je připravená pouze
-- lokálně; před ruční aplikací do produkce je nutná samostatná záloha/export.

alter table public.tradovate_account_profiles
  add column mapped_account_id uuid null;

create index tradovate_account_profiles_user_mapped_account_idx
  on public.tradovate_account_profiles (user_id, mapped_account_id);
