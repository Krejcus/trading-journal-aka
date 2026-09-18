-- 18. 9. 2026: get_dashboard_data returned 12.7 MB in 6 s for 3 720 trades;
-- a phone coming back from the background could not finish the refresh in
-- 20 s and kept showing the offline banner. Per-trade analytics blobs
-- (counterfactual, entryContext, excursion, aiSuggestions, executionPath,
-- entryMap, visionAnalysis) are 56 % of the trade data and are needed only
-- by the trade detail (which already reads the full row) and by Lab / the
-- AI coach, which now fetch them separately.

create or replace function public.get_dashboard_data_without_trade_notes_light_v1()
returns jsonb language plpgsql security definer set search_path to 'public', 'auth' set statement_timeout to '30s' as $$
declare result jsonb; v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'Not authenticated'; end if;
  select jsonb_build_object(
    -- An inline avatar above 256 kB (a raw phone photo is 3,7 MB of base64) is
    -- fetched after the first paint instead of travelling with every read.
    'user', (select jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name,
        'avatar_url', case when length(p.avatar_url) > 262144 then null else p.avatar_url end,
        'avatar_deferred', coalesce(length(p.avatar_url) > 262144, false), 'role', p.role)
      from profiles p where p.id = v_user_id),
    'preferences', (select p.preferences from profiles p where p.id = v_user_id),
    'accounts', coalesce((select jsonb_agg(to_jsonb(a)) from accounts a where a.user_id = v_user_id), '[]'::jsonb),
    'trades', coalesce((select jsonb_agg(jsonb_build_object(
        'id', t.id, 'user_id', t.user_id, 'account_id', t.account_id, 'instrument', t.instrument, 'pnl', t.pnl,
        'direction', t.direction, 'date', t.date, 'timestamp', t.timestamp, 'is_public', t.is_public, 'created_at', t.created_at,
        'data', t.data - 'screenshot' - 'screenshots'
          - 'counterfactual' - 'entryContext' - 'excursion' - 'aiSuggestions' - 'executionPath' - 'entryMap' - 'visionAnalysis',
        'analytics_deferred', true,
        'screenshot_url', t.data->>'screenshot', 'screenshots_urls', t.data->'screenshots'
      ) order by t.timestamp desc) from trades t where t.user_id = v_user_id), '[]'::jsonb),
    'daily_preps', coalesce((select jsonb_agg(jsonb_build_object('id', dp.id, 'date', dp.date, 'data', dp.data)) from daily_preps dp where dp.user_id = v_user_id), '[]'::jsonb),
    'daily_reviews', coalesce((select jsonb_agg(jsonb_build_object('id', dr.id, 'date', dr.date, 'data', dr.data)) from daily_reviews dr where dr.user_id = v_user_id), '[]'::jsonb),
    'weekly_focus', coalesce((select jsonb_agg(jsonb_build_object('id', wf.id, 'week_iso', wf.week_iso, 'goals', wf.goals)) from weekly_focus wf where wf.user_id = v_user_id), '[]'::jsonb)
  ) into result;
  return result;
end; $$;
-- Same grants as get_dashboard_data_without_trade_notes_v1: the invoker wrapper calls it as the signed-in user.
revoke all on function public.get_dashboard_data_without_trade_notes_light_v1() from public, anon;
grant execute on function public.get_dashboard_data_without_trade_notes_light_v1() to authenticated;

create or replace function public.get_dashboard_data_light_v1()
returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb; projected jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  result := public.get_dashboard_data_without_trade_notes_light_v1();
  select coalesce(jsonb_agg(jsonb_set(e.value,'{data}',
    public.strip_trade_private_note_fields_v1(coalesce(e.value->'data','{}'::jsonb)) || public.trade_note_fields_v1(n.notes)
  ) order by e.ord),'[]'::jsonb) into projected
  from jsonb_array_elements(coalesce(result->'trades','[]'::jsonb)) with ordinality e(value,ord)
  left join public.trade_private_notes n on n.trade_id::text=e.value->>'id' and n.user_id=auth.uid();
  return jsonb_set(result,'{trades}',projected);
end; $$;
revoke all on function public.get_dashboard_data_light_v1() from public, anon;
grant execute on function public.get_dashboard_data_light_v1() to authenticated;

-- Deferred analytics for the caller's own trades (RLS applies; invoker).
create or replace function public.get_trade_analytics_v1(p_trade_ids uuid[] default null)
returns jsonb language sql security invoker set search_path='' stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', t.id,
    'counterfactual', t.data->'counterfactual', 'entryContext', t.data->'entryContext', 'excursion', t.data->'excursion',
    'aiSuggestions', t.data->'aiSuggestions', 'executionPath', t.data->'executionPath', 'entryMap', t.data->'entryMap',
    'visionAnalysis', t.data->'visionAnalysis'
  )), '[]'::jsonb)
  from public.trades t
  where t.user_id = auth.uid() and (p_trade_ids is null or t.id = any(p_trade_ids))
    and (t.data ? 'counterfactual' or t.data ? 'entryContext' or t.data ? 'excursion' or t.data ? 'aiSuggestions'
      or t.data ? 'executionPath' or t.data ? 'entryMap' or t.data ? 'visionAnalysis');
$$;
revoke all on function public.get_trade_analytics_v1(uuid[]) from public, anon;
grant execute on function public.get_trade_analytics_v1(uuid[]) to authenticated;
