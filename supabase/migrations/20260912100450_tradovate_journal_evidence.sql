-- Append-only observations. Device identity and connection ownership are assigned by the API.
create table public.tradovate_journal_evidence (
  ingest_id bigint generated always as identity,
  user_id uuid not null references auth.users(id) on delete cascade,
  connection_id uuid not null references public.tradovate_oauth_connections(id) on delete cascade,
  device_id uuid not null references public.tradovate_copier_devices(id) on delete cascade,
  event_id text not null check (event_id ~ '^[0-9a-f]{64}$'),
  environment text not null check (environment in ('demo', 'live')),
  session_id uuid not null,
  sequence bigint not null check (sequence > 0),
  entity_type text not null,
  received_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) < 8192),
  primary key (user_id, connection_id, event_id),
  unique (user_id, connection_id, session_id, sequence)
);
create index tradovate_journal_evidence_cursor_idx
  on public.tradovate_journal_evidence (user_id, connection_id, ingest_id);
create index tradovate_journal_evidence_time_idx
  on public.tradovate_journal_evidence (user_id, connection_id, received_at);
alter table public.tradovate_journal_evidence enable row level security;
revoke all on public.tradovate_journal_evidence from public, anon, authenticated;
grant select on public.tradovate_journal_evidence to authenticated;
grant select, insert on public.tradovate_journal_evidence to service_role;
grant usage, select on sequence public.tradovate_journal_evidence_ingest_id_seq to service_role;
create policy "Owner reads journal evidence" on public.tradovate_journal_evidence
  for select to authenticated using ((select auth.uid()) = user_id);
