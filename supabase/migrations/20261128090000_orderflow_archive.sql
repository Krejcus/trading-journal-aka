-- Archiv order flow po obchodních dnech (docs/reviews/orderflow-history-archive-design-20261127.md, část C).
-- Soubory den po dni nahrává Mac přes Edge Function `orderflow-archive` (účelový klíč, servisní role).
-- Klienti jen ČTOU svou složku a své řádky; zapisovat, přepisovat ani mazat nesmí nikdo z klientů.
-- JEN ZOBRAZENÍ (INV-UI-04): nic z archivu nevstupuje do příkazů.

create table if not exists public.orderflow_archive_days (
  user_id uuid not null references auth.users (id) on delete cascade,
  root text not null default 'NQ' check (root = 'NQ'),
  contract text not null check (contract ~ '^NQ[HMUZ][0-9]$'),
  trade_date date not null,
  source text not null check (source in ('live', 'backfill', 'merged')),
  object_path text not null,
  bytes integer not null check (bytes > 0 and bytes <= 3145728),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  minutes integer not null check (minutes >= 0),
  trades integer not null check (trades >= 0),
  exact_minutes integer not null default 0 check (exact_minutes >= 0),
  flow_volume bigint not null check (flow_volume >= 0),
  candle_volume bigint check (candle_volume is null or candle_volume >= 0),
  uploaded_at timestamptz not null default now(),
  primary key (user_id, contract, trade_date)
);

create index if not exists orderflow_archive_days_user_date_idx on public.orderflow_archive_days (user_id, trade_date);

alter table public.orderflow_archive_days enable row level security;
revoke all on public.orderflow_archive_days from anon;
revoke insert, update, delete, truncate on public.orderflow_archive_days from authenticated;
grant select on public.orderflow_archive_days to authenticated;

drop policy if exists orderflow_archive_days_read_own on public.orderflow_archive_days;
create policy orderflow_archive_days_read_own on public.orderflow_archive_days
  for select to authenticated
  using ((select auth.uid()) = user_id);

-- Soukromý bucket: jen gzip, nejvýš 3 MB na den.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('orderflow-archive', 'orderflow-archive', false, 3145728, array['application/gzip'])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Čtení jen vlastní složky `<user_id>/…`. Zápis, změny a mazání klienti nemají (žádná politika = zakázáno).
drop policy if exists orderflow_archive_read_own on storage.objects;
create policy orderflow_archive_read_own on storage.objects
  for select to authenticated
  using (bucket_id = 'orderflow-archive' and (storage.foldername(name))[1] = (select auth.uid())::text);
