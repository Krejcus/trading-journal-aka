-- Upozornění na cenu (2. 11. 2026): sdílená PC ↔ telefon, hlídá Mac worker z IBKR.
--
-- price_alerts = úroveň uživatele a nastavení (nikdy cena z IBKR — INV-UI-04).
-- Stav spouštění (status, last_triggered_at, trigger_count) mění jen RPC; vlastník
-- ho nikdy nepřepíše (trigger), znovuzapnutí jen přes rearm_price_alert s očekávaným
-- trigger_count. version roste s každou úpravou podmínky; spuštění ji nemění.
-- „Jednou“ je atomické v DB: trigger_price_alert pod zámkem řádku. Doručení
-- (price_alert_outbox → APNs / web push) je „aspoň jednou“ s collapse-id.
-- Události a fronta se zakládají v téže transakci jako spuštění, takže pád serveru
-- po spuštění nic neztratí. Rozpočet 20 notifikací / 10 min / uživatel.
-- Nic z toho nikdy nečte kopírka, risk ani day lock (INV-WATCH-01).
-- Žádný tvrdý purge: DELETE v Realtime obchází RLS (rozešle (user_id, id) všem odběratelům
-- tabulky) — mazat jen měkce; kaskáda z auth.users to přijímá jako známé zbytkové riziko.
-- PRAVIDLO: trigger úprav pouští stav spouštění měnit každou roli kromě `authenticated`.
-- Každá nová `security definer` funkce nad price_alerts tak dostane práva serveru — smí
-- vzniknout jen s vlastní kontrolou vlastníka a revoke execute jako funkce níže.

set lock_timeout = '5s';

create or replace function public.price_alert_session_end(p_at timestamptz)
returns timestamptz
language plpgsql
stable
set search_path = ''
as $$
declare
  v_day date := (p_at at time zone 'America/Chicago')::date;
  v_end timestamptz;
begin
  -- Nejbližší konec Tradovate session (17:00 CT) v pracovní den: upozornění založené
  -- o víkendu platí do konce nedělní/pondělní seance, ne do soboty/neděle 17:00.
  for i in 0..8 loop
    v_end := ((v_day + i)::timestamp + time '17:00') at time zone 'America/Chicago';
    if v_end > p_at and extract(isodow from v_day + i) between 1 and 5 then
      return v_end;
    end if;
  end loop;
  return null;
end;
$$;

create table if not exists public.price_alerts (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  symbol text not null default 'MNQ',
  price numeric(12, 2) not null,
  condition text not null default 'cross',
  condition_auto boolean not null default false,
  frequency text not null default 'once',
  expiry text not null default 'session',
  expires_at timestamptz,
  line jsonb not null default '{}'::jsonb,
  channels jsonb not null default '{}'::jsonb,
  note text not null default '',
  status text not null default 'active',
  version bigint not null default 1,
  last_triggered_at timestamptz,
  trigger_count integer not null default 0,
  edited_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_alerts_pkey primary key (user_id, id),
  constraint price_alerts_id_shape check (id ~ '^pa-[0-9a-z-]{1,61}$'),
  constraint price_alerts_symbol check (symbol in ('MNQ', 'NQ')),
  constraint price_alerts_price check (price > 0 and price < 1000000 and mod(price * 4, 1) = 0),
  constraint price_alerts_condition check (condition in ('cross', 'up', 'down')),
  constraint price_alerts_frequency check (frequency in ('once', 'every')),
  constraint price_alerts_expiry check (expiry in ('session', 'gtc')),
  constraint price_alerts_status check (status in ('active', 'triggered', 'expired')),
  constraint price_alerts_line check (jsonb_typeof(line) = 'object' and pg_column_size(line) <= 512),
  constraint price_alerts_channels check (jsonb_typeof(channels) = 'object' and pg_column_size(channels) <= 512),
  constraint price_alerts_note check (char_length(note) <= 80),
  constraint price_alerts_trigger_count check (trigger_count >= 0),
  constraint price_alerts_version check (version >= 1)
);

