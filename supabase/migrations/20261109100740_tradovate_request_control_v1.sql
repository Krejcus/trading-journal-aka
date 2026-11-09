-- Local preparation only. Export the affected remote schema/data and obtain
-- explicit approval before applying this migration to hosted Supabase.
create table public.tradovate_request_control (
  broker_user_id bigint primary key check (broker_user_id > 0),
  epoch bigint not null default 0 check (epoch >= 0),
  blocked_until timestamptz,
  captcha_required boolean not null default false,
  evidence text check (evidence in ('raw-429','retry-after','p-time','captcha')),
  reason text,
  broker_minimum_ms bigint,
  policy_fallback_ms bigint,
  updated_at timestamptz not null default clock_timestamp()
);
create table public.tradovate_request_grants (
  id uuid primary key,
  broker_user_id bigint not null references public.tradovate_request_control(broker_user_id),
  owner_user_id uuid not null,
  connection_id uuid not null,
  purpose text not null check (purpose in ('background','risk','entry','control')),
  units integer not null check (units between 1 and 64),
  ttl_ms integer not null check (ttl_ms between 1 and 15000),
  issued_at timestamptz not null,
  valid_until timestamptz not null,
  epoch bigint not null,
  check (valid_until > issued_at)
);
create index tradovate_request_grants_scope_window_idx on public.tradovate_request_grants (broker_user_id, valid_until);
create index tradovate_request_grants_expiry_idx on public.tradovate_request_grants (valid_until);
alter table public.tradovate_request_control enable row level security;
alter table public.tradovate_request_grants enable row level security;
revoke all on table public.tradovate_request_control, public.tradovate_request_grants from public, anon, authenticated;
grant select, insert, update, delete on public.tradovate_request_control, public.tradovate_request_grants to service_role;

