-- Server-only Tradovate OAuth credentials. This migration is prepared locally
-- only. Back up/export the hosted project and obtain explicit approval before
-- applying it remotely.

create table public.tradovate_oauth_connections (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_access_token text not null,
  encrypted_refresh_token text,
  access_token_expires_at timestamptz not null,
  token_type text not null default 'Bearer',
  scope text,
  tradovate_user_id bigint,
  tradovate_email text,
  connected_at timestamptz not null default now(),
  refreshed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint tradovate_oauth_token_type_nonempty check (length(trim(token_type)) > 0),
  constraint tradovate_oauth_access_token_nonempty check (length(encrypted_access_token) > 20),
  constraint tradovate_oauth_refresh_token_nonempty check (
    encrypted_refresh_token is null or length(encrypted_refresh_token) > 20
  )
);

alter table public.tradovate_oauth_connections enable row level security;

-- No browser role may read or mutate broker credentials. Vercel server
-- functions use the service-role key after independently validating the
-- caller's Supabase JWT.
revoke all on table public.tradovate_oauth_connections from public, anon, authenticated;

comment on table public.tradovate_oauth_connections is
  'Server-only encrypted Tradovate OAuth tokens. Never expose through the browser Data API.';
