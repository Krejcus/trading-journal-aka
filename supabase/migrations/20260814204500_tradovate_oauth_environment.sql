-- Bind every encrypted OAuth token to the Tradovate execution environment.
-- A LIVE token must never be reused against DEMO (or vice versa).

alter table public.tradovate_oauth_connections
  add column if not exists environment text not null default 'live';

alter table public.tradovate_oauth_connections
  drop constraint if exists tradovate_oauth_environment_valid;

alter table public.tradovate_oauth_connections
  add constraint tradovate_oauth_environment_valid
  check (environment in ('demo', 'live'));

comment on column public.tradovate_oauth_connections.environment is
  'Tradovate token boundary. Tokens are valid only for their recorded live or demo environment.';
