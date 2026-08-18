-- Stav copier incidentů pro vzdálený watchdog.
--
-- Serverový cron každou minutu čte heartbeat workera
-- (tradovate_copier_device_runtime) a při problému posílá Web Push.
-- Cron je bezstavový, takže deduplikace („incident už byl ohlášen")
-- a detekce zotavení („pošli 'obnoveno'") potřebují tenhle záznam.
--
-- Řádek = jeden druh incidentu na jednom zařízení. Speciální klíče
-- s prefixem `state:` jsou interní markery pro detekci hran
-- (armed -> disarmed) a nikdy se z nich neposílá notifikace.

create table public.copier_alert_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null,
  incident_key text not null check (char_length(incident_key) between 1 and 64),
  active boolean not null default true,
  detected_at timestamptz not null default now(),
  notified_at timestamptz,
  resolved_at timestamptz,
  detail text,
  updated_at timestamptz not null default now(),
  primary key (user_id, device_id, incident_key)
);

alter table public.copier_alert_state enable row level security;

create policy "copier_alert_state_select_own" on public.copier_alert_state
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

-- Zapisuje výhradně serverový cron přes service_role; klient jen čte.
revoke all on table public.copier_alert_state from public, anon, authenticated;
grant select on table public.copier_alert_state to authenticated;
grant select, insert, update, delete on table public.copier_alert_state to service_role;

comment on table public.copier_alert_state is
  'Deduplikace a recovery stav vzdálených copier alertů; plní serverový cron.';
