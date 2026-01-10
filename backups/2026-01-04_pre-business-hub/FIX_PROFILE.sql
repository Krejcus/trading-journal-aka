
-- PŘIDÁNÍ CHYBĚJÍCÍCH SLOUPCŮ PRO PROFIL
-- Spusť tento skript v Supabase SQL Editoru.

-- Přidání sloupců pro fotku a čas aktualizace, pokud tam ještě nejsou
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='avatar_url') THEN
        ALTER TABLE public.profiles ADD COLUMN avatar_url text;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='profiles' AND column_name='updated_at') THEN
        ALTER TABLE public.profiles ADD COLUMN updated_at timestamp with time zone DEFAULT now();
    END IF;
END $$;

-- Ujištění se, že RLS je stále správně nastaveno
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DO $$ 
BEGIN
    DROP POLICY IF EXISTS "Users can update their own profile" ON profiles;
    DROP POLICY IF EXISTS "Users can insert their own profile" ON profiles;
    
    CREATE POLICY "Users can update their own profile" ON profiles FOR UPDATE USING (auth.uid() = id);
    CREATE POLICY "Users can insert their own profile" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);
END $$;
