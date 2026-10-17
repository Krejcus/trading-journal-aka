-- Kresby v grafech jako jedna vrstva podle trhu a času (profil deníku).
--
-- Dřív měla každá obrazovka vlastní kresby jen v localStorage prohlížeče
-- (detail obchodu, fullscreen po panelech, Review týdne, Deník dne zvlášť na
-- desktopu a telefonu). Kresba má absolutní kotvy (čas + cena), takže patří
-- k trhu a času: ukáže se v každém grafu, který ten čas zobrazuje, na všech
-- zařízeních. Backtest má kresby dál ve své session (backtest_runs).
--
-- Jedna kresba = jeden řádek. market = rodina kontraktů (MNQ i NQ mají stejnou
-- cenu → 'NQ'). day = pražské datum prvního bodu; carry_forward = zobrazovat i
-- v dalších dnech (HTF úrovně). Smazání je měkké (deleted_at), aby se propsalo
-- na ostatní zařízení; edited_at = čas úpravy na zařízení — starší úprava
-- nikdy nepřepíše novější (trigger). updated_at je čas serveru pro přírůstkové
-- čtení. Automatické vrstvy grafu (id 'auto-*') sem nepatří.
-- Nová tabulka; stávající data se nemění. Nikdy neautorizuje copier.

create table if not exists public.chart_drawings (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  market text not null default 'NQ',
  day date not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  carry_forward boolean not null default false,
  drawing jsonb not null,
  edited_at timestamptz not null default now(),
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint chart_drawings_pkey primary key (user_id, id),
  constraint chart_drawings_id_shape check (char_length(id) between 1 and 120 and id !~ '^auto-'),
  constraint chart_drawings_market check (market in ('NQ')),
  constraint chart_drawings_time_order check (end_time >= start_time),
  constraint chart_drawings_drawing_shape check (
    jsonb_typeof(drawing) = 'object'
    -- coalesce: chybějící points by dal NULL a CHECK s NULL projde.
    and coalesce(jsonb_typeof(drawing -> 'points'), '') = 'array'
    and pg_column_size(drawing) <= 32768
  )
);

comment on table public.chart_drawings is
  'Owner-only kresby v grafech deníku podle trhu a času (mimo backtest). Nikdy neautorizuje copier.';

-- Načtení grafu: kresby dnů v okně a přenesené úrovně; přírůstkové čtení podle updated_at.
create index if not exists chart_drawings_user_day on public.chart_drawings (user_id, day);
create index if not exists chart_drawings_user_updated on public.chart_drawings (user_id, updated_at);
create index if not exists chart_drawings_user_carry on public.chart_drawings (user_id, start_time)
  where carry_forward and deleted_at is null;

create or replace function public.chart_drawings_before_insert()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.created_at := now();
  new.updated_at := now();
  -- Rozjeté hodiny zařízení nesmí poslat úpravu „z budoucnosti“.
  if new.edited_at is null or new.edited_at > now() then
    new.edited_at := now();
  end if;
  return new;
end;
$$;

create or replace function public.chart_drawings_before_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.edited_at is null or new.edited_at > now() then
    new.edited_at := now();
  end if;
  -- Starší úprava (pozdě nahraná z jiného zařízení) novější nepřepíše.
  if new.edited_at < old.edited_at then
    return old;
  end if;
  new.user_id := old.user_id;
  new.id := old.id;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists chart_drawings_insert on public.chart_drawings;
create trigger chart_drawings_insert
  before insert on public.chart_drawings
  for each row execute function public.chart_drawings_before_insert();

drop trigger if exists chart_drawings_update on public.chart_drawings;
create trigger chart_drawings_update
  before update on public.chart_drawings
  for each row execute function public.chart_drawings_before_update();

alter table public.chart_drawings enable row level security;
revoke all on public.chart_drawings from public, anon, authenticated;
grant select, insert, update, delete on public.chart_drawings to authenticated;
grant select on public.chart_drawings to service_role;

drop policy if exists chart_drawings_select_own on public.chart_drawings;
drop policy if exists chart_drawings_insert_own on public.chart_drawings;
drop policy if exists chart_drawings_update_own on public.chart_drawings;
drop policy if exists chart_drawings_delete_own on public.chart_drawings;
create policy chart_drawings_select_own on public.chart_drawings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy chart_drawings_insert_own on public.chart_drawings
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy chart_drawings_update_own on public.chart_drawings
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy chart_drawings_delete_own on public.chart_drawings
  for delete to authenticated using ((select auth.uid()) = user_id);
