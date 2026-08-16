-- Crash-safe snapshot copieru. Migrace je připravená lokálně; před jejím
-- nasazením je nutný samostatný backup/export vzdálené databáze.

create table public.copier_runtime_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  runtime_id uuid not null,
  revision bigint not null default 0 check (revision >= 0),
  snapshot jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, runtime_id),
  constraint copier_runtime_state_snapshot_shape check (
    jsonb_typeof(snapshot) = 'object'
    and jsonb_typeof(snapshot -> 'replicated') = 'array'
    and jsonb_typeof(snapshot -> 'lastSequence') = 'number'
    and jsonb_typeof(snapshot -> 'outbox') = 'array'
    and jsonb_typeof(snapshot -> 'cancelOutbox') = 'array'
    and jsonb_typeof(snapshot -> 'links') = 'array'
    and jsonb_typeof(snapshot -> 'leaderCumQty') = 'array'
    and jsonb_typeof(snapshot -> 'followerFillTargets') = 'array'
  )
);

create index copier_runtime_state_user_updated_idx
  on public.copier_runtime_state (user_id, updated_at desc);

alter table public.copier_runtime_state enable row level security;

create policy "copier_runtime_state_select_own" on public.copier_runtime_state
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

-- Přímý zápis by obešel compare-and-swap revizi. Klient smí tabulku jen číst;
-- každý insert/update vede přes níže uvedenou jedinou RPC funkci.
revoke all on table public.copier_runtime_state from public, anon, authenticated;
grant select on table public.copier_runtime_state to authenticated;

-- Jediný atomický compare-and-swap. SECURITY DEFINER je nutný, protože klient
-- nemá přímé INSERT/UPDATE granty. Funkce sama vynucuje auth.uid(), má prázdný
-- search_path a po vytvoření jí odebereme implicitní EXECUTE od PUBLIC/anon.
create or replace function public.commit_copier_runtime_state(
  p_runtime_id uuid,
  p_expected_revision bigint,
  p_snapshot jsonb
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_revision bigint;
  v_actual bigint;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_runtime_id is null or p_expected_revision < 0 or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'INVALID_COPIER_SNAPSHOT';
  end if;

  if p_expected_revision = 0 then
    insert into public.copier_runtime_state (user_id, runtime_id, revision, snapshot)
    values (v_user_id, p_runtime_id, 1, p_snapshot)
    on conflict (user_id, runtime_id) do nothing
    returning revision into v_revision;
  else
    update public.copier_runtime_state
       set revision = revision + 1,
           snapshot = p_snapshot,
           updated_at = now()
     where user_id = v_user_id
       and runtime_id = p_runtime_id
       and revision = p_expected_revision
    returning revision into v_revision;
  end if;

  if v_revision is null then
    select revision into v_actual
      from public.copier_runtime_state
     where user_id = v_user_id and runtime_id = p_runtime_id;
    raise exception 'COPIER_REVISION_CONFLICT expected=% actual=%',
      p_expected_revision, coalesce(v_actual, -1);
  end if;
  return v_revision;
end;
$$;

revoke all on function public.commit_copier_runtime_state(uuid, bigint, jsonb) from public, anon;
grant execute on function public.commit_copier_runtime_state(uuid, bigint, jsonb) to authenticated;

comment on table public.copier_runtime_state is
  'Per-user crash-recovery snapshot copieru; neobsahuje OAuth tokeny ani broker credentials.';