comment on table public.price_alerts is
  'Owner-only upozornění na cenu (úroveň uživatele, nikdy cena z IBKR). Stav spouštění jen přes RPC. Nikdy neautorizuje copier.';

create index if not exists price_alerts_user_updated on public.price_alerts (user_id, updated_at);
create index if not exists price_alerts_user_active on public.price_alerts (user_id)
  where status = 'active' and deleted_at is null;

create or replace function public.price_alerts_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Nové upozornění vždy začíná hlídat od nuly; klient stav spouštění nepošle.
  new.status := 'active';
  new.last_triggered_at := null;
  new.trigger_count := 0;
  new.version := 1;
  new.created_at := now();
  new.updated_at := now();
  if new.edited_at is null or new.edited_at > now() then
    new.edited_at := now();
  end if;
  if new.deleted_at is not null and new.deleted_at > now() then
    new.deleted_at := now();
  end if;
  new.expires_at := case when new.expiry = 'session' then public.price_alert_session_end(now()) else null end;
  -- Strop 50 živých na uživatele (vypršelá se nepočítají — UI je nezobrazuje a smazat je nejde);
  -- upsert existujícího řádku projde (BEFORE INSERT běží i u ON CONFLICT DO UPDATE).
  perform pg_advisory_xact_lock(hashtextextended('price_alerts:' || new.user_id::text, 0));
  if new.deleted_at is null
    and not exists (select 1 from public.price_alerts a where a.user_id = new.user_id and a.id = new.id)
    and (select count(*) from public.price_alerts a
         where a.user_id = new.user_id and a.deleted_at is null and a.status <> 'expired') >= 50 then
    raise exception 'price-alerts-limit' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create or replace function public.price_alerts_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.user_id := old.user_id;
  new.id := old.id;
  new.created_at := old.created_at;
  new.updated_at := now();
  if current_user = 'authenticated' then
    if new.edited_at is null or new.edited_at > now() then
      new.edited_at := now();
    end if;
    -- Starší úprava (pozdě nahraná z jiného zařízení) novější nepřepíše; smazání je konečné.
    if new.edited_at < old.edited_at or old.deleted_at is not null then
      return old;
    end if;
    if new.deleted_at is not null and new.deleted_at > now() then
      new.deleted_at := now();
    end if;
    -- Stav spouštění vlastník nikdy nemění (znovuzapnutí jen rearm_price_alert).
    new.status := old.status;
    new.last_triggered_at := old.last_triggered_at;
    new.trigger_count := old.trigger_count;
    if (new.symbol, new.price, new.condition, new.condition_auto, new.frequency, new.expiry, new.deleted_at is null)
      is distinct from (old.symbol, old.price, old.condition, old.condition_auto, old.frequency, old.expiry, old.deleted_at is null) then
      -- Jiná podmínka = jiné upozornění: spuštění se starou verzí server odmítne.
      new.version := old.version + 1;
      new.expires_at := case when new.expiry = 'session' then public.price_alert_session_end(now()) else null end;
    else
      new.version := old.version;
      new.expires_at := old.expires_at;
    end if;
    return new;
  end if;
  -- Serverové RPC (security definer) a service_role: obsah vlastníka beze změny.
  new.symbol := old.symbol;
  new.price := old.price;
  new.condition := old.condition;
  new.condition_auto := old.condition_auto;
  new.frequency := old.frequency;
  new.expiry := old.expiry;
  new.line := old.line;
  new.channels := old.channels;
  new.note := old.note;
  new.edited_at := old.edited_at;
  new.deleted_at := old.deleted_at;
  return new;
end;
$$;

drop trigger if exists price_alerts_insert on public.price_alerts;
create trigger price_alerts_insert
  before insert on public.price_alerts
  for each row execute function public.price_alerts_before_insert();

