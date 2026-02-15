
-- VYLEPŠENÝ SQL KÓD PRO SUPABASE (IDEMPOTENTNÍ)
-- Tento kód můžeš spustit i vícekrát, pokud dojde k chybě.

-- 1. Tabulka pro profily (jen pokud neexistuje)
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid REFERENCES auth.users ON DELETE CASCADE PRIMARY KEY,
  full_name text,
  preferences jsonb DEFAULT '{"emotions": [], "standardGoals": [], "standardMistakes": [], "dashboardLayout": [], "sessions": [], "htfOptions": [], "ltfOptions": [], "ironRules": [], "instrumentFees": {}}'::jsonb,
  created_at timestamp with time zone DEFAULT now()
);

-- 2. Tabulka pro účty
CREATE TABLE IF NOT EXISTS public.accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  name text NOT NULL,
  initial_balance numeric NOT NULL,
  currency text DEFAULT 'USD',
  type text,
  status text DEFAULT 'Active',
  created_at bigint NOT NULL,
  meta jsonb DEFAULT '{}'::jsonb
);

-- 3. Tabulka pro obchody
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

-- 4. Journal tabulky
CREATE TABLE IF NOT EXISTS public.daily_preps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  date text NOT NULL,
  data jsonb NOT NULL,
  UNIQUE (user_id, date)
);

CREATE TABLE IF NOT EXISTS public.daily_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  date text NOT NULL,
  data jsonb NOT NULL,
  UNIQUE (user_id, date)
);

-- Zapnutí RLS (Row Level Security)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_preps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_reviews ENABLE ROW LEVEL SECURITY;

-- 5. Nastavení politik (bezpečně)
DO $$ 
BEGIN
    DROP POLICY IF EXISTS "Users can view their own profile" ON profiles;
    DROP POLICY IF EXISTS "Users can update their own profile" ON profiles;
    DROP POLICY IF EXISTS "Users can insert their own profile" ON profiles;
    DROP POLICY IF EXISTS "Users can manage their own accounts" ON accounts;
    DROP POLICY IF EXISTS "Users can manage their own trades" ON trades;
    DROP POLICY IF EXISTS "Users can manage their own preps" ON daily_preps;
    DROP POLICY IF EXISTS "Users can manage their own reviews" ON daily_reviews;

    CREATE POLICY "Users can view their own profile" ON profiles FOR SELECT USING (auth.uid() = id);
    CREATE POLICY "Users can update their own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
    CREATE POLICY "Users can insert their own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
    CREATE POLICY "Users can manage their own accounts" ON accounts FOR ALL USING (auth.uid() = user_id);
    CREATE POLICY "Users can manage their own trades" ON trades FOR ALL USING (auth.uid() = user_id);
    CREATE POLICY "Users can manage their own preps" ON daily_preps FOR ALL USING (auth.uid() = user_id);
    CREATE POLICY "Users can manage their own reviews" ON daily_reviews FOR ALL USING (auth.uid() = user_id);
END $$;

-- 6. Trigger pro automatický profil
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (new.id, new.raw_user_meta_data->>'full_name');
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();
