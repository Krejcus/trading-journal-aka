-- One AlphaTrade user may connect multiple independent Tradovate logins
-- (for example multiple prop firms). Existing encrypted tokens are preserved.

alter table public.tradovate_oauth_connections
  add column if not exists id uuid default gen_random_uuid(),
  add column if not exists organization_name text;

update public.tradovate_oauth_connections
set id = gen_random_uuid()
where id is null;

alter table public.tradovate_oauth_connections
  alter column id set not null;

alter table public.tradovate_oauth_connections
  drop constraint if exists tradovate_oauth_connections_pkey;

alter table public.tradovate_oauth_connections
  add constraint tradovate_oauth_connections_pkey primary key (id);

create index if not exists tradovate_oauth_connections_user_environment_idx
  on public.tradovate_oauth_connections (user_id, environment, connected_at);

create unique index if not exists tradovate_oauth_connections_identity_idx
  on public.tradovate_oauth_connections (user_id, environment, tradovate_user_id)
  where tradovate_user_id is not null;

comment on column public.tradovate_oauth_connections.id is
  'Stable AlphaTrade connection ID used to select and disconnect one OAuth login.';

comment on column public.tradovate_oauth_connections.organization_name is
  'Organization reported by Tradovate auth/me for the connected login.';
