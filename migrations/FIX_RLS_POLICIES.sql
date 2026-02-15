-- ROBUST BI-DIRECTIONAL RLS FIX
-- Spusťte tento skript v Supabase SQL Editoru pro opravu viditelnosti dat mezi uživateli.

DO $$ 
BEGIN
    -- 1. TRADES
    DROP POLICY IF EXISTS "Followers can view trades" ON public.trades;
    CREATE POLICY "Followers can view trades" ON public.trades
        FOR SELECT USING (
            EXISTS (
                SELECT 1 FROM connections 
                WHERE status = 'accepted' 
                AND (
                    (sender_id = auth.uid() AND receiver_id = user_id) -- Jsem následovník
                    OR 
                    (receiver_id = auth.uid() AND sender_id = user_id) -- Jsem pozvaný
                )
            )
        );

    -- 2. ACCOUNTS
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

    -- 3. PREPS
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

    -- 4. REVIEWS
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

    -- 5. CONNECTIONS - SELECT
    DROP POLICY IF EXISTS "Users can see their own connections" ON public.connections;
    CREATE POLICY "Users can see their own connections" ON public.connections
        FOR SELECT USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

    -- 6. CONNECTIONS - INSERT (sender can create)
    DROP POLICY IF EXISTS "Users can send follow requests" ON public.connections;
    CREATE POLICY "Users can send follow requests" ON public.connections
        FOR INSERT WITH CHECK (auth.uid() = sender_id);

    -- 7. CONNECTIONS - UPDATE (both sides can update - receiver accepts, sender can mark rejected)
    DROP POLICY IF EXISTS "Users can update their connections" ON public.connections;
    CREATE POLICY "Users can update their connections" ON public.connections
        FOR UPDATE USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

    -- 8. CONNECTIONS - DELETE (both sides can delete)
    DROP POLICY IF EXISTS "Users can delete their connections" ON public.connections;
    CREATE POLICY "Users can delete their connections" ON public.connections
        FOR DELETE USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

END $$;
