-- Hot manual commands already publish their display-only result directly to the
-- open LIVE chart. Their durable relay ACK therefore does not need to upload the
-- entire worker status snapshot (~20-25 kB) before the command row can become
-- terminal. Keep the same delivery binding and worker-run fence as v2; the
-- worker sends a full heartbeat immediately after this compact ACK.
-- Additive: without this function the worker falls back to complete_v2.
-- Rollback (after the worker and web are back): drop function
-- public.complete_tradovate_copier_hot_command_v3(uuid, uuid, uuid, jsonb, text, timestamptz);
create function public.complete_tradovate_copier_hot_command_v3(
  target_device_id uuid,
  target_delivery_id uuid,
  target_command_id uuid,
  command_result jsonb,
  command_error text,
  worker_started_at timestamptz
) returns boolean
language plpgsql
security invoker
set search_path = ''
set lock_timeout = '2s'
as $$
declare
  cmd public.tradovate_copier_commands;
  runtime_started_at timestamptz;
  terminal text;
begin
  if target_delivery_id is null
    or target_command_id is null
    or worker_started_at is null
  then
    raise exception 'invalid-hot-command-ack';
  end if;

  select * into cmd
  from public.tradovate_copier_commands
  where id = target_command_id
    and device_id = target_device_id
    and delivery_id = target_delivery_id
  for update;

  if not found then return false; end if;
  terminal := case when command_error is null then 'succeeded' else 'rejected' end;

  -- Lost HTTP responses retry this exact ACK. Never move completed_at or accept
  -- a different result for the same durable delivery.
  if cmd.status in ('succeeded', 'rejected') then
    return cmd.status = terminal
      and cmd.result is not distinct from command_result
      and cmd.error is not distinct from command_error;
  end if;
  if cmd.status <> 'claimed' then return false; end if;
  if cmd.command_type <> 'copy-command'
    or coalesce(cmd.payload #>> '{command,type}', '') not in ('place-leader-entry', 'manage-leader-order')
  then
    return false;
  end if;

  -- Stricter than complete_v2 (exact equality, not started_at >) because this ACK
  -- cannot bring its own snapshot. Any other worker run fails closed here and the
  -- worker falls back to complete_v2 within the same delivery.
  select started_at into runtime_started_at
  from public.tradovate_copier_device_runtime
  where device_id = target_device_id
  for update;

  if not found or runtime_started_at is distinct from worker_started_at then
    return false;
  end if;

  update public.tradovate_copier_commands
  set status = terminal,
      result = command_result,
      error = command_error,
      completed_at = now()
  where id = cmd.id;
  return true;
end;
$$;

revoke all on function public.complete_tradovate_copier_hot_command_v3(
  uuid, uuid, uuid, jsonb, text, timestamptz
) from public, anon, authenticated;
grant execute on function public.complete_tradovate_copier_hot_command_v3(
  uuid, uuid, uuid, jsonb, text, timestamptz
) to service_role;

notify pgrst, 'reload schema';