-- SECURITY INVOKER: service-role callers must separately authenticate the app
-- user/device. This function repeats owner/connection checks before deriving
-- the global broker principal. No network work occurs under the row lock.
create function public.tradovate_request_control_v1(
  p_owner_user_id uuid,
  p_connection_id uuid,
  p_mode text,
  p_grant_id uuid default null,
  p_purpose text default null,
  p_units integer default null,
  p_ttl_ms integer default null,
  p_evidence text default null,
  p_retry_after_ms bigint default null,
  p_reason text default null,
  p_captcha_required boolean default false,
  p_broker_minimum_ms bigint default null,
  p_policy_fallback_ms bigint default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_principal bigint;
  v_now timestamptz;
  v_row public.tradovate_request_control%rowtype;
  v_grant public.tradovate_request_grants%rowtype;
  v_hour bigint;
  v_minute bigint;
  v_total bigint;
  v_snapshot jsonb;
  v_until timestamptz;
  v_retry timestamptz;
begin
  perform set_config('lock_timeout', '1500ms', true);
  select c.tradovate_user_id into v_principal
    from public.tradovate_oauth_connections c
    where c.id = p_connection_id and c.user_id = p_owner_user_id
      and c.connection_status = 'connected';
  if not found then raise exception 'tradovate-request-connection-forbidden' using errcode = '42501'; end if;
  if v_principal is null or v_principal <= 0 then
    return jsonb_build_object('allowed',false,'code','tradovate-request-identity-unavailable');
  end if;
  if p_mode is null or p_mode not in ('read','reserve','penalize') then raise exception 'invalid-request-control-mode' using errcode='22023'; end if;
  if p_mode='reserve' and (p_grant_id is null or p_purpose is null or p_purpose not in ('background','risk','entry','control')
    or p_units is null or p_units not between 1 and 64 or p_ttl_ms is null or p_ttl_ms not between 1 and 15000) then
    raise exception 'invalid-request-control-reservation' using errcode='22023';
  end if;
  if p_mode='penalize' and (p_evidence is null or p_evidence not in ('raw-429','retry-after','p-time','captcha')
    or p_retry_after_ms is null or p_retry_after_ms not between 0 and 8000000000000000
    or p_broker_minimum_ms is not null and p_broker_minimum_ms not between 0 and 8000000000000000
    or p_policy_fallback_ms is not null and p_policy_fallback_ms not between 0 and 8000000000000000
    or p_evidence='captcha' and not p_captcha_required) then
    raise exception 'invalid-request-control-penalty' using errcode='22023';
  end if;
  insert into public.tradovate_request_control(broker_user_id) values(v_principal) on conflict do nothing;
  select * into v_row from public.tradovate_request_control where broker_user_id=v_principal for update;
  -- Clock is captured AFTER obtaining the lock: blocked time is not charged to
  -- a shorter grant and an old waiter cannot admit against stale wall time.
  v_now := clock_timestamp();
  delete from public.tradovate_request_grants where broker_user_id=v_principal and valid_until < v_now-interval '24 hours';
  if p_mode='penalize' then
    v_until := v_now + make_interval(secs => greatest(p_retry_after_ms,coalesce(p_broker_minimum_ms,0),coalesce(p_policy_fallback_ms,0),case when p_evidence='raw-429' then 3600000 else 0 end)::double precision/1000);
    update public.tradovate_request_control set
      blocked_until=greatest(blocked_until,v_until),
      captcha_required=captcha_required or p_captcha_required,
      epoch=epoch+case when blocked_until is null or v_until>blocked_until or p_captcha_required and not captcha_required then 1 else 0 end,
      evidence=case when captcha_required or p_captcha_required then 'captcha' when blocked_until is null or v_until>blocked_until then p_evidence else evidence end,
      reason=case when captcha_required or p_captcha_required or blocked_until is null or v_until>blocked_until then left(coalesce(p_reason,'broker-request-penalty'),200) else reason end,
      broker_minimum_ms=case when blocked_until is null or v_until>blocked_until then p_broker_minimum_ms else broker_minimum_ms end,
      policy_fallback_ms=case when blocked_until is null or v_until>blocked_until then p_policy_fallback_ms else policy_fallback_ms end,
      updated_at=v_now where broker_user_id=v_principal returning * into v_row;
  end if;
  select coalesce(sum(units) filter(where purpose<>'entry' and valid_until>v_now-interval '1 hour'),0),
         coalesce(sum(units) filter(where purpose<>'entry' and valid_until>v_now-interval '1 minute'),0),
         coalesce(sum(units) filter(where valid_until>v_now-interval '1 hour'),0)
    into v_hour,v_minute,v_total from public.tradovate_request_grants where broker_user_id=v_principal and valid_until>v_now-interval '1 hour';
  v_snapshot:=jsonb_build_object('version',1,'brokerUserId',v_principal,'serverNow',floor(extract(epoch from v_now)*1000),
    'epoch',v_row.epoch,'blockedUntil',case when v_row.blocked_until is null then null else floor(extract(epoch from v_row.blocked_until)*1000) end,
    'captchaRequired',v_row.captcha_required,'evidence',v_row.evidence,'reason',v_row.reason,
    'brokerMinimumMs',v_row.broker_minimum_ms,'policyFallbackMs',v_row.policy_fallback_ms,
    'backgroundReservedHour',v_hour,'backgroundReservedMinute',v_minute);
  if p_mode<>'reserve' then return jsonb_build_object('allowed',true,'snapshot',v_snapshot); end if;
  if v_row.captcha_required or v_row.blocked_until>v_now then
    return jsonb_build_object('allowed',false,'code',case when v_row.captcha_required then 'tradovate-request-captcha' else 'tradovate-request-cooldown' end,
      'retryAfterMs',greatest(0,floor(extract(epoch from(v_row.blocked_until-v_now))*1000)),'snapshot',v_snapshot);
  end if;
  select * into v_grant from public.tradovate_request_grants where id=p_grant_id;
  if found then
    if v_grant.broker_user_id<>v_principal or v_grant.owner_user_id<>p_owner_user_id or v_grant.connection_id<>p_connection_id
      or v_grant.units<>p_units or v_grant.purpose<>p_purpose or v_grant.ttl_ms<>p_ttl_ms then
      raise exception 'tradovate-request-grant-conflict' using errcode='22023';
    end if;
    if v_grant.valid_until<=v_now or v_grant.epoch<>v_row.epoch then
      return jsonb_build_object('allowed',false,'code','tradovate-request-grant-expired','snapshot',v_snapshot);
    end if;
  else
    if (p_purpose<>'entry' and (v_hour+p_units>3000 or v_minute+p_units>120)) or v_total+p_units>4000 then
      select min(valid_until + case when p_purpose<>'entry' and v_minute+p_units>120 then interval '1 minute' else interval '1 hour' end)
        into v_retry from public.tradovate_request_grants where broker_user_id=v_principal and valid_until>v_now-interval '1 hour';
      return jsonb_build_object('allowed',false,'code','tradovate-request-budget','retryAfterMs',greatest(1000,floor(extract(epoch from(v_retry-v_now))*1000)),'snapshot',v_snapshot);
    end if;
    insert into public.tradovate_request_grants(id,broker_user_id,owner_user_id,connection_id,purpose,units,ttl_ms,issued_at,valid_until,epoch)
      values(p_grant_id,v_principal,p_owner_user_id,p_connection_id,p_purpose,p_units,p_ttl_ms,v_now,v_now+make_interval(secs=>p_ttl_ms::double precision/1000),v_row.epoch)
      returning * into v_grant;
  end if;
  return jsonb_build_object('allowed',true,'grant',jsonb_build_object('version',1,'grantId',v_grant.id,'brokerUserId',v_principal,
    'purpose',v_grant.purpose,'units',v_grant.units,'serverNow',floor(extract(epoch from v_now)*1000),
    'validUntil',floor(extract(epoch from v_grant.valid_until)*1000),'epoch',v_grant.epoch));
end $$;
revoke all on function public.tradovate_request_control_v1(uuid,uuid,text,uuid,text,integer,integer,text,bigint,text,boolean,bigint,bigint) from public,anon,authenticated;
grant execute on function public.tradovate_request_control_v1(uuid,uuid,text,uuid,text,integer,integer,text,bigint,text,boolean,bigint,bigint) to service_role;
comment on table public.tradovate_request_control is 'Global broker-user request cooldown. No tokens; separate from copier day lock and incident state.';
comment on table public.tradovate_request_grants is 'Conservative reserved capacity, not a count of broker-accepted requests. Grants are discarded by clients after restart.';
