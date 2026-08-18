-- Keep a safe, reconnectable connection shell after a user disconnects.
-- Broker credentials are removed immediately; reconnect always requires a new
-- Tradovate OAuth authorization and writes fresh encrypted tokens.

alter table public.tradovate_oauth_connections
  alter column encrypted_access_token drop not null,
  alter column access_token_expires_at drop not null,
  add column if not exists connection_status text not null default 'connected',
  add column if not exists disconnected_at timestamptz,
  add column if not exists disconnect_reason text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tradovate_oauth_connections_status_valid'
      and conrelid = 'public.tradovate_oauth_connections'::regclass
  ) then
    alter table public.tradovate_oauth_connections
      add constraint tradovate_oauth_connections_status_valid
      check (connection_status in ('connected', 'disconnected'));
  end if;
end $$;

update public.tradovate_oauth_connections
set connection_status = 'connected'
where encrypted_access_token is not null;

comment on column public.tradovate_oauth_connections.connection_status is
  'User-visible connection shell state. Disconnected rows contain no usable broker credentials.';

comment on column public.tradovate_oauth_connections.disconnected_at is
  'Timestamp of the most recent explicit disconnect.';

comment on column public.tradovate_oauth_connections.disconnect_reason is
  'Non-sensitive reason for the disconnected state.';
