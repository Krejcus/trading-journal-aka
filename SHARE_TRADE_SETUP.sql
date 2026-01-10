
-- PŘIDÁNÍ PODPORY PRO SDÍLENÍ OBCHODŮ
-- Spusť tento skript v Supabase SQL Editoru.

-- 1. Přidání sloupce is_public do tabulky trades
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='trades' AND column_name='is_public') THEN
        ALTER TABLE public.trades ADD COLUMN is_public boolean DEFAULT false;
    END IF;
END $$;

-- 2. Povolení čtení veřejných obchodů pro kohokoliv (i nepřihlášené)
DROP POLICY IF EXISTS "Public trades are viewable by anyone" ON public.trades;
CREATE POLICY "Public trades are viewable by anyone" ON public.trades 
    FOR SELECT 
    USING (is_public = true);

-- 3. Ujištění se, že majitel může stále vše
DROP POLICY IF EXISTS "Users can manage their own trades" ON public.trades;
CREATE POLICY "Users can manage their own trades" ON public.trades 
    FOR ALL 
    USING (auth.uid() = user_id);
