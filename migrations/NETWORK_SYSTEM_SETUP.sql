
-- NETWORK SYSTEM SETUP
-- Tento skript připraví databázi pro vnitřní systém sledování a pozvánek.

-- 1. Přidání emailu do profilů pro snadnější vyhledávání
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='email') THEN
        ALTER TABLE public.profiles ADD COLUMN email text;
    END IF;
END $$;

-- 2. Aktualizace stávajících profilů (pokud tam email chybí) - toto funguje pokud má skript práva
UPDATE public.profiles p
SET email = u.email
FROM auth.users u
WHERE p.id = u.id AND p.email IS NULL;

-- 3. Úprava triggeru, aby se email ukládal i u nových uživatelů
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email)
  VALUES (new.id, new.raw_user_meta_data->>'full_name', new.email);
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Tabulka pro propojení (Žádosti o sledování)
CREATE TABLE IF NOT EXISTS public.connections (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sender_id uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    receiver_id uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
    status text DEFAULT 'pending', -- 'pending' | 'accepted'
    created_at timestamp with time zone DEFAULT now(),
    UNIQUE (sender_id, receiver_id)
);

-- Zapnutí RLS
ALTER TABLE public.connections ENABLE ROW LEVEL SECURITY;

-- 5. Pravidla (Policies) pro propojení
DO $$ 
BEGIN
    DROP POLICY IF EXISTS "Users can see their own connections" ON public.connections;
    DROP POLICY IF EXISTS "Users can send follow requests" ON public.connections;
    DROP POLICY IF EXISTS "Users can update their own connections" ON public.connections;
    DROP POLICY IF EXISTS "Users can delete their own connections" ON public.connections;

    CREATE POLICY "Users can see their own connections" ON public.connections
        FOR SELECT USING (auth.uid() = sender_id OR auth.uid() = receiver_id);

    CREATE POLICY "Users can send follow requests" ON public.connections
        FOR INSERT WITH CHECK (auth.uid() = sender_id);

    CREATE POLICY "Users can update their own connections" ON public.connections
        FOR UPDATE USING (auth.uid() = receiver_id); -- Přijmout může jen ten, komu to přišlo

    CREATE POLICY "Users can delete their own connections" ON public.connections
        FOR DELETE USING (auth.uid() = sender_id OR auth.uid() = receiver_id);
END $$;

-- 6. Povolení čtení profilů (veřejně pro vyhledávání)
DROP POLICY IF EXISTS "Profiles are searchable by anyone" ON public.profiles;
CREATE POLICY "Profiles are searchable by anyone" ON public.profiles
    FOR SELECT USING (true);

-- 7. SOCIÁLNÍ RLS (Umožňuje sledovaným vidět data)
-- Tato část umožní lidem, které sledujete, vidět vaše data (a opačně).

DO $$ 
BEGIN
    -- TRADES
    DROP POLICY IF EXISTS "Followers can view trades" ON public.trades;
    CREATE POLICY "Followers can view trades" ON public.trades
        FOR SELECT USING (
            EXISTS (
                SELECT 1 FROM connections 
                WHERE status = 'accepted' 
                AND sender_id = auth.uid() 
                AND receiver_id = user_id
            )
        );

    -- ACCOUNTS
    DROP POLICY IF EXISTS "Followers can view accounts" ON public.accounts;
    CREATE POLICY "Followers can view accounts" ON public.accounts
        FOR SELECT USING (
            EXISTS (
                SELECT 1 FROM connections 
                WHERE status = 'accepted' 
                AND sender_id = auth.uid() 
                AND receiver_id = user_id
            )
        );

    -- PREPS
    DROP POLICY IF EXISTS "Followers can view preps" ON public.daily_preps;
    CREATE POLICY "Followers can view preps" ON public.daily_preps
        FOR SELECT USING (
            EXISTS (
                SELECT 1 FROM connections 
                WHERE status = 'accepted' 
                AND sender_id = auth.uid() 
                AND receiver_id = user_id
            )
        );

    -- REVIEWS
    DROP POLICY IF EXISTS "Followers can view reviews" ON public.daily_reviews;
    CREATE POLICY "Followers can view reviews" ON public.daily_reviews
        FOR SELECT USING (
            EXISTS (
                SELECT 1 FROM connections 
                WHERE status = 'accepted' 
                AND sender_id = auth.uid() 
                AND receiver_id = user_id
            )
        );
END $$;
