-- FIX SLOW RLS: The "Followers can view" policies on trades/accounts/preps/reviews
-- run a nested EXISTS subquery on connections for EVERY row, and connections
-- has its own RLS with an OR condition. This causes massive slowdowns.
--
-- Fix 1: Add missing index on connections(receiver_id, sender_id)
-- Fix 2: Add index on connections for status filtering
-- Fix 3: Add missing indexes on trades/accounts user_id
-- Fix 4: Rewrite follower policies to use two EXISTS with AND (index-friendly) instead of OR

-- === INDEXES ===
CREATE INDEX IF NOT EXISTS idx_connections_receiver_sender
  ON public.connections (receiver_id, sender_id) WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS idx_connections_sender_receiver
  ON public.connections (sender_id, receiver_id) WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS idx_trades_user_id ON public.trades (user_id);
CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON public.accounts (user_id);

-- === REWRITE FOLLOWER POLICIES ===
-- Instead of a single EXISTS with OR (which can't use indexes efficiently),
-- use two separate EXISTS with AND conditions (each hits a partial index).

DO $$
BEGIN
    -- 1. TRADES
    DROP POLICY IF EXISTS "Followers can view trades" ON public.trades;
    CREATE POLICY "Followers can view trades" ON public.trades
        FOR SELECT USING (
            auth.uid() = user_id
            OR EXISTS (
                SELECT 1 FROM connections
                WHERE status = 'accepted'
                AND sender_id = auth.uid() AND receiver_id = trades.user_id
            )
            OR EXISTS (
                SELECT 1 FROM connections
                WHERE status = 'accepted'
                AND receiver_id = auth.uid() AND sender_id = trades.user_id
            )
        );

    -- 2. ACCOUNTS
    DROP POLICY IF EXISTS "Followers can view accounts" ON public.accounts;
    CREATE POLICY "Followers can view accounts" ON public.accounts
        FOR SELECT USING (
            auth.uid() = user_id
            OR EXISTS (
                SELECT 1 FROM connections
                WHERE status = 'accepted'
                AND sender_id = auth.uid() AND receiver_id = accounts.user_id
            )
            OR EXISTS (
                SELECT 1 FROM connections
                WHERE status = 'accepted'
                AND receiver_id = auth.uid() AND sender_id = accounts.user_id
            )
        );

    -- 3. PREPS
    DROP POLICY IF EXISTS "Followers can view preps" ON public.daily_preps;
    CREATE POLICY "Followers can view preps" ON public.daily_preps
        FOR SELECT USING (
            auth.uid() = user_id
            OR EXISTS (
                SELECT 1 FROM connections
                WHERE status = 'accepted'
                AND sender_id = auth.uid() AND receiver_id = daily_preps.user_id
            )
            OR EXISTS (
                SELECT 1 FROM connections
                WHERE status = 'accepted'
                AND receiver_id = auth.uid() AND sender_id = daily_preps.user_id
            )
        );

    -- 4. REVIEWS
    DROP POLICY IF EXISTS "Followers can view reviews" ON public.daily_reviews;
    CREATE POLICY "Followers can view reviews" ON public.daily_reviews
        FOR SELECT USING (
            auth.uid() = user_id
            OR EXISTS (
                SELECT 1 FROM connections
                WHERE status = 'accepted'
                AND sender_id = auth.uid() AND receiver_id = daily_reviews.user_id
            )
            OR EXISTS (
                SELECT 1 FROM connections
                WHERE status = 'accepted'
                AND receiver_id = auth.uid() AND sender_id = daily_reviews.user_id
            )
        );
END $$;

NOTIFY pgrst, 'reload schema';
