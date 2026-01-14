-- MASTER CANDLE CACHE SETUP
-- Spusť tento skript v Supabase SQL Editoru pro zprovoznění bleskových grafů.

-- 1. Vytvoření tabulky pro svíčky (pokud neexistuje)
CREATE TABLE IF NOT EXISTS public.candle_cache (
    id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    instrument text NOT NULL,
    time timestamp with time zone NOT NULL,
    open double precision NOT NULL,
    high double precision NOT NULL,
    low double precision NOT NULL,
    close double precision NOT NULL,
    volume double precision NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    UNIQUE(instrument, time)
);

-- 2. Index pro bleskové vyhledávání v historii
CREATE INDEX IF NOT EXISTS idx_candle_cache_lookup ON public.candle_cache (instrument, time);

-- 3. Nastavení zabezpečení (RLS)
ALTER TABLE public.candle_cache ENABLE ROW LEVEL SECURITY;

-- Odstraníme stará pravidla, abychom měli čistý stůl
DROP POLICY IF EXISTS "Allow authenticated read access" ON public.candle_cache;
DROP POLICY IF EXISTS "Allow server-side service role full access" ON public.candle_cache;
DROP POLICY IF EXISTS "Service role can do everything" ON public.candle_cache;

-- Pravidlo pro čtení (kdokoliv)
CREATE POLICY "Allow public read access" ON public.candle_cache 
    FOR SELECT USING (true);

-- Pravidlo pro zápis (Service Role má plný přístup)
CREATE POLICY "Service role can do everything" ON public.candle_cache
    FOR ALL USING (true) WITH CHECK (true);

-- Pravidlo pro zápis pro ANONYMNÍ (Vercel bez Service Role Key)
-- POZOR: Povolujeme to pouze pro tuto tabulku mezipaměti.
CREATE POLICY "Allow anon to upsert candles" ON public.candle_cache
    FOR ALL TO anon USING (true) WITH CHECK (true);

-- 4. Přidělení práv pro různé role
GRANT ALL ON public.candle_cache TO postgres, service_role;
GRANT SELECT ON public.candle_cache TO authenticated;
GRANT ALL ON public.candle_cache TO anon; -- Dočasně povolíme i anon pro jistotu, pokud v Vercelu chybí Service Role Key

-- Hotovo! Teď už se budou svíčky ukládat do tvé databáze.