drop trigger if exists price_alerts_update on public.price_alerts;
create trigger price_alerts_update
  before update on public.price_alerts
  for each row execute function public.price_alerts_before_update();

alter table public.price_alerts enable row level security;
revoke all on public.price_alerts from public, anon, authenticated;
grant select, insert, update on public.price_alerts to authenticated;
grant select on public.price_alerts to service_role;

drop policy if exists price_alerts_select_own on public.price_alerts;
drop policy if exists price_alerts_insert_own on public.price_alerts;
drop policy if exists price_alerts_update_own on public.price_alerts;
create policy price_alerts_select_own on public.price_alerts
  for select to authenticated using ((select auth.uid()) = user_id);
create policy price_alerts_insert_own on public.price_alerts
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy price_alerts_update_own on public.price_alerts
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Výchozí nastavení nového upozornění (naposledy uložené), sdílené mezi zařízeními.
create table if not exists public.price_alert_defaults (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade primary key,
  defaults jsonb not null default '{}'::jsonb,
  edited_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint price_alert_defaults_shape check (jsonb_typeof(defaults) = 'object' and pg_column_size(defaults) <= 2048)
);

create or replace function public.price_alert_defaults_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.edited_at is null or new.edited_at > now() then
    new.edited_at := now();
  end if;
  if tg_op = 'UPDATE' then
    if new.edited_at < old.edited_at then
      return old;
    end if;
    new.user_id := old.user_id;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists price_alert_defaults_write on public.price_alert_defaults;
create trigger price_alert_defaults_write
  before insert or update on public.price_alert_defaults
  for each row execute function public.price_alert_defaults_before_write();

alter table public.price_alert_defaults enable row level security;
revoke all on public.price_alert_defaults from public, anon, authenticated;
grant select, insert, update on public.price_alert_defaults to authenticated;

drop policy if exists price_alert_defaults_select_own on public.price_alert_defaults;
drop policy if exists price_alert_defaults_insert_own on public.price_alert_defaults;
drop policy if exists price_alert_defaults_update_own on public.price_alert_defaults;
create policy price_alert_defaults_select_own on public.price_alert_defaults
  for select to authenticated using ((select auth.uid()) = user_id);
create policy price_alert_defaults_insert_own on public.price_alert_defaults
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy price_alert_defaults_update_own on public.price_alert_defaults
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

-- Spuštění: úroveň uživatele v okamžiku spuštění (ne cena z IBKR), kontrakt a čas pozorování.
create table if not exists public.price_alert_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  alert_id text not null,
  trigger_id uuid not null,
  alert_version bigint not null,
  symbol text not null,
  level numeric(12, 2) not null,
  condition text not null,
  front text,
  observed_at timestamptz not null,
  triggered_at timestamptz not null default now(),
  suppressed_reason text,
  constraint price_alert_events_trigger unique (user_id, trigger_id),
  constraint price_alert_events_condition check (condition in ('cross', 'up', 'down')),
  constraint price_alert_events_front check (front is null or front ~ '^(MNQ|NQ)[FGHJKMNQUVXZ][0-9]{1,4}$'),
  constraint price_alert_events_suppressed check (suppressed_reason is null or suppressed_reason in ('budget'))
);

create index if not exists price_alert_events_user_time on public.price_alert_events (user_id, triggered_at desc);

alter table public.price_alert_events enable row level security;
revoke all on public.price_alert_events from public, anon, authenticated;
grant select on public.price_alert_events to authenticated;
grant select on public.price_alert_events to service_role;

drop policy if exists price_alert_events_select_own on public.price_alert_events;
create policy price_alert_events_select_own on public.price_alert_events
  for select to authenticated using ((select auth.uid()) = user_id);

