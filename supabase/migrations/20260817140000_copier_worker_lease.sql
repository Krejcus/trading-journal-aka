-- Fencing lease pro copier worker.
--
-- Runtime se stěhuje z Macu na trvale běžící kontejner. Tím vzniká riziko,
-- které lokální běh neměl: dva workery naráz. Při deployi se stará a nová
-- instance krátce překrývají a hostitel může kontejner restartovat sám.
-- Dva aktivní workery nad stejnou skupinou znamenají duplicitní objednávky.
--
-- Kontrola „jsem leader?" při startu nestačí. Worker běží hodiny a o tom, že
-- mezitím naběhl jiný, se nedozví. Proto se `fence` předkládá při KAŽDÉM
-- zápisu stavu a zastaralý zápis odmítne databáze, ne aplikace.
--
-- Převzetí lease vždy zvýší `fence`. Starý držitel tím okamžitě ztrácí právo
-- zápisu, aniž by se ho kdokoliv musel doptávat.

create table public.copier_worker_lease (
  user_id uuid not null references auth.users(id) on delete cascade,
  runtime_id uuid not null,
  lease_id uuid not null,
  fence bigint not null default 1 check (fence > 0),
  -- Čitelné označení držitele (region, machine id) pro diagnostiku.
  holder text not null check (length(holder) between 1 and 200),
  acquired_at timestamptz not null default now(),
  heartbeat_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (user_id, runtime_id)
);

alter table public.copier_worker_lease enable row level security;

create policy "copier_worker_lease_select_own" on public.copier_worker_lease
  for select to authenticated
  using ((select auth.uid()) is not null and (select auth.uid()) = user_id);

-- Přímý zápis by obešel inkrement fence. Vše vede přes RPC níže.
revoke all on table public.copier_worker_lease from public, anon, authenticated;
grant select on table public.copier_worker_lease to authenticated;

-- Převzetí lease. Vrací lease_id a fence.
--
-- Aktivní lease jiného držitele se NEPŘEBÍRÁ — worker musí selhat a nechat
-- rozhodnutí na člověku. Vypršelý lease převzít lze; fence se vždy zvýší.
create or replace function public.acquire_copier_worker_lease(
  p_runtime_id uuid,
  p_holder text,
  p_ttl_seconds integer
)
returns table (lease_id uuid, fence bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_new_lease uuid := gen_random_uuid();
  v_expires timestamptz;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_runtime_id is null or p_holder is null or length(p_holder) = 0
     or p_ttl_seconds is null or p_ttl_seconds < 5 or p_ttl_seconds > 3600 then
    raise exception 'INVALID_COPIER_LEASE_REQUEST';
  end if;
  v_expires := now() + make_interval(secs => p_ttl_seconds);

  insert into public.copier_worker_lease as l
    (user_id, runtime_id, lease_id, fence, holder, expires_at)
  values (v_user_id, p_runtime_id, v_new_lease, 1, p_holder, v_expires)
  on conflict (user_id, runtime_id) do update
     set lease_id = v_new_lease,
         fence = l.fence + 1,
         holder = p_holder,
         acquired_at = now(),
         heartbeat_at = now(),
         expires_at = v_expires
   where l.expires_at <= now();

  if not found then
    raise exception 'COPIER_LEASE_HELD';
  end if;

  return query
    select l.lease_id, l.fence
      from public.copier_worker_lease l
     where l.user_id = v_user_id and l.runtime_id = p_runtime_id;
end;
$$;

-- Prodloužení. Selže, jakmile lease převzal někdo jiný nebo už vypršel —
-- worker to má brát jako ztrátu leadershipu a jít do DISARM.
create or replace function public.renew_copier_worker_lease(
  p_runtime_id uuid,
  p_lease_id uuid,
  p_ttl_seconds integer
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_fence bigint;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 5 or p_ttl_seconds > 3600 then
    raise exception 'INVALID_COPIER_LEASE_REQUEST';
  end if;

  update public.copier_worker_lease
     set heartbeat_at = now(),
         expires_at = now() + make_interval(secs => p_ttl_seconds)
   where user_id = v_user_id
     and runtime_id = p_runtime_id
     and lease_id = p_lease_id
     and expires_at > now()
  returning fence into v_fence;

  if v_fence is null then
    raise exception 'COPIER_LEASE_LOST';
  end if;
  return v_fence;
end;
$$;

-- Uvolnění při řízeném vypnutí. Nechává řádek s posledním fence, aby další
-- převzetí opět zvýšilo číslo a staré zápisy nikdy neožily.
create or replace function public.release_copier_worker_lease(
  p_runtime_id uuid,
  p_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := (select auth.uid());
  v_released boolean := false;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  update public.copier_worker_lease
     set expires_at = now()
   where user_id = v_user_id and runtime_id = p_runtime_id and lease_id = p_lease_id;
  get diagnostics v_released = row_count;
  return v_released;
end;
$$;

revoke all on function public.acquire_copier_worker_lease(uuid, text, integer) from public, anon;
revoke all on function public.renew_copier_worker_lease(uuid, uuid, integer) from public, anon;
revoke all on function public.release_copier_worker_lease(uuid, uuid) from public, anon;
grant execute on function public.acquire_copier_worker_lease(uuid, text, integer) to authenticated;
grant execute on function public.renew_copier_worker_lease(uuid, uuid, integer) to authenticated;
grant execute on function public.release_copier_worker_lease(uuid, uuid) to authenticated;

-- Commit stavu nově vyžaduje platný fence.
--
-- Tohle je jádro celé ochrany: worker, který přišel o leadership, tady
-- neprojde, i kdyby o své ztrátě ještě nevěděl. Stará tříparametrová verze
-- se ruší, aby nezůstala cesta, která fence obchází.
drop function if exists public.commit_copier_runtime_state(uuid, bigint, jsonb);

create or replace function public.commit_copier_runtime_state(
  p_runtime_id uuid,
  p_expected_revision bigint,
  p_snapshot jsonb,
  p_fence bigint
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
  v_fence bigint;
  v_expires timestamptz;
begin
  if v_user_id is null then
    raise exception 'AUTH_REQUIRED';
  end if;
  if p_runtime_id is null or p_expected_revision < 0 or jsonb_typeof(p_snapshot) <> 'object' then
    raise exception 'INVALID_COPIER_SNAPSHOT';
  end if;

  select fence, expires_at into v_fence, v_expires
    from public.copier_worker_lease
   where user_id = v_user_id and runtime_id = p_runtime_id;

  if v_fence is null then
    raise exception 'COPIER_LEASE_MISSING';
  end if;
  if v_expires <= now() then
    raise exception 'COPIER_LEASE_EXPIRED';
  end if;
  if p_fence is null or p_fence <> v_fence then
    raise exception 'COPIER_FENCE_STALE expected=% actual=%', p_fence, v_fence;
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

revoke all on function public.commit_copier_runtime_state(uuid, bigint, jsonb, bigint) from public, anon;
grant execute on function public.commit_copier_runtime_state(uuid, bigint, jsonb, bigint) to authenticated;

comment on table public.copier_worker_lease is
  'Fencing lease copier workeru; zajišťuje, že stav zapisuje právě jedna instance.';
