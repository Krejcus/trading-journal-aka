-- ============================================================================
-- Vlož CELÝ tento soubor do Supabase SQL editoru a spusť jedním Run.
-- Projekt: kopinlpdvjfgmvxydohk (Alpha trade)
--
-- Obsahuje dvě migrace z 2026-08-23 plus zápis do schema_migrations, aby
-- historie migrací zůstala konzistentní (db push je kvůli rozejité historii
-- nepoužitelný, viz docs/PROJECT_LOG.md).
--
-- Je to idempotentní: opakované spuštění neublíží.
-- ============================================================================

begin;

-- ── 20260823065352: přepínače TradingView alertů ───────────────────────────
alter table public.tv_alert_webhooks
  add column if not exists alerts_enabled boolean not null default true,
  add column if not exists images_enabled boolean not null default true;

grant update (alerts_enabled, images_enabled)
  on table public.tv_alert_webhooks
  to authenticated;

drop policy if exists tv_alert_webhooks_update_own on public.tv_alert_webhooks;
create policy tv_alert_webhooks_update_own
  on public.tv_alert_webhooks
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ── 20260823070913: potvrzení nových účtů v onboardingu ────────────────────
alter table public.tradovate_account_profiles
  add column if not exists onboarded_at timestamptz null;

-- Účty, které existovaly před onboardingem, jsou už zkontrolované — jinak by
-- se všechny objevily v sekci „nové účty ke kontrole".
update public.tradovate_account_profiles
set onboarded_at = now()
where onboarded_at is null;

-- Záměrně žádné granty pro `authenticated`: browser tuhle tabulku nikdy nečte
-- ani nezapisuje přímo (viz migrace 20260815040436). Všechno jde přes Vercel
-- funkci, která ověří JWT a píše service_role klíčem.

comment on column public.tradovate_account_profiles.onboarded_at is
  'Čas explicitního potvrzení profilu uživatelem; NULL znamená nový účet ke kontrole.';

-- ── Zápis do historie migrací ──────────────────────────────────────────────
insert into supabase_migrations.schema_migrations (version, name)
values
  ('20260823065352', 'tv_alert_webhook_settings'),
  ('20260823070913', 'account_profile_onboarding')
on conflict (version) do nothing;

commit;

-- ── Kontrola po spuštění (mělo by vrátit 3 řádky) ──────────────────────────
select table_name, column_name
from information_schema.columns
where (table_name = 'tv_alert_webhooks' and column_name in ('alerts_enabled', 'images_enabled'))
   or (table_name = 'tradovate_account_profiles' and column_name = 'onboarded_at');
