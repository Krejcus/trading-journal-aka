begin;

-- Durable notification delivery, separate from copier discovery/incident state.
-- A failed device remains retryable even after the runtime ring buffer changes.
create table public.notification_delivery_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_key text not null check (event_key ~ '^[0-9a-f]{64}$'),
  channel text not null check (channel in ('apns', 'web')),
  subscription_id uuid not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  status text not null default 'pending' check (status in ('pending', 'sending', 'retry', 'sent', 'expired')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  lease_token uuid,
  next_attempt_at timestamptz not null default now(),
  expires_at timestamptz not null,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, event_key, channel, subscription_id)
);
create index notification_delivery_outbox_ready_idx
  on public.notification_delivery_outbox (next_attempt_at, created_at)
  where status in ('pending', 'retry', 'sending');
create index notification_delivery_outbox_user_idx on public.notification_delivery_outbox (user_id);
alter table public.notification_delivery_outbox enable row level security;
revoke all on table public.notification_delivery_outbox from public, anon, authenticated;
grant select, insert, update, delete on table public.notification_delivery_outbox to service_role;
comment on table public.notification_delivery_outbox is
  'Server-only per-event/per-device notification outbox. Stable key, CAS lease, bounded retries; sent means provider acceptance, not physical delivery. Apply before server rollout.';

-- A generation UUID avoids timestamp-precision races in incident transition CAS.
alter table public.copier_alert_state add column notification_version uuid not null default gen_random_uuid();

-- SQL upsert locks the row and compares against the CURRENT stored value.
-- An older immediate/cron writer cannot lower the cursor. Images do not call this:
-- they can arrive out of order, before earlier events have been durably enqueued.
-- Existing cursors were delivered by the former senders. Keep their boundary
-- silent at cutover; any newer durable event opens inclusive rediscovery.
update public.copier_alert_state set active = true where incident_key = 'state:copy-events';

create function public.advance_copier_notification_cursor(p_user_id uuid, p_device_id uuid, p_at bigint, p_silent_baseline boolean default false)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if p_at < 0 then raise exception 'invalid-copy-event-cursor'; end if;
  insert into public.copier_alert_state (user_id, device_id, incident_key, active, detail, updated_at)
  values (p_user_id, p_device_id, 'state:copy-events', p_silent_baseline, p_at::text, now())
  on conflict (user_id, device_id, incident_key) do update
  set active = case when p_at > case when public.copier_alert_state.detail ~ '^[0-9]{1,18}$'
        then public.copier_alert_state.detail::bigint else 0 end
      then p_silent_baseline else public.copier_alert_state.active end,
      detail = greatest(
      case when public.copier_alert_state.detail ~ '^[0-9]{1,18}$'
        then public.copier_alert_state.detail::bigint else 0 end,
      p_at)::text,
      updated_at = now();
end;
$$;
revoke all on function public.advance_copier_notification_cursor(uuid, uuid, bigint, boolean) from public, anon, authenticated;
grant execute on function public.advance_copier_notification_cursor(uuid, uuid, bigint, boolean) to service_role;

commit;
