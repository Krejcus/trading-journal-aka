
-- MASTER SQL SKRIPT PRO KOMPLETNÍ OPRAVU (VŠECHNY OPRAVY V JEDNOM)
-- Tento skript sjednotí tvou databázi se všemi novými funkcemi (profil, sdílení, RLS).
-- Spusť ho v Supabase SQL Editoru.

-- 1. Tabulka PROFILY (přidání chybějících sloupců)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='avatar_url') THEN
        ALTER TABLE public.profiles ADD COLUMN avatar_url text;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='updated_at') THEN
        ALTER TABLE public.profiles ADD COLUMN updated_at timestamp with time zone DEFAULT now();
    END IF;
END $$;

-- 2. Tabulka TRADES (přidání sloupce pro veřejné sdílení)
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trades' AND column_name='is_public') THEN
        ALTER TABLE public.trades ADD COLUMN is_public boolean DEFAULT false;
    END IF;
END $$;

-- 3. ZAPNUTÍ OCHRANY (RLS)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_preps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_reviews ENABLE ROW LEVEL SECURITY;

-- 4. NASTAVENÍ DRAVIDEL (POLICIES)
-- Nejdřív vše vyčistíme, aby se to nehádalo
DO $$ 
BEGIN
    DROP POLICY IF EXISTS "Users can view their own profile" ON profiles;
    DROP POLICY IF EXISTS "Users can update their own profile" ON profiles;
    DROP POLICY IF EXISTS "Users can insert their own profile" ON profiles;
    DROP POLICY IF EXISTS "Users can manage their own accounts" ON accounts;
    DROP POLICY IF EXISTS "Users can manage their own trades" ON trades;
    DROP POLICY IF EXISTS "Public trades are viewable by anyone" ON trades;
    DROP POLICY IF EXISTS "Users can manage their own preps" ON daily_preps;
    DROP POLICY IF EXISTS "Users can manage their own reviews" ON daily_reviews;
END $$;

-- Profily
CREATE POLICY "Users can view their own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update their own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert their own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

-- Účty
CREATE POLICY "Users can manage their own accounts" ON accounts FOR ALL USING (auth.uid() = user_id);

-- Obchody (Majitel může vše, kdokoliv může číst ty označené jako veřejné)
CREATE POLICY "Users can manage their own trades" ON trades FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Public trades are viewable by anyone" ON trades FOR SELECT USING (is_public = true);

-- Deník
CREATE POLICY "Users can manage their own preps" ON daily_preps FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can manage their own reviews" ON daily_reviews FOR ALL USING (auth.uid() = user_id);

GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated, service_role;