-- Vlastní fronta doručení (odděleně od notification_delivery_outbox kopírky — INV-WATCH-01).
create table if not exists public.price_alert_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid not null references public.price_alert_events(id) on delete cascade,
  channel text not null,
  subscription_id uuid not null,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  lease_token uuid,
  next_attempt_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '15 minutes'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text,
  constraint price_alert_outbox_target unique (event_id, channel, subscription_id),
  constraint price_alert_outbox_channel check (channel in ('apns', 'web')),
  constraint price_alert_outbox_status check (status in ('pending', 'sending', 'retry', 'sent', 'failed', 'expired'))
);

create index if not exists price_alert_outbox_due on public.price_alert_outbox (next_attempt_at)
  where status in ('pending', 'retry', 'sending');
create index if not exists price_alert_outbox_event on public.price_alert_outbox (event_id);
create index if not exists price_alert_outbox_user on public.price_alert_outbox (user_id);
create index if not exists price_alert_events_user_alert on public.price_alert_events (user_id, alert_id);

alter table public.price_alert_outbox enable row level security;
revoke all on public.price_alert_outbox from public, anon, authenticated;
grant select, update on public.price_alert_outbox to service_role;

create or replace function public.trigger_price_alert(
  p_user uuid,
  p_alert text,
  p_version bigint,
  p_trigger uuid,
  p_observed_at timestamptz,
  p_front text
)
returns table (event_id uuid, status text, suppressed boolean)
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
declare
  v_alert public.price_alerts%rowtype;
  v_existing public.price_alert_events%rowtype;
  v_now timestamptz := now();
  v_event uuid;
  v_recent integer;
  v_suppressed boolean := false;
begin
  if p_user is null or p_alert is null or p_version is null or p_trigger is null then
    return query select null::uuid, 'rejected:invalid'::text, false;
    return;
  end if;
  select a.* into v_alert from public.price_alerts a
    where a.user_id = p_user and a.id = p_alert
    for update;
  if not found then
    return query select null::uuid, 'rejected:missing'::text, false;
    return;
  end if;
  -- Opakování téhož křížení (transportní retry) až po zámku: stejné id = stejná událost.
  select e.* into v_existing from public.price_alert_events e
    where e.user_id = p_user and e.trigger_id = p_trigger;
  if found then
    if v_existing.alert_id = p_alert then
      return query select v_existing.id, 'duplicate'::text, v_existing.suppressed_reason is not null;
    else
      return query select null::uuid, 'rejected:trigger-id'::text, false;
    end if;
    return;
  end if;
  if v_alert.deleted_at is not null then
    return query select null::uuid, 'rejected:deleted'::text, false;
    return;
  end if;
  if v_alert.status <> 'active' then
    return query select null::uuid, ('rejected:' || v_alert.status)::text, false;
    return;
  end if;
  if v_alert.expires_at is not null and v_alert.expires_at <= v_now then
    update public.price_alerts a set status = 'expired' where a.user_id = p_user and a.id = p_alert;
    return query select null::uuid, 'rejected:expired'::text, false;
    return;
  end if;
  if v_alert.version <> p_version then
    return query select null::uuid, 'rejected:version'::text, false;
    return;
  end if;
  if v_alert.frequency = 'every' and v_alert.last_triggered_at is not null
    and v_alert.last_triggered_at > v_now - interval '60 seconds' then
    return query select null::uuid, 'rejected:cooldown'::text, false;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('price_alert_budget:' || p_user::text, 0));
  select count(*) into v_recent from public.price_alert_events e
    where e.user_id = p_user and e.triggered_at > v_now - interval '10 minutes' and e.suppressed_reason is null;
  v_suppressed := v_recent >= 20;

  insert into public.price_alert_events (
    user_id, alert_id, trigger_id, alert_version, symbol, level, condition, front, observed_at, triggered_at, suppressed_reason
  ) values (
    p_user, p_alert, p_trigger, v_alert.version, v_alert.symbol, v_alert.price,
    -- Automaticky odvozený směr přepočítává jen hlídač v paměti; událost ho netvrdí.
    case when v_alert.condition_auto then 'cross' else v_alert.condition end,
    case when p_front ~ '^(MNQ|NQ)[FGHJKMNQUVXZ][0-9]{1,4}$' then p_front else null end,
    greatest(least(coalesce(p_observed_at, v_now), v_now), v_now - interval '5 minutes'),
    v_now,
    case when v_suppressed then 'budget' else null end
  ) returning id into v_event;

  update public.price_alerts a set
    last_triggered_at = v_now,
    trigger_count = a.trigger_count + 1,
    status = case when a.frequency = 'once' then 'triggered' else a.status end
  where a.user_id = p_user and a.id = p_alert;

  if not v_suppressed then
    if coalesce(v_alert.channels -> 'phone', 'true'::jsonb) = 'true'::jsonb then
      insert into public.price_alert_outbox (user_id, event_id, channel, subscription_id)
        select p_user, v_event, 'apns', s.id from public.native_push_subscriptions s
        where s.user_id = p_user and s.expired_at is null
        on conflict do nothing;
    end if;
    if coalesce(v_alert.channels -> 'pc', 'true'::jsonb) = 'true'::jsonb then
      insert into public.price_alert_outbox (user_id, event_id, channel, subscription_id)
        select p_user, v_event, 'web', s.id from public.push_subscriptions s
        where s.user_id = p_user and s.expired_at is null
        on conflict do nothing;
    end if;
  end if;

  return query select v_event, 'triggered'::text, v_suppressed;
