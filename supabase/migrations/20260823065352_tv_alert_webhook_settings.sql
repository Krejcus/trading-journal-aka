-- F2: uživatelské vypínače TradingView alertů a obrázkových náhrad.
-- Připraveno pouze jako soubor; tato úloha migraci neaplikuje.

alter table public.tv_alert_webhooks
  add column alerts_enabled boolean not null default true,
  add column images_enabled boolean not null default true;

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
