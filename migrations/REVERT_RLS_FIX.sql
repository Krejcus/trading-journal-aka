-- REVERT: Restore original follower policies (FIX_SLOW_RLS.sql made it worse)
DO $$
BEGIN
    -- Trades
    DROP POLICY IF EXISTS "Followers can view trades" ON public.trades;
    CREATE POLICY "Followers can view trades" ON public.trades
        FOR SELECT USING (
            EXISTS (
                SELECT 1 FROM connections
                WHERE status = 'accepted'
                AND (
                    (sender_id = auth.uid() AND receiver_id = user_id)
                    OR
                    (receiver_id = auth.uid() AND sender_id = user_id)
                )
            )
        );

    -- Accounts
    DROP POLICY IF EXISTS "Followers can view accounts" ON public.accounts;
    CREATE POLICY "Followers can view accounts" ON public.accounts
        FOR SELECT USING (
            EXISTS (
                SELECT 1 FROM connections
                WHERE status = 'accepted'
                AND (
                    (sender_id = auth.uid() AND receiver_id = user_id)
                    OR
                    (receiver_id = auth.uid() AND sender_id = user_id)
                )
            )
        );

    -- Preps
    DROP POLICY IF EXISTS "Followers can view preps" ON public.daily_preps;
    CREATE POLICY "Followers can view preps" ON public.daily_preps
        FOR SELECT USING (
            EXISTS (
                SELECT 1 FROM connections
                WHERE status = 'accepted'
                AND (
                    (sender_id = auth.uid() AND receiver_id = user_id)
                    OR
                    (receiver_id = auth.uid() AND sender_id = user_id)
                )
            )
        );

    -- Reviews
    DROP POLICY IF EXISTS "Followers can view reviews" ON public.daily_reviews;
    CREATE POLICY "Followers can view reviews" ON public.daily_reviews
        FOR SELECT USING (
            EXISTS (
                SELECT 1 FROM connections
                WHERE status = 'accepted'
                AND (
                    (sender_id = auth.uid() AND receiver_id = user_id)
                    OR
                    (receiver_id = auth.uid() AND sender_id = user_id)
                )
            )
        );
END $$;

NOTIFY pgrst, 'reload schema';
