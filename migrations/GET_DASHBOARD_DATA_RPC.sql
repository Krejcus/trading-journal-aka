-- Missing indexes on user_id (trades, accounts were doing full table scans!)
CREATE INDEX IF NOT EXISTS idx_trades_user_id ON public.trades (user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON public.accounts (user_id);
CREATE INDEX IF NOT EXISTS idx_trades_user_timestamp ON public.trades (user_id, timestamp DESC);

-- RPC function to fetch all dashboard data in a single call
-- Replaces 7 parallel HTTP requests with 1 server-side query
-- Uses SECURITY DEFINER to bypass RLS (which causes nested subquery evaluation
-- on the connections table for every row). Security is ensured by filtering
-- all queries with auth.uid() which comes from the verified JWT token.

CREATE OR REPLACE FUNCTION get_dashboard_data()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
SET statement_timeout = '30s'
AS $$
DECLARE
  result jsonb;
  v_user_id uuid := auth.uid();
BEGIN
  -- Guard: require authenticated user
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  SELECT jsonb_build_object(
    'user', (
      SELECT jsonb_build_object(
        'id', p.id,
        'email', p.email,
        'full_name', p.full_name,
        'avatar_url', p.avatar_url
      )
      FROM profiles p WHERE p.id = v_user_id
    ),
    'preferences', (
      SELECT p.preferences
      FROM profiles p WHERE p.id = v_user_id
    ),
    'accounts', COALESCE((
      SELECT jsonb_agg(to_jsonb(a))
      FROM accounts a WHERE a.user_id = v_user_id
    ), '[]'::jsonb),
    'trades', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', t.id,
          'user_id', t.user_id,
          'account_id', t.account_id,
          'instrument', t.instrument,
          'pnl', t.pnl,
          'direction', t.direction,
          'date', t.date,
          'timestamp', t.timestamp,
          'is_public', t.is_public,
          'created_at', t.created_at,
          'data', t.data - 'screenshot' - 'screenshots'
        ) ORDER BY t.timestamp DESC
      )
      FROM trades t WHERE t.user_id = v_user_id
    ), '[]'::jsonb),
    'daily_preps', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('id', dp.id, 'date', dp.date, 'data', dp.data)
      )
      FROM daily_preps dp WHERE dp.user_id = v_user_id
    ), '[]'::jsonb),
    'daily_reviews', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('id', dr.id, 'date', dr.date, 'data', dr.data)
      )
      FROM daily_reviews dr WHERE dr.user_id = v_user_id
    ), '[]'::jsonb),
    'weekly_focus', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object('id', wf.id, 'week_iso', wf.week_iso, 'goals', wf.goals)
      )
      FROM weekly_focus wf WHERE wf.user_id = v_user_id
    ), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;

-- Grant access to authenticated users (required for SECURITY DEFINER functions)
GRANT EXECUTE ON FUNCTION get_dashboard_data() TO authenticated;

-- Force PostgREST to reload schema cache (picks up new/changed functions)
NOTIFY pgrst, 'reload schema';