end;
$$;

create or replace function public.rearm_price_alert(p_alert text, p_expected_trigger_count integer)
returns boolean
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null or p_alert is null or p_expected_trigger_count is null then
    return false;
  end if;
  -- Očekávaný trigger_count: úprava ze zastaralého stavu nesmí znovu zapnout
  -- upozornění, které mezitím znovu spustilo.
  update public.price_alerts a set
    status = 'active',
    version = a.version + 1,
    expires_at = case when a.expiry = 'session' then public.price_alert_session_end(now()) else null end
  where a.user_id = v_user and a.id = p_alert and a.deleted_at is null
    and a.status in ('triggered', 'expired') and a.trigger_count = p_expected_trigger_count;
  return found;
end;
$$;

create or replace function public.expire_price_alerts(p_user uuid default null)
returns integer
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
set plan_cache_mode = force_custom_plan
as $$
declare
  v_count integer;
begin
  -- Dvě větve místo `(p_user is null or …)`: obecný plán by jinak četl celou tabulku (14. 10.).
  if p_user is null then
    update public.price_alerts a set status = 'expired'
      where a.status = 'active' and a.deleted_at is null and a.expires_at is not null and a.expires_at <= now();
  else
    update public.price_alerts a set status = 'expired'
      where a.user_id = p_user and a.status = 'active' and a.deleted_at is null
        and a.expires_at is not null and a.expires_at <= now();
  end if;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke execute on function public.trigger_price_alert(uuid, text, bigint, uuid, timestamptz, text) from public, anon, authenticated;
revoke execute on function public.expire_price_alerts(uuid) from public, anon, authenticated;
revoke execute on function public.rearm_price_alert(text, integer) from public, anon;
grant execute on function public.trigger_price_alert(uuid, text, bigint, uuid, timestamptz, text) to service_role;
grant execute on function public.expire_price_alerts(uuid) to service_role;
grant execute on function public.rearm_price_alert(text, integer) to authenticated;

do $$
declare
  v_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    return;
  end if;
  -- Opakovatelné: tabulka už v publikaci nevadí (částečně proběhlý běh).
  foreach v_table in array array['price_alerts', 'price_alert_defaults', 'price_alert_events'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = v_table
    ) then
      execute format('alter publication supabase_realtime add table public.%I', v_table);
    end if;
  end loop;
end;
$$;
