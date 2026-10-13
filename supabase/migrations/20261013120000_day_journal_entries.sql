-- Deník dne: příprava a uzavření každé session (London / NY) a poznámky
-- připíchnuté k času a ceně v grafu dne. Záměrně nová tabulka, ne JSON
-- v daily_preps / daily_reviews: starý Deník ty řádky hromadně přepisuje
-- (30s autosave celého dne) a jeden přepis by smazal poznámky zapsané
-- z jiného zařízení. Tady má každá poznámka vlastní řádek, příprava
-- a uzavření jeden řádek na session.
--
-- written_at = kdy byl záznam poprvé zapsán (příprava / živě / dopsáno
-- zpětně se odvozuje z něj a z časů session). Po vložení se nemění;
-- úpravy ukazuje updated_at. Čas je z klienta (offline zápis), proto jen
-- hrubá kontrola proti budoucnosti — jde o vlastní data uživatele.
-- Před nasazením zálohováno do migration_backups.*_pre_day_journal_20261013.

create table if not exists public.day_journal_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  day date not null,
  session text not null check (session in ('london', 'ny', 'day')),
  kind text not null check (kind in ('prep', 'close', 'note')),
  -- Klíč pro upsert: 'prep:london', 'close:ny', 'note:<uuid>'.
  entry_key text not null,
  data jsonb not null check (jsonb_typeof(data) = 'object' and pg_column_size(data) <= 32768),
  written_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint day_journal_entries_written_at_sane check (written_at <= created_at + interval '10 minutes'),
  constraint day_journal_entries_prep_close_session check (kind = 'note' or session <> 'day'),
  constraint day_journal_entries_entry_key_shape check (
    (kind <> 'note' and entry_key = kind || ':' || session)
    or (kind = 'note' and entry_key ~ '^note:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ),
  -- Jedna příprava a jedno uzavření na session a den; poznámek libovolně.
  -- Pokrývá i dotazy (user_id, day) a FK na user_id.
  constraint day_journal_entries_entry_unique unique (user_id, day, entry_key)
);

comment on table public.day_journal_entries is
  'Owner-only deník dne: příprava/uzavření per session a poznámky v grafu s časem zápisu. Nikdy neautorizuje copier.';

create or replace function public.day_journal_entries_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  -- Čas zápisu, den, session, druh i vlastník jsou po vložení neměnné.
  new.written_at := old.written_at;
  new.created_at := old.created_at;
  new.user_id := old.user_id;
  new.day := old.day;
  new.session := old.session;
  new.kind := old.kind;
  new.entry_key := old.entry_key;
  return new;
end;
$$;

drop trigger if exists day_journal_entries_touch on public.day_journal_entries;
create trigger day_journal_entries_touch
  before update on public.day_journal_entries
  for each row execute function public.day_journal_entries_touch();

alter table public.day_journal_entries enable row level security;
revoke all on public.day_journal_entries from public, anon, authenticated;
grant select, insert, update, delete on public.day_journal_entries to authenticated;
grant select on public.day_journal_entries to service_role;

create policy day_journal_entries_select_own on public.day_journal_entries
  for select to authenticated using ((select auth.uid()) = user_id);
create policy day_journal_entries_insert_own on public.day_journal_entries
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy day_journal_entries_update_own on public.day_journal_entries
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy day_journal_entries_delete_own on public.day_journal_entries
  for delete to authenticated using ((select auth.uid()) = user_id);
