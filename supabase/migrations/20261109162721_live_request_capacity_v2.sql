-- Local preparation: export remote function/state before approved hosted rollout.
-- Read lanes share one principal lock and total4000 reservation ledger.
-- Existing reservations/cooldowns are never reset. Management writes are NOT measured by this ledger.
create or replace function public.tradovate_request_control_v1(
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
  v_risk_hour bigint; v_risk_minute bigint;
  v_control_hour bigint; v_control_minute bigint;
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
  select coalesce(sum(units) filter(where purpose='background' and valid_until>v_now-interval '1 hour'),0),
         coalesce(sum(units) filter(where purpose='background' and valid_until>v_now-interval '1 minute'),0),
         coalesce(sum(units) filter(where valid_until>v_now-interval '1 hour'),0),
         coalesce(sum(units) filter(where purpose='risk' and valid_until>v_now-interval '1 hour'),0),
         coalesce(sum(units) filter(where purpose='risk' and valid_until>v_now-interval '1 minute'),0),
         coalesce(sum(units) filter(where purpose='control' and valid_until>v_now-interval '1 hour'),0),
         coalesce(sum(units) filter(where purpose='control' and valid_until>v_now-interval '1 minute'),0)
    into v_hour,v_minute,v_total,v_risk_hour,v_risk_minute,v_control_hour,v_control_minute
    from public.tradovate_request_grants where broker_user_id=v_principal and valid_until>v_now-interval '1 hour';
  v_snapshot:=jsonb_build_object('version',1,'brokerUserId',v_principal,'serverNow',floor(extract(epoch from v_now)*1000),
    'epoch',v_row.epoch,'blockedUntil',case when v_row.blocked_until is null then null else floor(extract(epoch from v_row.blocked_until)*1000) end,
    'captchaRequired',v_row.captcha_required,'evidence',v_row.evidence,'reason',v_row.reason,
    'brokerMinimumMs',v_row.broker_minimum_ms,'policyFallbackMs',v_row.policy_fallback_ms,
    'backgroundReservedHour',v_hour,'backgroundReservedMinute',v_minute,
    'policyVersion',2,'riskReservedHour',v_risk_hour,'riskReservedMinute',v_risk_minute,
    'controlReservedHour',v_control_hour,'controlReservedMinute',v_control_minute,'totalReservedHour',v_total);
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
    if (p_purpose='background' and (v_hour+p_units>1200 or v_minute+p_units>40))
      or (p_purpose='risk' and (v_risk_hour+p_units>2400 or v_risk_minute+p_units>80))
      or (p_purpose='control' and (v_control_hour+p_units>240 or v_control_minute+p_units>24))
      or v_total+p_units>4000 then
      select min(valid_until + case when (p_purpose='background' and v_minute+p_units>40)
          or (p_purpose='risk' and v_risk_minute+p_units>80)
          or (p_purpose='control' and v_control_minute+p_units>24) then interval '1 minute' else interval '1 hour' end)
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
