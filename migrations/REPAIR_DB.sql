
-- TENTO SKRIPT OPRAVÍ OPRÁVNĚNÍ V DATABÁZI
-- Zkopíruj ho celý a spusť v Supabase SQL Editoru.

-- 1. Ujištění, že tabulky existují
CREATE TABLE IF NOT EXISTS public.trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  account_id uuid REFERENCES public.accounts ON DELETE CASCADE NOT NULL,
  instrument text,
  signal text,
  pnl numeric NOT NULL,
  direction text,
  date text NOT NULL,
  timestamp bigint NOT NULL,
  data jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);

-- 2. Oprava oprávnění (RLS Policies)
-- Nejdřív smažeme staré (aby nedocházelo k chybám 'policy already exists') a pak vytvoříme nové.

DO $$ 
BEGIN
    -- Smazání profilů policies
    DROP POLICY IF EXISTS "Users can view their own profile" ON profiles;
    DROP POLICY IF EXISTS "Users can update their own profile" ON profiles;
    DROP POLICY IF EXISTS "Users can insert their own profile" ON profiles;
    
    -- Smazání účtů policies
    DROP POLICY IF EXISTS "Users can manage their own accounts" ON accounts;
    
    -- Smazání obchodů policies (TOHLE JE KRITICKÉ PRO UKLÁDÁNÍ)
    DROP POLICY IF EXISTS "Users can manage their own trades" ON trades;
    
    -- Smazání deníku policies
    DROP POLICY IF EXISTS "Users can manage their own preps" ON daily_preps;
    DROP POLICY IF EXISTS "Users can manage their own reviews" ON daily_reviews;
END $$;

-- 3. Zapnutí ochrany (RLS)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_preps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_reviews ENABLE ROW LEVEL SECURITY;

-- 4. Vytvoření nových pravidel (povolí čtení i zápis vlastníkovi dat)
CREATE POLICY "Users can view their own profile" ON profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update their own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert their own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can manage their own accounts" ON accounts FOR ALL USING (auth.uid() = user_id);

-- TOTO PRAVIDLO POVOLUJE UKLÁDÁNÍ OBCHODŮ
CREATE POLICY "Users can manage their own trades" ON trades FOR ALL USING (auth.uid() = user_id);

CREATE POLICY "Users can manage their own preps" ON daily_preps FOR ALL USING (auth.uid() = user_id);
CREATE POLICY "Users can manage their own reviews" ON daily_reviews FOR ALL USING (auth.uid() = user_id);

