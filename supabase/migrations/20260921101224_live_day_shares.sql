-- Immutable, user-created snapshots for the public LIVE day card.
-- Raw broker identifiers never belong here: the client inserts the already
-- redacted projection and the public server returns only that projection.
create table public.live_day_shares (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  share_token uuid not null unique default gen_random_uuid(),
  trade_date date not null,
  owner_name text not null check (char_length(owner_name) between 1 and 100),
  owner_avatar_url text check (owner_avatar_url is null or char_length(owner_avatar_url) <= 2000),
  summary jsonb not null check (
    jsonb_typeof(summary) = 'object'
    and jsonb_typeof(summary -> 'rows') = 'array'
    and jsonb_array_length(summary -> 'rows') <= 50
  ),
  trades integer check (trades is null or trades >= 0),
  losing_trades integer check (losing_trades is null or losing_trades >= 0),
  theme text not null check (theme in ('dark', 'light', 'oled')),
  preview_path text not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (losing_trades is null or trades is null or losing_trades <= trades),
  check (preview_path = owner_id::text || '/' || share_token::text || '.png')
);

alter table public.live_day_shares enable row level security;
revoke all on table public.live_day_shares from anon, authenticated;
grant select, insert, update, delete on table public.live_day_shares to authenticated;
grant select, insert, update, delete on table public.live_day_shares to service_role;

create policy live_day_shares_owner_select
on public.live_day_shares for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy live_day_shares_owner_insert
on public.live_day_shares for insert
to authenticated
with check ((select auth.uid()) = owner_id);

create policy live_day_shares_owner_update
on public.live_day_shares for update
to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

create policy live_day_shares_owner_delete
on public.live_day_shares for delete
to authenticated
using ((select auth.uid()) = owner_id);

-- Preview files stay private. Social crawlers receive them through the
-- token-checked server endpoint, never through a permanent public Storage URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('live-day-share-previews', 'live-day-share-previews', false, 5000000, array['image/png'])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy live_day_share_preview_owner_insert
on storage.objects for insert
to authenticated
with check (
  bucket_id = 'live-day-share-previews'
  and (storage.foldername(name))[1] = (select auth.uid())::text
);

create policy live_day_share_preview_owner_delete
on storage.objects for delete
to authenticated
using (
  bucket_id = 'live-day-share-previews'
  and owner_id = (select auth.uid())::text
);
